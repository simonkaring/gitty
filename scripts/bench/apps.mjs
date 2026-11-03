// Compares Gitty and GitKraken end to end on macOS: launch a repository, time
// the first window and the moment the window stops changing, then sample
// memory and idle CPU for the whole process family.
//
//   node scripts/bench/apps.mjs [--repos a,b] [--runs 3] [--idle 30] [--apps gitty,gitkraken]
//                               [--gitty <Gitty.app>] [--gitkraken <GitKraken.app>]
//                               [--gitty-profile isolated|user]
//
// WARNING: quits running instances of both apps. Each app is launched through
// LaunchServices (`open -a`) with the repository as an argument (`Gitty <path>`,
// `GitKraken -p <path>`), so macOS attributes WebKit/Electron helper processes
// to the app rather than to the terminal.
// The terminal needs Screen Recording permission for window capture.
//
// By default Gitty runs from an ad-hoc signed copy with its own bundle
// identifier and its WebKit storage is cleared before each launch, so it opens
// only the benchmark repository instead of your restored tabs (every
// restored Gitty tab opens a session and fetches at startup). GitKraken always
// uses your existing profile; it loads only the active tab's repository.
// `--gitty-profile user` launches Gitty with your own tabs instead.
//
// "Visually complete" is when the window last changed by more than
// --threshold of its pixels (default 0.3%) before staying unchanged for
// --settle ms. It does not know what either app draws; inspect `changes` in
// the JSON when a result looks surprising.
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { benchDir, mb, median, ms, parseArgs, table } from './common.mjs';

if (process.platform !== 'darwin') throw new Error('The app comparison runs on macOS only.');
const args = parseArgs(process.argv.slice(2));
const dir = args.dir ?? benchDir();
const runs = Number(args.runs ?? 3);
const idleSeconds = Number(args.idle ?? 30);
const settle = Number(args.settle ?? 3000);
const threshold = Number(args.threshold ?? 0.003);
const timeout = Number(args.timeout ?? 120_000);
const sleep = ms => new Promise(done => setTimeout(done, ms));

const localGitty = resolve('src-tauri/target/release/bundle/macos/Gitty.app');
const gittyBundle = args.gitty ?? (existsSync(localGitty) ? localGitty : '/Applications/Gitty.app');
const isolatedGitty = (args['gitty-profile'] ?? 'isolated') === 'isolated';

/** Copy of Gitty with a separate bundle identifier, and so separate WebKit storage. */
function isolatedCopy(source) {
  const target = join(dir, 'Gitty Bench.app');
  // Refreshed on every run: codesign rewrites the copy, so timestamps can't tell builds apart.
  execFileSync('rm', ['-rf', target]);
  execFileSync('ditto', [source, target]);
  execFileSync('plutil', ['-replace', 'CFBundleIdentifier', '-string', 'app.gitty.desktop.bench', join(target, 'Contents/Info.plist')]);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', target], { stdio: 'ignore' });
  return realpathSync(target);
}

const APPS = {
  gitty: {
    name: 'Gitty',
    bundle: gittyBundle,
    executable: 'Contents/MacOS/gitty',
    id: 'app.gitty.desktop',
    argv: repo => [repo],
  },
  gitkraken: {
    name: 'GitKraken',
    bundle: args.gitkraken ?? '/Applications/GitKraken.app',
    executable: 'Contents/MacOS/GitKraken',
    id: 'com.axosoft.gitkraken',
    argv: repo => ['-p', repo],
  },
};
const apps = String(args.apps ?? 'gitty,gitkraken').split(',').map(key => {
  const app = APPS[key];
  if (!app) throw new Error(`Unknown app ${key}`);
  if (!existsSync(join(app.bundle, app.executable))) throw new Error(`${app.name} not found at ${app.bundle}`);
  if (key === 'gitty' && isolatedGitty) return { key, ...app, source: app.bundle, bundle: isolatedCopy(app.bundle), id: 'app.gitty.desktop.bench' };
  return { key, ...app };
});

const fixtures = join(dir, 'repos');
const repos = typeof args.repos === 'string'
  ? args.repos.split(',').map(path => resolve(path))
  : ['small', 'large-history', 'wide-status', 'git-git'].map(name => join(fixtures, name)).filter(existsSync);
if (!repos.length) throw new Error('No repositories: run `npm run bench:fixtures` or pass --repos');

// Build the probe once per source change.
const probe = join(dir, 'probe');
const probeSource = resolve('scripts/bench/probe.swift');
if (!existsSync(probe) || statSync(probe).mtimeMs < statSync(probeSource).mtimeMs) {
  console.log('Compiling probe…');
  execFileSync('swiftc', ['-O', '-parse-as-library', probeSource, '-o', probe], { stdio: 'inherit' });
}
const probeJson = (...argv) => JSON.parse(execFileSync(probe, argv.map(String), { encoding: 'utf8', maxBuffer: 1 << 26 }));

function pidsOf(app) {
  try {
    return execFileSync('pgrep', ['-f', join(app.bundle, app.executable)], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number);
  } catch { return []; }
}

async function quit(app) {
  if (!pidsOf(app).length) return;
  try { execFileSync('osascript', ['-e', `tell application id "${app.id}" to quit`], { stdio: 'ignore', timeout: 10_000 }); } catch { /* fall through to signals */ }
  for (let i = 0; i < 100 && pidsOf(app).length; i++) await sleep(100);
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const pid of pidsOf(app)) { try { process.kill(pid, signal); } catch { /* already gone */ } }
    for (let i = 0; i < 50 && pidsOf(app).length; i++) await sleep(100);
  }
  await sleep(1000);
}

