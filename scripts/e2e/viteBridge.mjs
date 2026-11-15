import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { cp, mkdir, realpath, rm } from 'node:fs/promises';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { isolatedEnvironment } from './environment.mjs';

const METHODS = new Set([
  'repository_open', 'repository_close', 'repository_state', 'repository_snapshot', 'repository_status',
  'repository_operation_state', 'repository_branch_relation', 'repository_history', 'repository_commit',
  'repository_commit_edit_eligibility', 'repository_commit_graph_status',
  'repository_sync_info', 'repository_worktrees',
  'repository_diff_files', 'repository_diff', 'repository_stage',
  'repository_unstage', 'repository_discard', 'repository_stage_hunk',
  'repository_unstage_hunk', 'repository_create_commit', 'repository_watch',
  'repository_conflict_file', 'repository_resolve_conflict',
  'repository_search', 'repository_cancel_search', 'repository_run_operation',
  'repository_worktree_review', 'repository_worktree_execute',
  'repository_remotes', 'repository_remote_action',
  'repository_clone', 'repository_cancel_clone',
]);
const MAX_BODY = 128 * 1024;
const MAX_PENDING = 8;
const MAX_FIXTURES = 8;
const MAX_EVENT_CLIENTS = 8;
const MAX_EVENT_QUEUE = 128;
const COMMAND_TIMEOUT = 10_000;
const CLONE_TIMEOUT = 120_000;
const CLONE_RESULT_TTL = 60_000;
const MAX_ACTIVE_CLONES = 4;
const TRACKED_REQUEST_DONE = Symbol('tracked-request-done');
const execFile = promisify(execFileCb);

