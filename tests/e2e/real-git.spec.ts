import { test, expect } from '@playwright/test';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, readFile, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const execFile = promisify(execFileCb);
type Fixture = { fixtureId: string; root: string; initialHead: string; token: string };
type TestSession = { fixtureId: string; initialHead: string; location: { path: string }; cloneParent: string; token: string };
const fixturesByPage = new WeakMap<object, Fixture>();
const diagnosticsByPage = new WeakMap<object, string[]>();
const sessions = new Map<string, TestSession>();
const safeJson = (value: unknown) => JSON.stringify(value, (key, item) =>
  /token|secret|authorization/i.test(key) ? '[redacted]' : item);
const safeResponseBody = (text: string) => {
  try { return safeJson(JSON.parse(text)); } catch { return redactDiagnostic(text); }
};
function redactDiagnostic(value: unknown) {
  let text = String(value).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  for (const session of sessions.values()) if (session.token) text = text.replaceAll(session.token, '[redacted]');
  return text.slice(0, 1000);
}
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  diagnosticsByPage.set(page, errors);
  page.on('pageerror', error => errors.push(`pageerror: ${redactDiagnostic(error.message)}`));
  page.on('requestfailed', request => {
    const url = new URL(request.url());
    const failure = request.failure()?.errorText ?? 'failed';
    if (url.pathname === '/__gitty_test/events' && failure === 'net::ERR_ABORTED') return;
    errors.push(redactDiagnostic(`requestfailed: ${request.method()} ${url.origin}${url.pathname}: ${failure}`));
  });
});
async function fixture(page: import('@playwright/test').Page): Promise<Fixture> {
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/__gitty_test/session');
  await page.goto('/');
  const response = await responsePromise;
  if (!response.ok()) {
    const text = await response.text();
    expect(response.ok(), `Fixture bootstrap failed (${response.status()}): ${safeResponseBody(text)}`).toBeTruthy();
  }
  const body = await response.json().catch(() => ({}));
  expect(body?.location?.path, `Fixture bootstrap returned no repository location: ${safeJson(body)}`).toBeTruthy();
  expect(typeof body?.fixtureId === 'string' && typeof body?.token === 'string',
    `Fixture bootstrap omitted session credentials: ${safeJson(body)}`).toBeTruthy();
  const session = body as TestSession;
  sessions.set(session.fixtureId, session);
  const result = { fixtureId: session.fixtureId, root: session.location.path, initialHead: session.initialHead, token: session.token };
  fixturesByPage.set(page, result);
  return result;
}

async function bootstrap(request: import('@playwright/test').APIRequestContext, origin: string): Promise<TestSession> {
  const response = await request.post(`${origin}/__gitty_test/session`, { headers: { Origin: origin }, data: {} });
  if (!response.ok()) {
    const text = await response.text();
    expect(response.ok(), `Fixture bootstrap failed (${response.status()}): ${safeResponseBody(text)}`).toBeTruthy();
  }
  const body = await response.json().catch(() => ({}));
  expect(typeof body?.fixtureId === 'string' && typeof body?.token === 'string' && typeof body?.location?.path === 'string',
    `Fixture bootstrap returned an invalid session: ${safeJson(body)}`).toBeTruthy();
  const session = body as TestSession;
  sessions.set(session.fixtureId, session);
  return session;
}

async function releaseSessions(request: import('@playwright/test').APIRequestContext) {
  const failures: string[] = [];
  for (const session of sessions.values()) {
    const origin = 'http://127.0.0.1:4173';
    try {
      const response = await request.post(`${origin}/__gitty_test/session/release`, {
        headers: { Origin: origin, Authorization: `Bearer ${session.token}` },
        data: { fixtureId: session.fixtureId },
      });
      if (!response.ok()) failures.push(`${session.fixtureId}: ${response.status()} ${redactDiagnostic(await response.text())}`);
    } catch (error) { failures.push(`${session.fixtureId}: ${redactDiagnostic(error)}`); }
  }
  sessions.clear();
  expect(failures, 'Fixture release failures').toEqual([]);
}

