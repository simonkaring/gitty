import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { benchDir, median, ms, parseArgs, table } from './common.mjs';

const graphSelector = '[role=listbox][aria-label="Commit history"]';
const repoName = 'large-history';

// Runs inside the shipped WebView. Only count rows backed by the rendered
// graph, not a Tauri window or an empty/loading workspace.
function graphState(selector) {
  const graph = document.querySelector(selector);
  const canvas = graph?.querySelector('canvas.graph-canvas');
  const rows = [...(graph?.querySelectorAll('.commit-row:not(.working)') ?? [])];
  if (!canvas?.width || !canvas.height || !rows.length || !graph.clientHeight) return null;
  const count = Number(rows[0].getAttribute('aria-setsize'));
  if (Number(canvas.dataset.layoutRows) !== count) return null;
  return {
    count,
    selected: graph.getAttribute('aria-activedescendant'),
    head: rows.find(row => row.getAttribute('aria-label')?.includes(', HEAD'))?.id ?? null,
    top: graph.scrollTop,
    first: Number(rows[0].getAttribute('aria-posinset')),
    last: Number(rows.at(-1).getAttribute('aria-posinset')),
    lastId: rows.at(-1).id,
    rendered: rows.length,
  };
}

async function webviewEndpoint(profile, child, deadline) {
  const files = [join(profile, 'EBWebView', 'DevToolsActivePort'), join(profile, 'DevToolsActivePort')];
  while (performance.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Gitty exited before its WebView was available.');
    for (const file of files) {
      const text = await readFile(file, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; });
      const [port, path] = text?.trim().split(/\r?\n/) ?? [];
      if (/^\d{1,5}$/.test(port ?? '') && Number(port) > 0 && Number(port) <= 65535 && /^\/devtools\/browser\/[\w-]+$/.test(path ?? '')) {
        return `ws://127.0.0.1:${port}${path}`;
      }
    }
    await delay(25);
  }
  throw new Error('Timed out waiting for a loopback WebView2 endpoint in the fresh profile.');
}

const gitEnvironment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL',
};
const git = (repo, args) => execFileSync('git', args, {
  cwd: repo, env: gitEnvironment, encoding: 'utf8', windowsHide: true, timeout: 120_000,
}).trim();