function send(res, status, body) {
  res[TRACKED_REQUEST_DONE]?.();
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(bytes);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on('data', chunk => {
      length += chunk.length;
      if (length > MAX_BODY) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { reject(Object.assign(new Error('Request body is not valid UTF-8'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function hasBearer(req, secret) {
  const header = req.headers.authorization ?? '';
  const supplied = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function within(root, candidate) {
  if (process.platform === 'win32') {
    const normalize = value => value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/i, '');
    root = normalize(root);
    candidate = normalize(candidate);
  }
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function samePath(a, b) { return within(a, b) && within(b, a); }

function validRepoPath(value) {
  return typeof value === 'string' && !!value && !value.includes('\0') &&
    !value.includes('\\') && !value.startsWith('/') &&
    !value.split('/').some(part => part === '..' || part === '');
}

async function localRemotesOnly(root, remotesRoot, registered) {
  const env = isolatedEnvironment(process.env, {
    HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM, GIT_CONFIG_NOSYSTEM: '1',
  });
  const config = async pattern => {
    try {
      return (await execFile('git', ['-C', root, 'config', '--includes', '--show-origin', '--get-regexp', pattern], {
        env, timeout: COMMAND_TIMEOUT, maxBuffer: 64 * 1024,
      })).stdout;
    } catch (error) {
      if (error.code === 1) return '';
      throw error;
    }
  };
  if (await config('^remote\\..*\\.(uploadpack|receivepack|vcs|proxy)$') ||
    await config('^url\\..*\\.(insteadof|pushinsteadof)$')) return false;
  const names = await execFile('git', ['-C', root, 'remote'], { env, timeout: COMMAND_TIMEOUT, maxBuffer: 64 * 1024 });
  for (const name of names.stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      const urls = await execFile('git', ['-C', root, 'remote', 'get-url', '--all', name], { env, timeout: COMMAND_TIMEOUT, maxBuffer: 64 * 1024 });
      const pushUrls = await execFile('git', ['-C', root, 'remote', 'get-url', '--push', '--all', name], { env, timeout: COMMAND_TIMEOUT, maxBuffer: 64 * 1024 });
      for (const value of [...urls.stdout, ...pushUrls.stdout].join('').split(/\r?\n/).filter(Boolean)) {
        if (!path.isAbsolute(value)) return false;
        const canonical = await realpath(value);
        if (!within(remotesRoot, canonical) || !samePath(canonical, value) || !registered.has(canonical)) return false;
        const { stdout } = await execFile('git', ['-C', canonical, 'rev-parse', '--is-bare-repository'], { env, timeout: COMMAND_TIMEOUT, maxBuffer: 1024 });
        if (stdout.trim() !== 'true') return false;
      }
    } catch { return false; }
  }
  return true;
}

export function gittyTestBridge() {
  let child;
  let childReady;
  let bridgeError;
  let nextId = 1;
  const pending = new Map();
  const handles = new Map();
  const fixtures = new Map();
  const fixtureTokens = new Map();
  const releasingFixtures = new Set();
  const activeRequests = new Map();
  const worktrees = new Map();
  const commonDirs = new Map();
  const remotes = new Map();
  const eventClients = new Set();
  const cloneOperations = new Map();
  let fixtureTemplate;
  let harnessRoot;
  let creatingFixtures = 0;
  let secret;
  let expectedHost;
  let expectedOrigin;
  let stderrTail = '';
  let logger;

  function diagnosticTail() {
    let output = secret ? stderrTail.replaceAll(secret, '[redacted]') : stderrTail;
    for (const token of fixtureTokens.values()) output = output.replaceAll(token, '[redacted]');
    return output
      .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
      .slice(-8192);
  }

  function trackFixtureRequest(fixtureId, res) {
    if (releasingFixtures.has(fixtureId)) {
      send(res, 410, { error: { code: 'fixtureReleasing', message: 'Fixture is being released' } });
      return false;
    }
    activeRequests.set(fixtureId, (activeRequests.get(fixtureId) ?? 0) + 1);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const active = (activeRequests.get(fixtureId) ?? 1) - 1;
      activeRequests.set(fixtureId, active);
      if (!active) for (const wake of waiters.get(fixtureId) ?? []) wake();
    };
    res[TRACKED_REQUEST_DONE] = finish;
    res.once('finish', finish);
    return true;
  }

  const waiters = new Map();
  const fixtureBusy = fixtureId => (activeRequests.get(fixtureId) ?? 0) > 0 ||
    [...cloneOperations.values()].some(operation => operation.fixtureId === fixtureId && operation.active);
  function finishClone(operationId) {
    const operation = cloneOperations.get(operationId);
    if (!operation || !operation.active) return;
    operation.active = false;
    operation.timer = setTimeout(() => cloneOperations.delete(operationId), CLONE_RESULT_TTL);
    operation.timer.unref?.();
    if (!fixtureBusy(operation.fixtureId)) for (const wake of waiters.get(operation.fixtureId) ?? []) wake();
  }

  function waitForFixtureRequests(fixtureId) {
    if (!fixtureBusy(fixtureId)) return Promise.resolve(true);
    return new Promise(resolve => {
      let timer;
      const finish = ready => {
        clearTimeout(timer);
        const list = waiters.get(fixtureId);
        list?.delete(wake);
        if (!list?.size) waiters.delete(fixtureId);
        resolve(ready);
      };
      const wake = () => { if (!fixtureBusy(fixtureId)) finish(true); };
      const list = waiters.get(fixtureId) ?? new Set();
      list.add(wake);
      waiters.set(fixtureId, list);
      timer = setTimeout(() => finish(false), COMMAND_TIMEOUT);
    });
  }

  function startChild() {
    child = spawn(process.env.GITTY_CLI_BIN, ['serve', '--stdio'], {
      cwd: fixtureTemplate,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: isolatedEnvironment(process.env, {
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
        GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
        GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
      }),
    });
    childReady = new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      if (line.length > 16 * 1024 * 1024) {
        bridgeError = new Error('CLI response exceeded bridge limit');
        child.kill();
        return;
      }
      let message;
      try { message = JSON.parse(line); } catch {
        bridgeError = new Error('CLI emitted invalid protocol JSON');
        child.kill();
        return;
      }
      if (message.eventId !== undefined) {
        publishEvent(message);
        return;
      }
      const pendingRequest = pending.get(message.id);
      if (!pendingRequest) return;
      pending.delete(message.id);
      pendingRequest.resolve(message);
    });
    child.stderr.on('data', chunk => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-8192);
    });
    child.once('exit', (code, signal) => {
      const diagnostics = diagnosticTail();
      bridgeError ??= new Error(`CLI exited (${code ?? signal})`);
      if (logger && diagnostics.trim()) {
        logger.error(`Gitty E2E backend stderr (last 8 KiB):\n${diagnostics}`);
      }
      for (const request of pending.values()) request.reject(bridgeError);
      pending.clear();
    });
  }

  async function call(command, args, { timeout = COMMAND_TIMEOUT, retainOnTimeout = false, onStarted, onComplete } = {}) {
    await childReady;
    if (bridgeError) throw bridgeError;
    if (pending.size >= MAX_PENDING) throw Object.assign(new Error('Too many pending requests'), { status: 429 });
    const id = nextId++;
    let timedOut = false;
    let completed = false;
    let resolveResponse;
    let rejectResponse;
    const complete = () => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      onComplete?.();
    };
    const timer = setTimeout(() => {
      const error = Object.assign(new Error('Backend request timed out'), { status: 504 });
      if (retainOnTimeout) {
        timedOut = true;
        rejectResponse(error);
      } else {
        pending.delete(id);
        complete();
        rejectResponse(error);
      }
    }, timeout);
    const response = new Promise((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
      pending.set(id, {
        resolve: value => { complete(); if (!timedOut) resolve(value); },
        reject: error => { complete(); if (!timedOut) reject(error); },
      });
    });
    onStarted?.();
    if (!child.stdin.write(`${JSON.stringify({ version: 1, id, method: command, params: args })}\n`)) {
      await new Promise(resolve => child.stdin.once('drain', resolve));
    }
    const message = await response;
    if (message.error) return { error: message.error };
    return { result: message.result };
  }

  function publishEvent(frame) {
    if (frame.version !== 1 || !Number.isSafeInteger(frame.eventId) ||
      typeof frame.event?.kind !== 'string' || !frame.event.data || typeof frame.event.data !== 'object') return;
    let targets = [];
    if (frame.event.kind === 'repository_changed') {
      const repository = handles.get(frame.event.data.handle);
      targets = [...eventClients].filter(client => repository && repository.owner === client.root &&
        worktrees.get(client.root)?.has(repository.root));
    } else if (frame.event.kind === 'repository_clone') {
      const operation = cloneOperations.get(frame.event.data.operationId);
      if (operation) targets = [...eventClients].filter(client => client.root === operation.root);
    } else if (frame.event.kind === 'git_command' && fixtures.size === 1) {
      const [root] = fixtures.values();
      targets = [...eventClients].filter(client => client.root === root);
    } else if (frame.event.kind === 'events_dropped') {
      targets = [...eventClients];
    }
    // GitLog has no repository handle; suppress it if multiple fixtures exist.
    for (const client of targets) {
      if (client.queue.length >= MAX_EVENT_QUEUE) {
        client.queue.shift();
        client.dropped++;
      }
      client.queue.push(frame);
      drainEvents(client);
    }
  }

  function drainEvents(client) {
    if (client.closed || client.blocked) return;
    while (client.queue.length) {
      if (client.dropped) {
        const dropped = client.dropped;
        client.dropped = 0;
        if (!client.res.write(`${JSON.stringify({
          version: 1,
          eventId: client.queue[0].eventId,
          event: { kind: 'events_dropped', data: { count: dropped } },
        })}\n`)) {
          client.blocked = true;
          client.res.once('drain', () => { client.blocked = false; drainEvents(client); });
          return;
        }
      }
      const frame = client.queue.shift();
      if (!client.res.write(`${JSON.stringify(frame)}\n`)) {
        client.blocked = true;
        client.res.once('drain', () => { client.blocked = false; drainEvents(client); });
      }
      if (client.blocked) return;
    }
  }

  return {
    name: 'gitty-real-git-test-bridge',
    apply: 'serve',
    async configureServer(server) {
      if (!process.env.GITTY_E2E || process.env.GITTY_E2E !== '1') return;
      fixtureTemplate = await realpath(process.env.GITTY_TEST_ROOT);
      harnessRoot = await realpath(path.dirname(fixtureTemplate));
      const common = await realpath(path.join(fixtureTemplate, '.git'));
      if (!within(fixtureTemplate, common)) throw new Error('Fixture Git directory escapes fixture root');
      if (!process.env.GITTY_CLI_BIN) throw new Error('GITTY_CLI_BIN is required for E2E mode');
      secret = process.env.GITTY_TEST_TOKEN;
      if (!secret || secret.length < 32) throw new Error('A per-run bridge secret is required');
      expectedHost = `127.0.0.1:${process.env.GITTY_TEST_PORT}`;
      expectedOrigin = `http://${expectedHost}`;
      logger = server.config.logger;
      startChild();

      server.middlewares.use(async (req, res, next) => {
        const pathname = new URL(req.url ?? '/', expectedOrigin).pathname;
        if (!pathname.startsWith('/__gitty_test/')) return next();
        const sameOriginGet = req.method === 'GET' && !req.headers.origin && req.headers['sec-fetch-site'] === 'same-origin';
        if (req.headers.host !== expectedHost || (req.headers.origin !== expectedOrigin && !sameOriginGet)) {
          return send(res, 403, { error: { code: 'forbiddenOrigin', message: 'Host or Origin rejected' } });
        }
        if (pathname === '/__gitty_test/session' && req.method === 'POST') {
          let sandbox;
          let fixtureId;
          try {
          const body = await readBody(req);
          if (body !== '{}' && body !== '') return send(res, 400, { error: { code: 'invalidRequest', message: 'Expected an empty object' } });
          if (fixtures.size + creatingFixtures >= MAX_FIXTURES) return send(res, 429, { error: { code: 'fixtureLimit', message: 'Fixture limit reached' } });
          creatingFixtures++;
          fixtureId = randomUUID();
          const fixtureToken = createHmac('sha256', secret).update(fixtureId).digest('hex');
          sandbox = path.join(harnessRoot, `fixture-${fixtureId}`);
          const repoPath = path.join(sandbox, 'repo');
          await cp(fixtureTemplate, repoPath, { recursive: true, errorOnExist: true, force: false });
          await Promise.all([mkdir(path.join(sandbox, 'worktrees')), mkdir(path.join(sandbox, 'remotes')), mkdir(path.join(sandbox, 'clones'))]);
          const registeredRoot = await realpath(repoPath);
          if (!within(sandbox, registeredRoot)) throw new Error('Fixture escaped harness sandbox');
          const { stdout: commonOutput } = await execFile('git', ['-C', registeredRoot, 'rev-parse', '--git-common-dir'], {
            env: isolatedEnvironment(process.env, { GIT_CONFIG_NOSYSTEM: '1' }),
            timeout: COMMAND_TIMEOUT,
            maxBuffer: 4096,
          });
          const fixtureCommonDir = await realpath(path.resolve(registeredRoot, commonOutput.trim()));
          if (!within(registeredRoot, fixtureCommonDir)) throw new Error('Fixture common directory escapes repository root');
          fixtures.set(fixtureId, registeredRoot);
          fixtureTokens.set(fixtureId, fixtureToken);
          worktrees.set(registeredRoot, new Set([registeredRoot]));
          commonDirs.set(registeredRoot, new Map([[registeredRoot, fixtureCommonDir]]));
          remotes.set(registeredRoot, new Set());
          const { stdout: initialHead } = await execFile('git', ['-C', registeredRoot, 'rev-parse', 'HEAD'], {
            timeout: COMMAND_TIMEOUT,
            maxBuffer: 64 * 1024,
            env: isolatedEnvironment(process.env, {
              HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
              XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
              GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
              GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM, GIT_CONFIG_NOSYSTEM: '1',
            }),
          });
          creatingFixtures--;
          return send(res, 200, {
            token: fixtureToken, fixtureId, initialHead: initialHead.trim(),
            location: { kind: 'native', path: registeredRoot },
            cloneParent: path.join(sandbox, 'clones'),
          });
          } catch (error) {
            creatingFixtures = Math.max(0, creatingFixtures - 1);
            if (fixtureId) {
              const failedRoot = fixtures.get(fixtureId);
              fixtures.delete(fixtureId);
              fixtureTokens.delete(fixtureId);
              if (failedRoot) {
                worktrees.delete(failedRoot);
                commonDirs.delete(failedRoot);
                remotes.delete(failedRoot);
              }
            }
            if (sandbox) await rm(sandbox, { recursive: true, force: true }).catch(() => {});
            return send(res, error.status ?? 400, { error: { code: 'invalidRequest', message: error.message } });
          }
        }
        if (pathname === '/__gitty_test/session/release' && req.method === 'POST') {
          let fixtureId;
          try {
            const body = JSON.parse(await readBody(req));
            fixtureId = body?.fixtureId;
            const token = fixtureTokens.get(fixtureId);
            if (!token || !hasBearer(req, token)) return send(res, 401, { error: { code: 'unauthorized', message: 'Bridge authentication required' } });
            const root = fixtures.get(fixtureId);
            if (!root) return send(res, 404, { error: { code: 'unknownFixture', message: 'Fixture is not registered' } });
            if (releasingFixtures.has(body.fixtureId)) return send(res, 409, { error: { code: 'fixtureReleasing', message: 'Fixture release is already in progress' } });
            releasingFixtures.add(body.fixtureId);
            for (const [operationId, operation] of cloneOperations) {
              if (operation.fixtureId === body.fixtureId && operation.active && operation.started) {
                await call('repository_cancel_clone', { operationId }).catch(() => {});
              }
            }
            if (!await waitForFixtureRequests(body.fixtureId)) {
              releasingFixtures.delete(body.fixtureId);
              logger.warn(`Fixture release timed out: requests=${activeRequests.get(body.fixtureId) ?? 0}, clones=${[...cloneOperations.values()].filter(operation => operation.fixtureId === body.fixtureId && operation.active).length}`);
              return send(res, 503, { error: { code: 'fixtureBusy', message: 'Timed out waiting for fixture requests to finish' } });
            }
            const sandbox = path.dirname(root);
            const canonicalSandbox = await realpath(sandbox);
            if (!within(harnessRoot, canonicalSandbox) || !samePath(sandbox, canonicalSandbox) ||
              path.basename(sandbox) !== `fixture-${body.fixtureId}`) {
              releasingFixtures.delete(body.fixtureId);
              return send(res, 403, { error: { code: 'fixtureBoundary', message: 'Fixture cleanup path is not canonical' } });
            }
            for (const [handle, repository] of handles) {
              if (repository.owner === root) {
                const closed = await call('repository_close', { handle });
                if (closed.error) throw new Error(closed.error.message ?? 'Could not close fixture repository');
                handles.delete(handle);
              }
            }
            for (const client of [...eventClients]) {
              if (client.root === root) {
                client.closed = true;
                client.res.end();
                eventClients.delete(client);
              }
            }
            await rm(canonicalSandbox, { recursive: true, force: true });
            stderrTail = stderrTail.replaceAll(fixtureTokens.get(body.fixtureId), '[redacted]');
            fixtures.delete(body.fixtureId);
            fixtureTokens.delete(body.fixtureId);
            worktrees.delete(root);
            commonDirs.delete(root);
            remotes.delete(root);
            for (const [operationId, operation] of cloneOperations) {
              if (operation.fixtureId === body.fixtureId) {
                clearTimeout(operation.timer);
                cloneOperations.delete(operationId);
              }
            }
            activeRequests.delete(body.fixtureId);
            releasingFixtures.delete(body.fixtureId);
            return send(res, 200, { released: true });
          } catch (error) {
            if (typeof fixtureId === 'string') releasingFixtures.delete(fixtureId);
            return send(res, error.status ?? 503, { error: { code: 'fixtureReleaseFailed', message: error.message ?? 'Could not release fixture' } });
          }
        }
        if (pathname === '/__gitty_test/events' && req.method === 'GET') {
          const fixtureId = new URL(req.url ?? '/', expectedOrigin).searchParams.get('fixtureId');
          const token = fixtureTokens.get(fixtureId);
          if (!token || !hasBearer(req, token)) return send(res, 401, { error: { code: 'unauthorized', message: 'Bridge authentication required' } });
          const root = fixtures.get(fixtureId);
          if (!root) return send(res, 404, { error: { code: 'unknownFixture', message: 'Fixture is not registered' } });
          if (releasingFixtures.has(fixtureId)) return send(res, 410, { error: { code: 'fixtureReleasing', message: 'Fixture is being released' } });
          if (eventClients.size >= MAX_EVENT_CLIENTS) return send(res, 429, { error: { code: 'eventLimit', message: 'Event connection limit reached' } });
          res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
          res.flushHeaders();
          const client = { root, res, queue: [], dropped: 0, blocked: false, closed: false };
          eventClients.add(client);
          res.on('close', () => { client.closed = true; eventClients.delete(client); });
          return;
        }
        if (pathname === '/__gitty_test/remote' && req.method === 'POST') {
          try {
            const body = JSON.parse(await readBody(req));
            if (!body || typeof body.fixtureId !== 'string' ||
              typeof body.name !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(body.name)) {
              return send(res, 400, { error: { code: 'invalidRequest', message: 'Fixture ID and safe remote name required' } });
            }
            const token = fixtureTokens.get(body.fixtureId);
            if (!token || !hasBearer(req, token)) return send(res, 401, { error: { code: 'unauthorized', message: 'Bridge authentication required' } });
            if (!trackFixtureRequest(body.fixtureId, res)) return;
            const root = fixtures.get(body.fixtureId);
            const remotePath = path.join(path.dirname(root), 'remotes', `${body.name}.git`);
            await execFile('git', ['init', '--bare', remotePath], { env: isolatedEnvironment(process.env, { GIT_CONFIG_NOSYSTEM: '1' }), timeout: COMMAND_TIMEOUT, maxBuffer: 64 * 1024 });
            remotes.get(root).add(await realpath(remotePath));
            return send(res, 200, { path: remotePath });
          } catch (error) {
            return send(res, error.status ?? 400, { error: { code: 'invalidRequest', message: error.message } });
          }
        }
        if (pathname !== '/__gitty_test/invoke' || req.method !== 'POST') {
          return send(res, 404, { error: { code: 'notFound', message: 'Unknown test bridge endpoint' } });
        }
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch (error) {
          return send(res, error.status ?? 400, { error: { code: 'invalidRequest', message: error.message } });
        }
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).some(key => !['command', 'args'].includes(key)) ||
          typeof body.command !== 'string' || !body.args || typeof body.args !== 'object' || Array.isArray(body.args)) {
          return send(res, 400, { error: { code: 'invalidRequest', message: 'Expected command and args object' } });
        }
        if (!METHODS.has(body.command)) return send(res, 403, { error: { code: 'unsupportedOperation', message: 'Method is not enabled in the fixture profile' } });
        const args = body.args;
        const fixtureId = args.fixtureId;
        const registeredRoot = fixtures.get(fixtureId);
        if (!registeredRoot || !hasBearer(req, fixtureTokens.get(fixtureId))) {
          return send(res, 401, { error: { code: 'unauthorized', message: 'Fixture authentication required' } });
        }
        if (!trackFixtureRequest(fixtureId, res)) return;
        let cloneDestination;
        if (body.command === 'repository_clone') {
          const request = args.request;
          const operationId = args.operationId;
          const cloneRoot = path.join(path.dirname(registeredRoot), 'clones');
          let reservingDestination;
          if (Object.keys(args).some(key => !['fixtureId', 'operationId', 'request'].includes(key)) ||
            typeof operationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(operationId) ||
            cloneOperations.has(operationId) ||
            [...cloneOperations.values()].filter(operation => operation.active).length >= MAX_ACTIVE_CLONES ||
            !request || typeof request !== 'object' || Array.isArray(request) ||
            Object.keys(request).some(key => !['source', 'parent', 'directoryName'].includes(key)) ||
            !path.isAbsolute(request.source ?? '') ||
            !request.parent || request.parent.kind !== 'native' ||
            Object.keys(request.parent).some(key => !['kind', 'path'].includes(key)) ||
            !samePath(request.parent.path ?? '', cloneRoot) ||
            typeof request.directoryName !== 'string' ||
            !/^[a-zA-Z0-9._-]{1,80}$/.test(request.directoryName) ||
            request.directoryName === '.' || request.directoryName === '..') {
            return send(res, 403, { error: { code: 'fixtureBoundary', message: 'Clone must use a registered local bare remote and fixture clone directory' } });
          }
          try {
            cloneDestination = path.join(cloneRoot, request.directoryName);
            if ([...cloneOperations.values()].some(operation => operation.destination &&
              samePath(operation.destination, cloneDestination))) throw new Error();
            reservingDestination = cloneDestination;
            const reservation = { fixtureId, root: registeredRoot, destination: cloneDestination, active: true, validating: true };
            cloneOperations.set(operationId, reservation);
            const source = await realpath(request.source);
            const registered = remotes.get(registeredRoot);
            if (!samePath(source, request.source) || !registered?.has(source) ||
              !within(path.join(path.dirname(registeredRoot), 'remotes'), source)) throw new Error();
            const env = isolatedEnvironment(process.env, { GIT_CONFIG_NOSYSTEM: '1' });
            const bare = await execFile('git', ['-C', source, 'rev-parse', '--is-bare-repository'], { env, timeout: COMMAND_TIMEOUT, maxBuffer: 1024 });
            if (bare.stdout.trim() !== 'true') throw new Error();
            if (await realpath(cloneDestination).catch(() => '')) throw new Error();
            reservation.validating = false;
          } catch {
            if (reservingDestination) cloneOperations.delete(operationId);
            return send(res, 403, { error: { code: 'fixtureBoundary', message: 'Clone source is not a registered canonical bare remote' } });
          }
        } else if (body.command === 'repository_cancel_clone') {
          const operation = cloneOperations.get(args.operationId);
          if (Object.keys(args).some(key => !['fixtureId', 'operationId'].includes(key)) ||
            !operation || operation.fixtureId !== fixtureId || !operation.active) {
            return send(res, 403, { error: { code: 'fixtureBoundary', message: 'Clone operation is not active in this fixture' } });
          }
        } else if (body.command === 'repository_open') {
          if (Object.keys(args).some(key => key !== 'location' && key !== 'fixtureId') ||
            !args.location || Object.keys(args.location).some(key => !['kind', 'path'].includes(key)) ||
            args.location.kind !== 'native' || typeof args.fixtureId !== 'string' ||
            typeof args.location.path !== 'string' ||
            ![...(commonDirs.get(registeredRoot)?.keys() ?? [])].some(root => samePath(root, path.resolve(args.location.path)))) {
            return send(res, 403, { error: { code: 'fixtureBoundary', message: 'Only a fixture or its registered worktree may be opened' } });
          }
          try {
            const canonical = await realpath(args.location.path);
            if (!samePath(canonical, path.resolve(args.location.path)) ||
              ![...(commonDirs.get(registeredRoot)?.keys() ?? [])].some(root => samePath(root, canonical))) throw new Error();
          } catch {
            return send(res, 403, { error: { code: 'fixtureBoundary', message: 'Fixture path is not canonical' } });
          }
        } else if (typeof args.handle !== 'string' || handles.get(args.handle)?.owner !== registeredRoot) {
          return send(res, 403, { error: { code: 'fixtureBoundary', message: 'Repository handle is not registered by this fixture' } });
        }
        if (body.command === 'repository_stage' || body.command === 'repository_unstage' || body.command === 'repository_discard') {
          if (!Array.isArray(args.paths) || args.paths.length < 1 || args.paths.length > 100 ||
            !args.paths.every(validRepoPath)) {
            return send(res, 400, { error: { code: 'invalidPath', message: 'Explicit fixture-relative paths are required' } });
          }
        } else if (body.command === 'repository_stage_hunk' || body.command === 'repository_unstage_hunk' ||
          body.command === 'repository_conflict_file' || body.command === 'repository_resolve_conflict') {
          if (!validRepoPath(args.path)) {
            return send(res, 400, { error: { code: 'invalidPath', message: 'An explicit fixture-relative path is required' } });
          }
        } else if (body.command === 'repository_create_commit') {
          if (typeof args.message !== 'string' || !args.message.trim() || args.message.length > 64 * 1024) {
            return send(res, 400, { error: { code: 'invalidRequest', message: 'Commit message is invalid' } });
          }
        }
        try {
        if (body.command === 'repository_clone' && releasingFixtures.has(fixtureId)) {
          cloneOperations.delete(args.operationId);
          return send(res, 410, { error: { code: 'fixtureReleasing', message: 'Fixture is being released' } });
        }
        if (body.command === 'repository_remote_action' &&
          !await localRemotesOnly(
            handles.get(args.handle).root,
            path.join(path.dirname(registeredRoot), 'remotes'),
            remotes.get(registeredRoot) ?? new Set(),
          )) {
          return send(res, 403, { error: { code: 'fixtureBoundary', message: 'Only fixture-local bare remotes are enabled' } });
        }
        if (body.command === 'repository_worktree_review' || body.command === 'repository_worktree_execute') {
          const repository = handles.get(args.handle);
          const root = repository.root;
          const owner = repository.owner;
          const commonDir = commonDirs.get(owner)?.get(root);
          const request = args.request;
          if (!request || typeof request !== 'object' || typeof request.action !== 'string') {
            return send(res, 400, { error: { code: 'invalidRequest', message: 'A worktree action is required' } });
          }
          const roots = worktrees.get(owner);
          if (!commonDir) return send(res, 403, { error: { code: 'fixtureBoundary', message: 'Repository common directory is not registered' } });
          if (['create', 'move'].includes(request.action)) {
            const destination = path.resolve(request.destination ?? '');
            const sandbox = path.dirname(owner);
            const allowed = path.join(sandbox, 'worktrees');
            const parent = await realpath(path.dirname(destination)).catch(() => '');
            const existingDestination = await realpath(destination).catch(() => '');
            if (!path.isAbsolute(request.destination ?? '') || !within(allowed, parent) ||
              (existingDestination && (!within(allowed, existingDestination) || !samePath(existingDestination, destination))) ||
              destination === root || !within(allowed, destination)) {
              return send(res, 403, { error: { code: 'fixtureBoundary', message: 'Worktree destinations must stay inside this fixture worktrees directory' } });
            }
          }
          if (['move', 'remove', 'lock', 'unlock'].includes(request.action) &&
            ![...(commonDirs.get(owner) ?? [])].some(([root, common]) =>
              samePath(root, path.resolve(request.path ?? '')) && samePath(common, commonDir))) {
            return send(res, 403, { error: { code: 'fixtureBoundary', message: 'Worktree path is not registered to this fixture' } });
          }
          if (['move', 'remove', 'lock', 'unlock'].includes(request.action)) {
            const source = await realpath(request.path).catch(() => '');
            if (!source || !samePath(source, path.resolve(request.path)) || !within(path.dirname(owner), source)) {
              return send(res, 403, { error: { code: 'fixtureBoundary', message: 'Worktree path is not canonical and fixture-contained' } });
            }
          }
        }
        } catch (error) {
          return send(res, error.status ?? 403, { error: { code: 'fixtureBoundary', message: error.message ?? 'Fixture validation failed' } });
        }
        try {
          const dispatchArgs = { ...args };
          delete dispatchArgs.fixtureId;
          let result;
          if (body.command === 'repository_clone') {
            const operation = cloneOperations.get(args.operationId);
            operation.started = true;
            result = await call(body.command, dispatchArgs, {
              timeout: CLONE_TIMEOUT, retainOnTimeout: true,
              onComplete: () => finishClone(args.operationId),
            });
          } else result = await call(body.command, dispatchArgs);
          if (result.error) {
            if (stderrTail.trim()) logger.warn(`Gitty E2E backend stderr:\n${diagnosticTail()}`);
            return send(res, 200, result);
          }
          if (body.command === 'repository_clone') {
            const clonedRoot = await realpath(result.result?.path ?? '').catch(() => '');
            if (!clonedRoot || !samePath(clonedRoot, cloneDestination) ||
              !within(path.join(path.dirname(registeredRoot), 'clones'), clonedRoot)) {
              return send(res, 403, { error: { code: 'fixtureBoundary', message: 'Clone result escaped its registered destination' } });
            }
            const cloneCommonPath = await execFile('git', ['-C', clonedRoot, 'rev-parse', '--git-common-dir'], {
              env: isolatedEnvironment(process.env, { GIT_CONFIG_NOSYSTEM: '1' }),
              timeout: COMMAND_TIMEOUT,
              maxBuffer: 4096,
            });
            const cloneCommonDir = await realpath(path.resolve(clonedRoot, cloneCommonPath.stdout.trim()));
            const expectedCloneCommonDir = await realpath(path.join(clonedRoot, '.git'));
            if (!samePath(cloneCommonDir, expectedCloneCommonDir) || !within(clonedRoot, cloneCommonDir)) {
              return send(res, 403, { error: { code: 'fixtureBoundary', message: 'Clone common directory is not its registered repository metadata' } });
            }
            worktrees.get(registeredRoot).add(clonedRoot);
            commonDirs.get(registeredRoot).set(clonedRoot, cloneCommonDir);
          }
          if (body.command === 'repository_open') {
            const state = result.result;
            try {
              const root = await realpath(state.session.root);
              const commonDir = await realpath(state.session.commonDir);
              const pair = [...(commonDirs.get(registeredRoot) ?? [])].find(([registered]) => samePath(registered, root));
              const expectedCommonDir = pair?.[1];
              if (!samePath(root, path.resolve(dispatchArgs.location.path)) ||
                !pair ||
                !expectedCommonDir || !samePath(commonDir, expectedCommonDir)) throw new Error();
              handles.set(state.session.handle, { owner: registeredRoot, root });
            } catch {
              if (state?.session?.handle) await call('repository_close', { handle: state.session.handle }).catch(() => {});
              return send(res, 403, { error: { code: 'fixtureBoundary', message: 'Resolved repository escaped fixture root' } });
            }
          }
          if (body.command === 'repository_close') handles.delete(args.handle);
          if (body.command === 'repository_worktree_execute' && !result.error) {
            const request = args.request;
            const repository = handles.get(args.handle);
            const roots = worktrees.get(repository.owner);
            const registeredCommonDir = commonDirs.get(repository.owner).get(repository.root);
            if (request.action === 'create') {
              const created = path.resolve(request.destination);
              roots.add(created);
              commonDirs.get(repository.owner).set(created, registeredCommonDir);
            }
            else if (request.action === 'move') {
              roots.delete(path.resolve(request.path));
              commonDirs.get(repository.owner).delete(path.resolve(request.path));
              const destination = path.resolve(request.destination);
              roots.add(destination);
              commonDirs.get(repository.owner).set(destination, registeredCommonDir);
            } else if (request.action === 'remove') {
              roots.delete(path.resolve(request.path));
              commonDirs.get(repository.owner).delete(path.resolve(request.path));
            }
          }
          return send(res, 200, result);
        } catch (error) {
          if (stderrTail.trim()) logger.warn(`Gitty E2E backend stderr:\n${diagnosticTail()}`);
          return send(res, error.status ?? 503, { error: { code: 'bridgeFailure', message: 'Backend process failed' } });
        }
      });
      server.httpServer?.once('close', () => {
        if (child && child.exitCode === null) child.kill();
      });
      server.config.logger.info(`Gitty test bridge ready for ${path.basename(fixtureTemplate)} (stdio backend)`);
    },
  };
}