async function git(root: string, ...args: string[]) {
  const home = resolve(root, '..', 'home');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const { stdout } = await execFile('git', ['-C', root, ...args], {
    env: {
      ...env,
      HOME: home,
      USERPROFILE: home,
      GIT_CONFIG_GLOBAL: resolve(home, 'gitconfig'),
      GIT_CONFIG_SYSTEM: resolve(home, 'system-gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  return stdout.trimEnd();
}

test('renders a real repository, stages and commits through the UI, and preserves other work', async ({ page }) => {
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  const data = await fixture(page);

  const headRow = page.getByRole('option', { name: /fixture base/ });
  await expect(headRow).toBeVisible();
  await headRow.click();
  await page.getByRole('button', { name: /tracked\.txt/ }).click();
  await expect(page.getByText('base content', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Close diff and show tree' }).click();

  const workRow = page.getByRole('option', { name: /Working changes/ });
  await workRow.click();
  await page.getByRole('button', { name: 'Stage tracked.txt' }).click();
  await expect(page.getByRole('button', { name: 'Staged: tracked.txt' })).toBeVisible();
  await expect.poll(() => git(data.root, 'status', '--porcelain=v1')).toMatch(/^M  tracked\.txt/m);

  expect(data.fixtureId).toMatch(/^[0-9a-f-]{36}$/i);
  const index = {
    names: await git(data.root, 'diff', '--cached', '--name-only'),
    status: await git(data.root, 'status', '--porcelain=v1'),
    entries: await git(data.root, 'ls-files', '--stage'),
  };
  expect(index.status).toMatch(/^M  tracked\.txt/m);
  expect(await git(data.root, 'show', ':tracked.txt')).toBe('changed by the rendered app\nstable line\nextra working line');
  expect(await git(data.root, 'status', '--porcelain')).toContain('?? keep-untracked.txt');

  await page.getByRole('textbox', { name: /Summary/ }).fill('UI test commit');
  await page.getByRole('button', { name: 'Commit staged changes' }).click();
  await expect(page.getByRole('option', { name: /UI test commit/ })).toBeVisible();
  await expect.poll(() => git(data.root, 'log', '-1', '--format=%s')).toBe('UI test commit');
  const newHead = await git(data.root, 'rev-parse', 'HEAD');
  expect(newHead).not.toBe(data.initialHead);
  expect(await git(data.root, 'rev-parse', 'HEAD^')).toBe(data.initialHead);
  expect(await git(data.root, 'show', 'HEAD:tracked.txt')).toBe('changed by the rendered app\nstable line\nextra working line');
  expect(await git(data.root, 'ls-tree', '-r', '--name-only', 'HEAD')).toBe('tracked.txt');
  expect(await git(data.root, 'diff', '--cached', '--name-only')).toBe('');
  expect(await git(data.root, 'status', '--porcelain')).toBe('?? keep-untracked.txt');
  expect(await readFile(resolve(data.root, 'tracked.txt'), 'utf8')).toBe('changed by the rendered app\nstable line\nextra working line\n');
  expect(await readFile(resolve(data.root, 'keep-untracked.txt'), 'utf8')).toBe('must remain uncommitted\n');
  expect(browserErrors).toEqual([]);
});

test('the test bridge rejects missing auth, hostile origins, unsupported methods, and paths outside its fixture', async ({ request }) => {
  const origin = 'http://127.0.0.1:4173';
  const session = await bootstrap(request, origin);
  const fixtureData = { fixtureId: session.fixtureId, root: session.location.path, initialHead: session.initialHead };
  const call = (command: string, args: Record<string, unknown>, headers: Record<string, string> = {}) =>
    request.post(`${origin}/__gitty_test/invoke`, {
    headers: { Origin: origin, Authorization: `Bearer ${session.token}`, ...headers },
      data: { command, args: { ...args, fixtureId: fixtureData.fixtureId } },
    });
  const opened = await call('repository_open', {
    fixtureId: fixtureData.fixtureId, location: { kind: 'native', path: fixtureData.root },
  });
  expect(opened.ok()).toBeTruthy();
  const openedValue = await opened.json();
  const handle = openedValue.result.session.handle as string;

  expect((await request.post(`${origin}/__gitty_test/invoke`, {
    headers: { Origin: origin }, data: { command: 'repository_open', args: {} },
  })).status()).toBe(401);
  expect((await call('repository_open', {}, { Origin: 'https://attacker.invalid' })).status()).toBe(403);
  expect((await call('run_arbitrary_command', {})).status()).toBe(403);
  expect((await call('repository_open', { fixtureId: fixtureData.fixtureId, location: { kind: 'native', path: `${fixtureData.root}-outside` } })).status()).toBe(403);
  expect((await call('repository_clone', {
    operationId: '00000000-0000-4000-8000-000000000001',
    request: { source: 'https://example.invalid/repo.git', parent: { kind: 'native', path: session.cloneParent }, directoryName: 'network-clone' },
  })).status()).toBe(403);
  const second = await bootstrap(request, origin);
  expect((await call('repository_open', { fixtureId: fixtureData.fixtureId, location: second.location })).status()).toBe(403);
  expect((await request.get(`${origin}/__gitty_test/events?fixtureId=${second.fixtureId}`, {
    headers: { Origin: origin, Authorization: `Bearer ${session.token}` },
  })).status()).toBe(401);
  expect((await request.post(`${origin}/__gitty_test/invoke`, {
    headers: { Origin: origin, Authorization: `Bearer ${session.token}` },
    data: { command: 'repository_state', args: { handle, fixtureId: second.fixtureId } },
  })).status()).toBe(401);
  expect((await call('repository_worktree_review', {
    handle, request: { action: 'create', path: '', destination: resolve(second.location.path, '..', 'worktrees', 'cross-fixture'), force: false },
  })).status()).toBe(403);
  expect((await call('repository_worktree_review', {
    handle, request: { action: 'create', path: '', destination: resolve(fixtureData.root, '..', '..', 'escape'), force: false },
  })).status()).toBe(403);
  expect((await call('repository_stage', { handle, paths: ['../outside'] })).status()).toBe(400);
  await git(fixtureData.root, 'remote', 'add', 'hostile', 'https://example.invalid/repo.git');
  expect((await call('repository_remote_action', { handle, action: { kind: 'fetch', remote: 'hostile' } })).status()).toBe(403);
  await git(fixtureData.root, 'config', 'remote.hostile.url', 'safe:repo');
  await git(fixtureData.root, 'config', 'remote.hostile.pushurl', 'https://push.example.invalid/repo.git');
  expect((await call('repository_remote_action', { handle, action: { kind: 'push', remote: 'hostile' } })).status()).toBe(403);
  await git(fixtureData.root, 'config', '--unset', 'remote.hostile.pushurl');
  await git(fixtureData.root, 'config', 'remote.hostile.uploadpack', 'forbidden-helper-must-not-run');
  expect((await call('repository_remote_action', { handle, action: { kind: 'fetch', remote: 'hostile' } })).status()).toBe(403);
  await git(fixtureData.root, 'config', '--unset', 'remote.hostile.uploadpack');
  await git(fixtureData.root, 'config', 'remote.hostile.receivepack', 'forbidden-helper-must-not-run');
  expect((await call('repository_remote_action', { handle, action: { kind: 'push', remote: 'hostile' } })).status()).toBe(403);
  await git(fixtureData.root, 'config', '--unset', 'remote.hostile.receivepack');
  await git(fixtureData.root, 'config', 'url.https://rewrite.example.invalid/.insteadOf', 'safe:');
  expect((await call('repository_remote_action', { handle, action: { kind: 'fetch', remote: 'hostile' } })).status()).toBe(403);
  await git(fixtureData.root, 'config', '--unset', 'url.https://rewrite.example.invalid/.insteadOf');
  await git(fixtureData.root, 'config', 'url.https://push-rewrite.example.invalid/.pushInsteadOf', 'safe:');
  expect((await call('repository_remote_action', { handle, action: { kind: 'push', remote: 'hostile' } })).status()).toBe(403);
  const alias = `${fixtureData.root}-link`;
  try {
    await symlink(fixtureData.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect((await call('repository_open', { fixtureId: fixtureData.fixtureId, location: { kind: 'native', path: alias } })).status()).toBe(403);
  } finally {
    await unlink(alias).catch(() => {});
  }
});

test('stale discard preserves external edits, then a fresh review discards only reviewed work', async ({ page }) => {
  const data = await fixture(page);
  await page.getByRole('option', { name: /Working changes/ }).click();
  await page.getByRole('button', { name: /Discard all/ }).click();
  await expect(page.getByRole('dialog', { name: 'Discard changes?' })).toBeVisible();

  await writeFile(resolve(data.root, 'tracked.txt'), 'external edit after review\n');
  await page.getByRole('dialog').getByRole('button', { name: 'Discard 2 files' }).click();
  await expect.poll(() => readFile(resolve(data.root, 'tracked.txt'), 'utf8')).toBe('external edit after review\n');
  await expect(page.getByRole('alert')).toContainText(/changed|refresh/i);
  await page.getByRole('button', { name: 'Refresh changes' }).click();
  await expect(page.getByRole('button', { name: /Discard all/ })).toBeEnabled();

  await page.getByRole('button', { name: /Discard all/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard 2 files' }).click();
  await expect.poll(() => readFile(resolve(data.root, 'tracked.txt'), 'utf8')).toBe('base content\nstable line\n');
  await expect.poll(() => readFile(resolve(data.root, 'keep-untracked.txt'), 'utf8').then(() => true).catch(() => false)).toBe(false);
  expect(await git(data.root, 'status', '--porcelain=v1')).toBe('');
});

test('partial line staging preserves unrelated staged content and unstaged working bytes', async ({ page }) => {
  const data = await fixture(page);
  await writeFile(resolve(data.root, 'pre-staged.txt'), 'already staged\n');
  await git(data.root, 'add', '--', 'pre-staged.txt');

  await page.getByRole('option', { name: /Working changes/ }).click();
  await page.getByRole('button', { name: 'Unstaged: tracked.txt' }).click();
  await page.getByRole('button', { name: 'Select line 3 for staging' }).click();
  await page.getByRole('button', { name: /Stage selected lines 1 in tracked\.txt/ }).click();

  await expect.poll(() => git(data.root, 'show', ':tracked.txt'))
    .toBe('base content\nstable line\nextra working line');
  expect(await readFile(resolve(data.root, 'tracked.txt'), 'utf8'))
    .toBe('changed by the rendered app\nstable line\nextra working line\n');
  expect(await git(data.root, 'diff', '--cached', '--name-only'))
    .toBe('pre-staged.txt\ntracked.txt');
  expect(await git(data.root, 'diff', '--name-only')).toBe('tracked.txt');
  expect(await git(data.root, 'status', '--porcelain=v1'))
    .toContain('MM tracked.txt');
  expect(await git(data.root, 'show', ':pre-staged.txt')).toBe('already staged');
});

test('stale partial-line review refuses the index write and preserves external bytes', async ({ page }) => {
  const data = await fixture(page);
  const indexBefore = await git(data.root, 'show', ':tracked.txt');
  await page.getByRole('option', { name: /Working changes/ }).click();
  await page.getByRole('button', { name: 'Unstaged: tracked.txt' }).click();
  await page.getByRole('button', { name: 'Select line 3 for staging' }).click();

  await writeFile(resolve(data.root, 'tracked.txt'), 'external content changed after review\n');
  await page.getByRole('button', { name: /Stage selected lines 1 in tracked\.txt/ }).click();

  await expect(page.getByRole('alert')).toContainText(/changed|refresh|stale/i);
  expect(await git(data.root, 'show', ':tracked.txt')).toBe(indexBefore);
  expect(await readFile(resolve(data.root, 'tracked.txt'), 'utf8'))
    .toBe('external content changed after review\n');
});

test('a failing commit hook leaves the staged index intact and is not retried', async ({ page }) => {
  const data = await fixture(page);
  const hookDir = resolve(data.root, 'test-hooks');
  await mkdir(hookDir);
  const hook = resolve(hookDir, 'pre-commit');
  await writeFile(hook, '#!/bin/sh\nprintf x >> hook-count.txt\nprintf "intentional hook rejection\\n" >&2\nexit 1\n');
  await chmod(hook, 0o755);
  await git(data.root, 'config', 'core.hooksPath', hookDir);

  await page.getByRole('option', { name: /Working changes/ }).click();
  await page.getByRole('button', { name: 'Stage tracked.txt' }).click();
  await page.getByRole('textbox', { name: /Summary/ }).fill('commit rejected by hook');
  await page.getByRole('button', { name: 'Commit staged changes' }).click();
  await expect(page.getByRole('alert')).toContainText('intentional hook rejection');

  expect(await git(data.root, 'rev-parse', 'HEAD')).toBe(data.initialHead);
  expect(await git(data.root, 'status', '--porcelain=v1')).toContain('M  tracked.txt');
  expect(await readFile(resolve(data.root, 'hook-count.txt'), 'utf8')).toBe('x');
});

test('external commits arrive through normal refresh and history search selects a matching result', async ({ page }) => {
  let eventStreamReady = false;
  let watchStartedAfterStream = false;
  const isWatch = (request: import('@playwright/test').Request) => {
    if (new URL(request.url()).pathname !== '/__gitty_test/invoke') return false;
    try { return JSON.parse(request.postData() ?? '').command === 'repository_watch'; } catch { return false; }
  };
  page.on('response', response => {
    if (new URL(response.url()).pathname === '/__gitty_test/events' && response.ok()) eventStreamReady = true;
  });
  page.on('request', request => { if (isWatch(request)) watchStartedAfterStream = eventStreamReady; });
  const watched = page.waitForRequest(isWatch);
  const data = await fixture(page);
  await watched;
  expect(watchStartedAfterStream, 'repository_watch must start only after the event stream handshake').toBe(true);
  await expect(page.getByRole('option', { name: /Working changes/ })).toBeVisible();
  await git(data.root, 'commit', '--allow-empty', '-m', 'external refresh marker');
  await expect(page.getByRole('option', { name: /external refresh marker/ })).toBeVisible({ timeout: 2000 });

  const search = page.getByRole('textbox', { name: 'Search full history' });
  await search.fill('external refresh marker');
  const result = page.getByLabel('Search results').getByRole('button', { name: /external refresh marker/ });
  await expect(result).toBeVisible();
  await result.click();
  await expect.poll(() => git(data.root, 'log', '-1', '--format=%s')).toBe('external refresh marker');
  expect(await git(data.root, 'rev-parse', 'HEAD^')).toBe(data.initialHead);
});

test('branch create and switch use reviewed UI operations and update real refs', async ({ page }) => {
  const data = await fixture(page);
  await git(data.root, 'reset', '--hard', data.initialHead);
  await git(data.root, 'clean', '-fdx');

  await page.getByRole('button', { name: 'Branch', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New branch…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Git actions' });
  await dialog.getByLabel('Name').fill('e2e/created');
  await dialog.getByRole('button', { name: 'Review operation' }).click();
  await page.getByRole('button', { name: 'Execute operation' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => git(data.root, 'branch', '--show-current')).toBe('e2e/created');
  expect(await git(data.root, 'rev-parse', 'refs/heads/e2e/created')).toBe(data.initialHead);

  await page.getByRole('button', { name: 'Branch', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Switch branch…' }).click();
  const switchDialog = page.getByRole('dialog', { name: 'Git actions' });
  await switchDialog.getByLabel('Local branch').fill('main');
  await switchDialog.getByRole('button', { name: 'Review operation' }).click();
  await page.getByRole('button', { name: 'Execute operation' }).click();
  await expect(switchDialog).toBeHidden();
  await expect.poll(() => git(data.root, 'branch', '--show-current')).toBe('main');
  expect(await git(data.root, 'rev-parse', 'HEAD')).toBe(data.initialHead);
});

test('merge conflicts resolve in the UI and continue with raw Git state as oracle', async ({ page }) => {
  const data = await fixture(page);
  await git(data.root, 'reset', '--hard', data.initialHead);
  await git(data.root, 'clean', '-fdx');
  await git(data.root, 'switch', '-c', 'topic');
  await writeFile(resolve(data.root, 'tracked.txt'), 'base content\ntopic side\n');
  await git(data.root, 'commit', '-am', 'topic change');
  await git(data.root, 'switch', 'main');
  await writeFile(resolve(data.root, 'tracked.txt'), 'base content\nmain side\n');
  await git(data.root, 'commit', '-am', 'main change');
  const mainHead = await git(data.root, 'rev-parse', 'HEAD');
  const topicHead = await git(data.root, 'rev-parse', 'refs/heads/topic');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();

  await page.getByRole('button', { name: 'Actions for refs/heads/topic' }).click();
  await page.getByRole('menuitem', { name: /Merge topic into main/ }).click();
  const operation = page.getByRole('dialog', { name: 'Git actions' });
  await operation.getByRole('button', { name: 'Review operation' }).click();
  await page.getByRole('button', { name: 'Execute operation' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Merge in progress' })).toBeVisible();
  expect(await git(data.root, 'ls-files', '-u')).toContain('tracked.txt');

  await page.getByRole('button', { name: 'Resolve tracked.txt' }).click();
  const conflict = page.getByRole('dialog', { name: /Resolve tracked\.txt/ });
  await conflict.getByRole('button', { name: 'Accept current' }).click();
  await conflict.getByRole('button', { name: 'Save & mark resolved' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  const continuation = page.getByRole('dialog', { name: 'Git actions' });
  await continuation.getByRole('button', { name: 'Review operation' }).click();
  const reviewedContinue = page.getByRole('dialog', { name: 'Review Git operation' });
  await page.getByRole('button', { name: 'Execute operation' }).click();
  await expect(reviewedContinue).toBeHidden();

  await expect.poll(() => git(data.root, 'status', '--porcelain=v1')).toBe('');
  expect(await git(data.root, 'branch', '--show-current')).toBe('main');
  expect(await git(data.root, 'show', 'HEAD:tracked.txt')).toBe('base content\nmain side');
  expect(await git(data.root, 'show', '-s', '--format=%P', 'HEAD')).toBe(`${mainHead} ${topicHead}`);
});

test('aborting a reviewed conflicted merge leaves HEAD and files intact', async ({ page }) => {
  const data = await fixture(page);
  await git(data.root, 'reset', '--hard', data.initialHead);
  await git(data.root, 'clean', '-fdx');
  await git(data.root, 'switch', '-c', 'topic');
  await writeFile(resolve(data.root, 'tracked.txt'), 'base content\ntopic side\n');
  await git(data.root, 'commit', '-am', 'topic change');
  await git(data.root, 'switch', 'main');
  await writeFile(resolve(data.root, 'tracked.txt'), 'base content\nmain side\n');
  await git(data.root, 'commit', '-am', 'main change');
  const expectedHead = await git(data.root, 'rev-parse', 'HEAD');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('button', { name: 'Actions for refs/heads/topic' }).click();
  await page.getByRole('menuitem', { name: /Merge topic into main/ }).click();
  const merge = page.getByRole('dialog', { name: 'Git actions' });
  await merge.getByRole('button', { name: 'Review operation' }).click();
  await page.getByRole('button', { name: 'Execute operation' }).click();
  await expect.poll(() => git(data.root, 'ls-files', '-u')).toContain('tracked.txt');
  await page.getByRole('button', { name: 'Abort' }).click();
  const abort = page.getByRole('dialog', { name: 'Git actions' });
  await abort.getByRole('button', { name: 'Review operation' }).click();
  await page.getByRole('button', { name: 'Execute operation' }).click();
  await expect(abort).toBeHidden();

  await expect(page.getByRole('status').filter({ hasText: 'Merge in progress' })).toHaveCount(0);
  await expect.poll(() => git(data.root, 'rev-parse', 'HEAD')).toBe(expectedHead);
  expect(await git(data.root, 'status', '--porcelain=v1')).toBe('');
  expect(await git(data.root, 'show', 'HEAD:tracked.txt')).toBe('base content\nmain side');
  expect(await git(data.root, 'rev-parse', '--verify', 'MERGE_HEAD').then(() => true).catch(() => false)).toBe(false);
});

test('fetch and push stay inside a harness-created local bare remote', async ({ page }) => {
  const data = await fixture(page);
  await git(data.root, 'reset', '--hard', data.initialHead);
  await git(data.root, 'clean', '-fdx');
  const remote = resolve(data.root, '..', 'remotes', `remote-${data.fixtureId}.git`);
  const seed = resolve(data.root, '..', 'remotes', `seed-${data.fixtureId}`);
  const origin = 'http://127.0.0.1:4173';
  const registered = await page.request.post(`${origin}/__gitty_test/remote`, {
    headers: { Origin: origin, Authorization: `Bearer ${data.token}` },
    data: { fixtureId: data.fixtureId, name: `remote-${data.fixtureId}` },
  });
  expect(registered.ok()).toBeTruthy();
  await git(data.root, 'remote', 'add', 'origin', remote);
  await git(data.root, 'push', '-u', 'origin', 'main');
  await git(data.root, 'clone', remote, seed);
  await git(data.root, '-C', seed, 'config', 'user.name', 'Gitty E2E');
  await git(data.root, '-C', seed, 'config', 'user.email', 'gitty-e2e@example.invalid');
  await git(data.root, '-C', seed, 'switch', '-c', 'topic');
  await git(data.root, '-C', seed, 'commit', '--allow-empty', '-m', 'remote topic');
  await git(data.root, '-C', seed, 'push', '-u', 'origin', 'topic');

  await page.getByRole('button', { name: 'More pull options' }).click();
  await page.getByRole('menuitem', { name: 'Fetch only' }).click();
  await expect.poll(() => git(data.root, 'show-ref', '--verify', 'refs/remotes/origin/topic').then(() => true, () => false))
    .toBe(true);

  await git(data.root, 'commit', '--allow-empty', '-m', 'local push marker');
  await expect(page.getByRole('button', { name: /Push/ })).toBeEnabled();
  await page.getByRole('button', { name: /Push/ }).click();
  await expect.poll(() => git(data.root, '--git-dir', remote, 'rev-parse', 'refs/heads/main'))
    .toBe(await git(data.root, 'rev-parse', 'HEAD'));
});

test('clones a registered local bare remote through the rendered UI', async ({ page }) => {
  const data = await fixture(page);
  const session = sessions.get(data.fixtureId)!;
  let cloneRequest: { source: string; parent: { path: string }; directoryName: string } | undefined;
  page.on('request', request => {
    if (new URL(request.url()).pathname !== '/__gitty_test/invoke') return;
    try {
      const body = JSON.parse(request.postData() ?? '');
      if (body.command === 'repository_clone') cloneRequest = body.args.request;
    } catch { /* Not a protocol request. */ }
  });
  const origin = 'http://127.0.0.1:4173';
  const remoteName = `clone-${data.fixtureId}`;
  const registered = await page.request.post(`${origin}/__gitty_test/remote`, {
    headers: { Origin: origin, Authorization: `Bearer ${data.token}` },
    data: { fixtureId: data.fixtureId, name: remoteName },
  });
  expect(registered.ok()).toBeTruthy();
  const remote = (await registered.json()).path as string;
  await git(data.root, 'remote', 'add', 'clone-source', remote);
  await git(data.root, 'push', 'clone-source', 'main');
  await git(data.root, '--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');

  await page.getByRole('button', { name: 'New tab' }).click();
  await page.getByRole('tab', { name: 'Clone' }).click();
  await page.getByRole('button', { name: 'Repository URL' }).click();
  await page.getByRole('textbox', { name: 'Repository URL' }).fill(remote);
  await page.getByRole('textbox', { name: 'Folder name' }).fill('ui-clone');
  await page.getByRole('button', { name: 'Clone repository' }).click();

  await expect.poll(() => cloneRequest?.directoryName).toBe('ui-clone');
  expect(cloneRequest?.parent.path).toBe(session.cloneParent);
  const cloned = resolve(session.cloneParent, 'ui-clone');
  await expect(page.getByRole('tab', { name: /ui-clone/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /fixture base/ })).toBeVisible();
  await expect.poll(() => git(cloned, 'rev-parse', 'HEAD')).toBe(await git(data.root, 'rev-parse', 'HEAD'));
  expect(await git(cloned, 'show', 'HEAD:tracked.txt')).toContain('base');
  expect(await git(cloned, 'remote', 'get-url', 'origin')).toBe(remote);

  const opened = await page.request.post(`${origin}/__gitty_test/invoke`, {
    headers: { Origin: origin, Authorization: `Bearer ${data.token}` },
    data: { command: 'repository_open', args: { fixtureId: data.fixtureId, location: { kind: 'native', path: cloned } } },
  });
  expect(opened.ok()).toBeTruthy();
  const handle = (await opened.json()).result.session.handle as string;
  const unrelatedWorktree = await page.request.post(`${origin}/__gitty_test/invoke`, {
    headers: { Origin: origin, Authorization: `Bearer ${data.token}` },
    data: {
      command: 'repository_worktree_review',
      args: {
        fixtureId: data.fixtureId,
        handle,
        request: { action: 'remove', path: data.root, destination: '', branch: '', startPoint: '', reason: '', force: false },
      },
    },
  });
  expect(unrelatedWorktree.status()).toBe(403);
  await git(cloned, 'remote', 'add', 'hostile', 'file:///not-a-registered-fixture-remote');
  const hostile = await page.request.post(`${origin}/__gitty_test/invoke`, {
    headers: { Origin: origin, Authorization: `Bearer ${data.token}` },
    data: { command: 'repository_remote_action', args: { fixtureId: data.fixtureId, handle, action: { kind: 'fetch', remote: 'hostile' } } },
  });
  expect(hostile.status()).toBe(403);
});

test('worktree creation and removal require review and preserve the main repository', async ({ page }) => {
  const data = await fixture(page);
  await git(data.root, 'reset', '--hard', data.initialHead);
  await git(data.root, 'clean', '-fdx');
  const destination = resolve(data.root, '..', 'worktrees', `worktree-${data.fixtureId}`);
  const worktrees = page.getByLabel('Worktrees');
  await worktrees.getByRole('button', { name: 'Create worktree' }).click();
  const create = page.getByRole('dialog', { name: 'Create worktree' });
  await create.getByLabel('Destination folder (absolute path)').fill(destination);
  await create.getByLabel('New branch (optional)').fill('e2e/worktree');
  await create.getByRole('button', { name: 'Review' }).click();
  await expect(create.getByRole('status')).toContainText('Review captured');
  await create.getByRole('button', { name: 'Create worktree' }).click();
  await expect(create).toBeHidden();
  await expect.poll(() => git(data.root, 'worktree', 'list', '--porcelain').then(value => value.replaceAll('\\', '/'))).toContain(destination.replaceAll('\\', '/'));
  await expect.poll(() => git(data.root, '-C', destination, 'branch', '--show-current')).toBe('e2e/worktree');

  await page.getByRole('button', { name: `Close worktree-${data.fixtureId}` }).click();
  await worktrees.getByRole('button', { name: new RegExp(`Manage worktree .*worktree-${data.fixtureId}$`) }).click();
  const manage = page.getByRole('dialog', { name: 'Move worktree' });
  await manage.getByLabel('Action').selectOption('remove');
  await manage.getByRole('button', { name: 'Review' }).click();
  await expect(manage.getByRole('status')).toContainText('Review captured');
  await manage.getByRole('button', { name: 'Remove worktree' }).click();
  await expect.poll(() => git(data.root, 'worktree', 'list', '--porcelain').then(value => value.replaceAll('\\', '/'))).not.toContain(destination.replaceAll('\\', '/'));
  await expect.poll(() => stat(destination).then(() => true).catch(() => false)).toBe(false);
  expect(await git(data.root, 'branch', '--show-current')).toBe('main');
});

test('large working sets stay virtualized, reveal the tail, and stage only the selected file', async ({ page }) => {
  const data = await fixture(page);
  await git(data.root, 'reset', '--hard', data.initialHead);
  await git(data.root, 'clean', '-fdx');
  const count = 220;
  for (let i = 0; i < count; i++) await writeFile(resolve(data.root, `bulk-${String(i).padStart(3, '0')}.txt`), `base ${i}\n`);
  const longPath = `${'directory-segment-'.repeat(7)}/long-nested-diff-fixture.txt`;
  await mkdir(resolve(data.root, longPath.split('/')[0]), { recursive: true });
  await writeFile(resolve(data.root, longPath), 'long path base\n');
  await git(data.root, 'add', '--all');
  await git(data.root, 'commit', '-m', 'large working-set base');
  for (let i = 0; i < count; i++) await writeFile(resolve(data.root, `bulk-${String(i).padStart(3, '0')}.txt`), `changed ${i}\n`);
  await writeFile(resolve(data.root, longPath), 'long path changed\n');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('option', { name: new RegExp(`Working changes · ${count + 1} paths`) }).click();
  const files = page.getByRole('region', { name: 'Unstaged files' });
  await expect(files.getByRole('button', { name: `Unstaged, ${count + 1} files` })).toBeVisible();
  const visibleRows = files.getByRole('button', { name: /Unstaged: bulk-/ });
  await expect.poll(() => visibleRows.count()).toBeLessThan(count);
  await page.locator('.working-files-list').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(files.getByRole('button', { name: `Unstaged: ${longPath}` })).toBeVisible();
  await files.getByRole('button', { name: `Stage ${longPath}` }).click();
  await expect.poll(() => git(data.root, 'diff', '--cached', '--name-only')).toBe(longPath);
  expect(await git(data.root, 'diff', '--name-only')).toContain('bulk-000.txt');
});

test('tab keyboard selection, themes, split diffs, and narrow workspace layout remain usable', async ({ page }, testInfo) => {
  await fixture(page);
  const tabs = page.getByRole('tablist', { name: 'Open repositories' });
  const original = tabs.getByRole('tab').first();
  await original.focus();
  await original.press('ArrowRight');
  await expect(tabs.getByRole('tab')).toHaveCount(1);
  await page.getByRole('button', { name: 'New tab' }).click();
  await expect(tabs.getByRole('tab')).toHaveCount(2);
  await tabs.getByRole('tab').last().focus();
  await tabs.getByRole('tab').last().press('Alt+ArrowLeft');
  await expect(tabs.getByRole('tab').first()).toContainText('New tab');
  await tabs.getByRole('tab', { name: /repo/ }).click();
  const branchActions = page.getByRole('button', { name: 'Actions for refs/heads/main' });
  await branchActions.focus();
  await branchActions.press('Shift+F10');
  await expect(page.getByRole('menu', { name: 'Actions for main' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog');
  await expect(palette).toBeVisible();
  await expect(palette.locator('input').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await page.getByRole('option', { name: 'Theme: Gitty Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await testInfo.attach('theme-light.png', { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
  await page.keyboard.press('Control+k');
  await page.getByRole('option', { name: 'Theme: Gitty Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await testInfo.attach('theme-dark.png', { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });

  const settingsButton = page.getByRole('button', { name: 'Open settings' });
  await settingsButton.click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Editor & diffs' }).click();
  await settings.getByLabel('Default diff layout').selectOption('split');
  await settings.getByRole('button', { name: 'Close dialog' }).click();
  await expect(settingsButton, `active element: ${JSON.stringify(await page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    label: document.activeElement?.getAttribute('aria-label'),
    text: document.activeElement?.textContent?.trim().slice(0, 80),
  })))}`).toBeFocused();
  await page.getByRole('option', { name: /Working changes/ }).click();
  await page.getByRole('button', { name: 'Unstaged: tracked.txt' }).click();
  await expect(page.getByRole('group', { name: 'Diff layout' }).getByRole('button', { name: 'Split' })).toHaveAttribute('aria-pressed', 'true');

  await page.setViewportSize({ width: 760, height: 820 });
  await expect(page.getByRole('button', { name: 'Toggle references sidebar' })).toBeVisible();
  await page.getByRole('button', { name: 'Toggle working changes and inspector' }).click();
  await expect(page.getByRole('button', { name: 'Toggle working changes and inspector' })).toHaveAttribute('aria-pressed', 'true');
  await testInfo.attach('narrow-split.png', { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
});

test.afterEach(async ({ page, request }, testInfo) => {
  const errors = diagnosticsByPage.get(page) ?? [];
  const failed = testInfo.status !== testInfo.expectedStatus || errors.length > 0;
  if (failed) {
    try {
      const data = fixturesByPage.get(page);
      if (data) {
        const [status, head] = await Promise.all([
          git(data.root, 'status', '--porcelain=v1'),
          git(data.root, 'log', '-1', '--format=%H %s'),
        ]);
        await testInfo.attach('fixture-state.txt', {
          body: `fixture=${data.fixtureId}\nhead=${head}\nstatus:\n${status}\n`,
          contentType: 'text/plain',
        });
      }
    } catch { /* Harness teardown may already have removed a failed fixture. */ }
    if (errors.length) await testInfo.attach('browser-errors.txt', { body: errors.join('\n').slice(-8192), contentType: 'text/plain' });
  }
  await page.close();
  try {
    await releaseSessions(request);
  } catch (error) {
    if (testInfo.status === testInfo.expectedStatus) throw error;
    await testInfo.attach('fixture-release-error.txt', { body: String(error), contentType: 'text/plain' });
  }
  expect(errors.filter(error => !/requestfailed: GET http:\/\/127\.0\.0\.1:4173\/__gitty_test\/events: net::ERR_ABORTED$/.test(error))).toEqual([]);
});