async function measure({ exe, fixture, root, target, timeout, indexed }) {
  const sample = await mkdtemp(join(root, 'history-'));
  let child, browser, exited;
  try {
    const repo = join(sample, 'repo');
    const profile = join(sample, 'webview');
    await mkdir(repo);
    // A mirror preserves all branch/tag tips. Convert only the private copy
    // to a working repository; remove the remote to keep auto-fetch out.
    git(repo, ['clone', '--mirror', '--no-hardlinks', '--quiet', fixture, '.git']);
    git(repo, ['config', '--remove-section', 'remote.origin']);
    git(repo, ['config', 'core.bare', 'false']);
    git(repo, ['config', 'core.commitGraph', String(indexed)]);
    git(repo, ['reset', '--hard', '--quiet', 'HEAD']);
    if (indexed) git(repo, ['commit-graph', 'write', '--reachable']);
    const oldHead = git(repo, ['rev-parse', 'HEAD']);
    const branch = git(repo, ['symbolic-ref', 'HEAD']);
    const tree = git(repo, ['rev-parse', 'HEAD^{tree}']);
    const newHead = git(repo, ['-c', 'user.name=Gitty Benchmark', '-c', 'user.email=benchmark@example.invalid',
      'commit-tree', tree, '-p', oldHead, '-m', 'External benchmark commit']);

    const started = performance.now();
    child = spawn(exe, [repo], { stdio: 'ignore', env: {
      ...gitEnvironment, WEBVIEW2_USER_DATA_FOLDER: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=0 --remote-debugging-address=127.0.0.1',
    } });
    exited = new Promise(resolve => child.once('close', resolve));
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const endpoint = await webviewEndpoint(profile, child, started + timeout);
    browser = await chromium.connectOverCDP(endpoint, { timeout });
    const [context] = browser.contexts();
    if (!context) throw new Error('No WebView2 browser context available.');
    const page = context.pages()[0] ?? await context.waitForEvent('page', { timeout });
    page.setDefaultTimeout(timeout);
    const graph = page.locator(graphSelector);
    const readGraph = async () => {
      try {
        return await page.evaluate(graphState, graphSelector);
      } catch (error) {
        // The WebView can be discovered on its bootstrap document, before
        // Tauri navigates it to the bundled app. Re-probe the new context.
        if (error.message.includes('Execution context was destroyed') && !page.isClosed()) return null;
        throw error;
      }
    };
    const waitGraph = async (test, retry) => {
      const deadline = performance.now() + timeout;
      let nextAttempt = 0;
      let state;
      do {
        state = await readGraph();
        if (state && test(state)) return state;
        if (retry && performance.now() >= nextAttempt) {
          const alerts = await page.getByRole('alert').allTextContents();
          if (alerts.length) throw new Error(`Gitty reported an error while paging: ${alerts.join(' ')}`);
          await retry();
          nextAttempt = performance.now() + 500;
        }
        await delay(16);
      } while (performance.now() < deadline);
      const alerts = await page.getByRole('alert').allTextContents();
      const footer = await page.locator('.history-bottom').allTextContents();
      throw new Error(`Timed out waiting for graph state (${test}). Last state: ${JSON.stringify(state)}; footer: ${JSON.stringify(footer)}; app alerts: ${JSON.stringify(alerts)}`);
    };
    const state = await waitGraph(s => s.head?.endsWith(oldHead) && s.selected);
    const graphRowsMs = performance.now() - started;
    await graph.press('ArrowDown');
    await waitGraph(s => s.selected && s.selected !== state.selected);
    const usableMs = performance.now() - started;

    let loaded = state;
    const pages = [];
    const loadOlder = page.locator('.history-bottom button:enabled');
    const pagingStarted = performance.now();
    while (loaded.count < target) {
      const before = loaded.count;
      const pageStarted = performance.now();
      // A concurrent focus/watcher refresh can temporarily reject a page
      // request even while the footer button appears enabled. Retry only
      // while both the DOM and the laid-out row count remain at this page.
      loaded = await waitGraph(s => s.count > before, () => loadOlder.evaluateAll((buttons, { selector, before }) => {
        const row = document.querySelector(`${selector} .commit-row`);
        if (row && Number(row.getAttribute('aria-setsize')) === before) buttons[0]?.click();
      }, { selector: graphSelector, before }));
      pages.push({ fromRows: before, toRows: loaded.count, elapsedMs: performance.now() - pageStarted });
    }
    const pagingMs = performance.now() - pagingStarted;
    const jumpStarted = performance.now();
    await graph.press('End');
    const tail = await waitGraph(s => s.top > 0 && s.last === s.count && s.selected === s.lastId);
    const jumpMs = performance.now() - jumpStarted;

    // Fixed 60-frame deep scroll: each frame moves by a small viewport
    // fraction. Report frame gaps, not an assertion about physical display FPS.
    const sampleFrames = moving => graph.evaluate((element, moving) => new Promise(resolve => {
      const gaps = [];
      const start = element.scrollTop;
      let previous;
      const timer = setTimeout(() => resolve(null), 5000);
      function frame(now) {
        if (previous !== undefined) gaps.push(now - previous);
        previous = now;
        if (moving) element.scrollTop -= Math.max(1, element.clientHeight / 8);
        if (gaps.length < 60) requestAnimationFrame(frame);
        else {
          clearTimeout(timer);
          resolve({ gaps, distancePx: start - element.scrollTop });
        }
      }
      requestAnimationFrame(frame);
    }), moving);
    const idleFrames = await sampleFrames(false);
    const scroll = await sampleFrames(true);
    if (!idleFrames) throw new Error('Idle frame baseline timed out.');
    if (!scroll?.distancePx) throw new Error('Deep scroll produced no frame sample.');
    const p95 = ({ gaps }) => [...gaps].sort((a, b) => a - b)[Math.ceil(gaps.length * 0.95) - 1];
    // The fixture's newer side branches can put HEAD hundreds of rows below
    // Home. Restore its original viewport and select it before timing refresh.
    await graph.evaluate((element, top) => { element.scrollTop = top; }, state.top);
    await waitGraph(s => s.head === state.head);
    await graph.evaluate((element, id) => {
      const row = element.ownerDocument.getElementById(id);
      if (!row || !element.contains(row)) throw new Error('HEAD row left the viewport.');
      row.click();
    }, state.head);
    await waitGraph(s => s.selected === state.head);

    // Start before the external ref write so a fast watcher cannot race the
    // timer. The object was written before launch; the measured mutation
    // changes only the disposable copy's branch and verifies the old OID.
    const refreshStarted = performance.now();
    git(repo, ['update-ref', branch, newHead, oldHead]);
    const writeCompleted = performance.now();
    await waitGraph(s => s.head?.endsWith(newHead));
    return {
      graphRowsMs, usableMs, pagingMs, jumpMs, pages, idleP95Ms: p95(idleFrames), scrollP95Ms: p95(scroll), idleFrames, scroll,
      refreshMs: performance.now() - refreshStarted, externalWriteMs: writeCompleted - refreshStarted,
      initialRows: state.count, deepRows: tail.count, tailRenderedRows: tail.rendered,
    };
  } finally {
    await browser?.close().catch(() => {});
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (exited) await exited;
    await rm(sample, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(`npm run bench:history:windows -- [--gitty target/release/gitty-bench.exe]
  [--dir fixture-and-output-root] [--runs 3] [--rows 2000] [--timeout 45]
  [--commit-graph off|on|both]

Uses a disposable copy of the generated large-history repository and a fresh
WebView2 profile per run. Build gitty-bench.exe with src-tauri/tauri.bench.conf.json.`);
  if (process.platform !== 'win32') throw new Error('This benchmark requires Windows and WebView2.');
  for (const [key, value] of Object.entries(args)) {
    if (!['gitty', 'dir', 'runs', 'rows', 'timeout', 'commit-graph'].includes(key) || typeof value !== 'string') {
      throw new Error(`Unknown option or missing value: --${key}`);
    }
  }
  const integer = (key, fallback, min, max) => {
    const n = Number(args[key] ?? fallback);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${key} must be an integer in ${min}–${max}`);
    return n;
  };
  const runs = integer('runs', 3, 1, 20);
  const target = integer('rows', 2000, 1000, 20_000);
  const timeout = integer('timeout', 45, 3, 300) * 1000;
  const mode = args['commit-graph'] ?? 'both';
  if (!['off', 'on', 'both'].includes(mode)) throw new Error('--commit-graph must be off, on or both.');
  const modes = mode === 'both' ? [false, true] : [mode === 'on'];
  const exe = await realpath(args.gitty ?? 'target/release/gitty-bench.exe');
  if (!/[\\/]gitty-bench\.exe$/i.test(exe)) throw new Error('Use the separate gitty-bench.exe build to avoid changing your regular profile.');
  const dir = resolve(args.dir ?? benchDir());
  const fixture = await realpath(join(dir, 'repos', repoName));
  const commits = Number(git(fixture, ['rev-list', '--count', '--all']));
  if (commits < target) throw new Error('Fixture has fewer commits than --rows.');
  const results = join(dir, 'results');
  await mkdir(results, { recursive: true });
  const root = await mkdtemp(join(dir, 'history-samples-'));
  const report = {
    date: new Date().toISOString(), app: exe, sha256: createHash('sha256').update(await readFile(exe)).digest('hex'),
    machine: { windows: release(), arch: arch(), cpu: cpus()[0]?.model.trim(), logicalProcessors: cpus().length, memoryBytes: totalmem() },
    git: git(dir, ['--version']), settings: { fixture, commits, runs, target, timeout, mode }, results: [],
  };
  try {
    for (let run = 0; run <= runs; run++) {
      for (const indexed of run % 2 ? [...modes].reverse() : modes) {
        console.log(`Commit-graph ${indexed ? 'on' : 'off'} · ${run ? `run ${run}` : 'warm-up'}`);
        const result = await measure({ exe, fixture, root, target, timeout, indexed });
        console.log(`  Usable ${ms(result.usableMs)}; ${result.deepRows} rows in ${ms(result.pagingMs)}; refresh ${ms(result.refreshMs)}`);
        if (run) report.results.push({ indexed, run, ...result });
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10 });
  }
  const path = join(results, `history-windows-${report.date.replace(/[:.]/g, '-')}.json`);
  await writeFile(path, JSON.stringify(report, null, 2));
  const metrics = [['First graph rows', 'graphRowsMs'], ['Usable (keyboard selection)', 'usableMs'],
    ['Load older pages', 'pagingMs'], ['Jump to loaded tail', 'jumpMs'], ['Idle frame gap p95', 'idleP95Ms'], ['Deep scroll frame gap p95', 'scrollP95Ms'],
    ['External ref update → new HEAD row', 'refreshMs']];
  console.log(table(['Median', ...modes.map(indexed => `Commit-graph ${indexed ? 'on' : 'off'}`)],
    metrics.map(([label, key]) => [label, ...modes.map(indexed =>
      ms(median(report.results.filter(result => result.indexed === indexed).map(result => result[key]))))])));
  console.log(`Raw results: ${path}`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