function family(pid) {
  const procs = probeJson('tree', pid);
  return {
    processes: procs.length,
    footprint: procs.reduce((sum, p) => sum + (p.footprint ?? 0), 0),
    cpuNs: procs.reduce((sum, p) => sum + (p.cpuNs ?? 0) + (p.childCpuNs ?? 0), 0),
    detail: procs,
  };
}

async function measure(app, repo) {
  await quit(app);
  // The isolated copy starts every run with empty WebKit storage: only the launch tab.
  if (app.id === 'app.gitty.desktop.bench') await rm(join(homedir(), 'Library/WebKit/app.gitty.desktop.bench'), { recursive: true, force: true });
  const epoch = Date.now();
  execFileSync('open', ['-n', '-a', app.bundle, '--args', ...app.argv(repo)]);
  let pid;
  for (let i = 0; i < 200 && !pid; i++) { [pid] = pidsOf(app); if (!pid) await sleep(25); }
  if (!pid) throw new Error(`${app.name} did not start`);
  const visual = probeJson('watch', pid, epoch, timeout, settle, threshold);
  // Without window captures only the first window is known; never report it as completion.
  if (!visual.captures) {
    console.warn(`  ! no window captures${visual.error ? `: ${visual.error}` : ''} — grant Screen Recording to the terminal (or ${probe}) to measure visual completion`);
    visual.completeMs = null;
  }
  const launchCpuNs = family(pid).cpuNs;
  await sleep(5000);
  const loaded = family(pid);
  await sleep(idleSeconds * 1000);
  const idle = family(pid);
  await quit(app);
  return {
    windowMs: visual.windowMs,
    completeMs: visual.completeMs,
    timedOut: visual.timedOut,
    changes: visual.changes,
    captures: visual.captures,
    captureError: visual.error ?? null,
    launchCpuMs: launchCpuNs / 1e6,
    footprint: loaded.footprint,
    footprintAfterIdle: idle.footprint,
    processes: loaded.processes,
    idleCpuPercent: (idle.cpuNs - loaded.cpuNs) / (idleSeconds * 1e9) * 100,
    processDetail: idle.detail.map(({ name, footprint, cpuNs, childCpuNs }) => ({ name, footprint, cpuNs, childCpuNs })),
  };
}

const bundleBytes = path => Number(execFileSync('du', ['-sk', path], { encoding: 'utf8' }).split('\t')[0]) * 1024;
const version = path => { try { return execFileSync('defaults', ['read', join(path, 'Contents/Info.plist'), 'CFBundleShortVersionString'], { encoding: 'utf8' }).trim(); } catch { return null; } };
const report = {
  date: new Date().toISOString(),
  machine: { cpu: execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim(), memoryBytes: Number(execFileSync('sysctl', ['-n', 'hw.memsize'], { encoding: 'utf8' })), macos: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim() },
  settings: { runs, idleSeconds, settle, threshold },
  apps: Object.fromEntries(apps.map(app => [app.key, { bundle: app.bundle, version: version(app.bundle), bundleBytes: bundleBytes(app.bundle) }])),
  results: [],
};

for (const repo of repos) {
  for (const app of apps) {
    // One discarded launch warms the OS file cache and each app's own caches.
    console.log(`${app.name} · ${basename(repo)} · warm-up`);
    await measure(app, repo);
    for (let run = 1; run <= runs; run++) {
      const result = await measure(app, repo);
      console.log(`${app.name} · ${basename(repo)} · run ${run}: window ${ms(result.windowMs)}, visually complete ${ms(result.completeMs)}${result.timedOut ? ' (timed out)' : ''}, ${mb(result.footprint)}, idle CPU ${result.idleCpuPercent.toFixed(1)}%`);
      report.results.push({ app: app.key, repo: basename(repo), run, ...result });
    }
  }
}

await mkdir(join(dir, 'results'), { recursive: true });
const out = join(dir, 'results', `apps-${report.date.replace(/[:.]/g, '-')}.json`);
await writeFile(out, JSON.stringify(report, null, 2));

const pick = (app, repo, key) => median(report.results.filter(r => r.app === app && r.repo === repo).map(r => r[key]));
console.log(`\n${apps.map(app => `${app.name} ${report.apps[app.key].version}: bundle ${mb(report.apps[app.key].bundleBytes)}`).join(' · ')}\n`);
console.log(table(
  ['Repository', 'Metric', ...apps.map(app => app.name)],
  repos.map(repo => basename(repo)).flatMap(repo => [
    [repo, 'First window', ...apps.map(app => ms(pick(app.key, repo, 'windowMs')))],
    ['', 'Visually complete', ...apps.map(app => ms(pick(app.key, repo, 'completeMs')))],
    ['', 'CPU time to settle', ...apps.map(app => ms(pick(app.key, repo, 'launchCpuMs')))],
    ['', 'Memory (loaded)', ...apps.map(app => mb(pick(app.key, repo, 'footprint')))],
    ['', `Memory (+${idleSeconds}s idle)`, ...apps.map(app => mb(pick(app.key, repo, 'footprintAfterIdle')))],
    ['', 'Idle CPU', ...apps.map(app => { const v = pick(app.key, repo, 'idleCpuPercent'); return v === null ? null : `${v.toFixed(1)}%`; })],
    ['', 'Processes', ...apps.map(app => pick(app.key, repo, 'processes'))],
  ]),
));
console.log(`\nMedians of ${runs} runs after one warm-up. Raw results: ${out}`);
