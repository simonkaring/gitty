// Compares the performance work on this branch against a baseline ref.
//
//   node scripts/bench/compare.mjs [--baseline <ref>] [--iterations 5]
//                                  [--commits 50000] [--page 200]
//                                  [--repos a,b] [--skip-frontend] [--skip-backend]
//
// Frontend: pages a synthetic branchy graph through `appendHistory` using both
// the working-tree `src/graph/layout.ts` and the baseline copy read from Git,
// then compares total time, worst page, and edge objects re-created. Both are
// compiled with the esbuild that ships with Vite, so there is nothing to
// install.
//
// Backend: runs the ignored `bench_tests::backend_benchmark` (the same test as
// `npm run bench:backend`) in this tree and in a temporary worktree of the
// baseline, then compares wall time and Git process launches. Uses the
// synthetic fixtures from `npm run bench:fixtures`, generating them on first
// run and warming each repository's index first. The first backend run builds
// the app in release mode twice, which can take several minutes; pass
// --skip-backend for the quick layout comparison.
//
// The baseline defaults to the merge base with `main`. Nothing is committed,
// checked out, or pushed, and the temporary worktree is removed afterwards.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transform } from 'esbuild';
import { benchDir, median, ms, parseArgs, table } from './common.mjs';

const args = parseArgs(process.argv.slice(2));
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const git = (...argv) => execFileSync('git', argv, { cwd: root, encoding: 'utf8' }).trim();
const iterations = Number(args.iterations ?? 5);
const baseline = args.baseline ?? git('merge-base', 'HEAD', 'main');
const headSha = git('rev-parse', 'HEAD');
const baseSha = git('rev-parse', baseline);
const short = baseSha.slice(0, 7);
if (headSha === baseSha) {
  throw new Error(`Baseline ${baseline} is HEAD; pass --baseline <ref> naming the commit to compare against.`);
}
const dirty = git('status', '--porcelain') !== '';
console.log(`baseline ${short}  ${git('log', '-1', '--format=%s', baseline)}`);
console.log(`current  ${headSha.slice(0, 7)}  ${git('log', '-1', '--format=%s')}${dirty ? ' (+ uncommitted changes)' : ''}`);

const factor = (before, after) => after > 0 ? `${(before / after).toFixed(1)}x faster` : 'n/a';
const count = value => value.toLocaleString('en-US');
const saved = {};

// ---------------------------------------------------------------- frontend

/** Child-before-parent DAG: a spine plus a merge every `mergeEvery` commits
 * whose second parent arrives `mergeSpan` rows later, so some edges stay
 * pending across pages the way a real branchy history does. */
function history(commits, mergeEvery = 12, mergeSpan = 31) {
  const result = [];
  for (let i = 0; i < commits; i++) {
    const parents = [];
    if (i + 1 < commits) parents.push(`c${i + 1}`);
    if (mergeEvery && i % mergeEvery === 0 && i + 1 < commits) parents.push(`c${Math.min(commits - 1, i + mergeSpan)}`);
    result.push({ id: `c${i}`, parents });
  }
  return result;
}

async function compile(dir, name, source) {
  const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'node20' });
  const file = join(dir, `${name}.mjs`);
  await writeFile(file, code);
  return import(pathToFileURL(file).href);
}

/** One full paging pass. Re-creations count every edge object the pass
 * allocated: the baseline maps over all prior edges each page; the current
 * version reports only the edges it actually re-pointed. */
function pageThrough(layout, pages) {
  const state = layout.createLayoutState();
  let page;
  let knownEdges = 0;
  let reallocated = 0;
  const marks = [];
  const started = performance.now();
  for (const commits of pages) {
    const at = performance.now();
    page = layout.appendHistory(state, commits);
    marks.push(performance.now() - at);
    reallocated += state.lastResolved ? state.lastResolved.length : knownEdges;
    knownEdges = page.edges.length;
  }
  return { millis: performance.now() - started, marks, reallocated, page };
}

async function frontend() {
  const commits = Number(args.commits ?? 50_000);
  const size = Number(args.page ?? 200);
  const graph = history(commits);
  const pages = [];
  for (let i = 0; i < graph.length; i += size) pages.push(graph.slice(i, i + size));
  console.log(`\nFrontend: ${count(commits)} commits in ${pages.length} pages of ${size}`);

  const dir = await mkdtemp(join(tmpdir(), 'gitty-layout-'));
  try {
    const current = await compile(dir, 'current', await readFile(join(root, 'src/graph/layout.ts'), 'utf8'));
    const before = await compile(dir, 'baseline', git('show', `${baseline}:src/graph/layout.ts`));
    // Warm both, then alternate the order so a background pause cannot favour one side.
    pageThrough(before, pages);
    pageThrough(current, pages);
    const samples = { baseline: [], current: [] };
    const passes = { baseline: [], current: [] };
    for (let round = 0; round < Math.max(1, iterations); round++) {
      for (const side of round % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
        const sample = pageThrough(side === 'current' ? current : before, pages);
        samples[side].push(sample.millis);
        passes[side].push(sample);
      }
    }
    // Page-level metrics cover every pass, like the total does. The last pass
    // alone still supplies the layout output and reallocation counts.
    const base = passes.baseline.at(-1), now = passes.current.at(-1);
    const baseMarks = passes.baseline.flatMap(pass => pass.marks);
    const nowMarks = passes.current.flatMap(pass => pass.marks);
    const baseWorst = Math.max(...baseMarks), nowWorst = Math.max(...nowMarks);
    const baseMedian = median(baseMarks), nowMedian = median(nowMarks);
    const sameNodes = JSON.stringify(base.page.nodes) === JSON.stringify(now.page.nodes);
    const sameEdges = JSON.stringify(base.page.edges) === JSON.stringify(now.page.edges);
    const resolved = now.page.edges.every(edge => edge.toRow > edge.fromRow);
    const baseTotal = median(samples.baseline), nowTotal = median(samples.current);

    console.log(table(
      ['Metric', `baseline ${short}`, 'current', 'change'],
      [
        [`Total paging (median of ${iterations})`, ms(baseTotal), ms(nowTotal), factor(baseTotal, nowTotal)],
        ['Slowest page (all passes)', ms(baseWorst), ms(nowWorst), factor(baseWorst, nowWorst)],
        ['Median page (all passes)', ms(baseMedian), ms(nowMedian), factor(baseMedian, nowMedian)],
        ['Edge objects re-created', count(base.reallocated), count(now.reallocated), `${count(base.reallocated - now.reallocated)} fewer`],
      ],
    ));
    console.log(`Layout output identical: ${sameNodes && sameEdges && resolved ? 'yes' : 'NO — nodes/edges differ'}`);
    saved.frontend = {
      commits, page: size, iterations,
      baseline: samples.baseline, current: samples.current,
      marks: { baseline: baseMarks, current: nowMarks },
      reallocated: { baseline: base.reallocated, current: now.reallocated },
      identical: sameNodes && sameEdges && resolved,
    };
    if (!(sameNodes && sameEdges && resolved)) process.exitCode = 1;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------- backend

async function backend() {
  const dir = benchDir();
  const fixtures = join(dir, 'repos');
  if (!existsSync(fixtures) || !readdirSync(fixtures).length) {
    console.log('\nGenerating synthetic fixtures once (100k commits, a few minutes)…');
    execFileSync(process.execPath, [join(root, 'scripts/bench/fixtures.mjs'), '--dir', dir], { cwd: root, stdio: 'inherit' });
  }
  const repos = typeof args.repos === 'string'
    ? args.repos.split(',').map(path => resolve(path))
    : readdirSync(fixtures).map(name => join(fixtures, name));
  if (!repos.length) throw new Error('No repositories: run `npm run bench:fixtures` or pass --repos');

  // A freshly generated fixture has no index stat cache, so the first binary to
  // run `git status` in it rewrites the index and looks several times slower for
  // scenarios it did not change. Warm every repository before either run.
  console.log('\nWarming fixture repositories…');
  for (const repo of repos) {
    for (const argv of [['status', '--porcelain=v2', '-z'], ['log', '-1', '--format=%H'], ['for-each-ref']]) {
      execFileSync('git', ['-C', repo, ...argv], { stdio: 'ignore' });
    }
  }

  const results = join(dir, 'results');
  await mkdir(results, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const worktree = join(dir, `baseline-${short}`);
  // Sharing the target directory avoids compiling Tauri and its dependencies
  // twice; the local crate still rebuilds for each tree.
  const targetDir = join(root, 'src-tauri', 'target');

  const run = async (cwd, out) => {
    if (cwd === worktree && !existsSync(join(cwd, 'src-tauri/src/bench_tests.rs'))) {
      throw new Error(`Baseline ${short} has no backend benchmark (src-tauri/src/bench_tests.rs).`);
    }
    execFileSync('cargo', [
      'test', '--release', '--manifest-path', join(cwd, 'src-tauri', 'Cargo.toml'),
      '--lib', 'bench_tests::backend_benchmark', '--', '--ignored', '--exact', '--nocapture',
    ], {
      cwd,
      stdio: 'inherit',
      env: {
        ...process.env,
        CARGO_TARGET_DIR: targetDir,
        GITTY_BENCH_REPOS: repos.join(delimiter),
        GITTY_BENCH_ITERATIONS: String(iterations),
        GITTY_BENCH_OUT: out,
      },
    });
    return JSON.parse(await readFile(out, 'utf8'));
  };

  // A worktree whose directory was deleted by hand stays registered and makes
  // `add` fail with "missing but already registered"; prune clears it first.
  const removeWorktree = () => {
    try { git('worktree', 'remove', '--force', worktree); } catch { /* not registered */ }
  };
  removeWorktree();
  git('worktree', 'prune');
  git('worktree', 'add', '--detach', worktree, baseline);
  try {
    console.log(`\nBackend: ${repos.length} fixture(s), ${iterations} iteration(s), release build`);
    console.log('Building and running the baseline worktree…');
    const before = await run(worktree, join(results, `compare-${short}-${stamp}.json`));
    console.log('Building and running the current tree…');
    const now = await run(root, join(results, `compare-head-${stamp}.json`));
    const cell = result => result?.error ? 'error' : result ? `${ms(median(result.millis))} (${result.spawns} git)` : null;
    for (let index = 0; index < now.length; index++) {
      const older = before[index];
      if (!older) continue;
      // Scenarios come from the result itself, so a rename cannot silently drop a row.
      const scenarios = Object.keys(older.results ?? {});
      console.log(`\n${older.path}`);
      console.log(table(
        ['Scenario', `baseline ${short}`, 'current', 'wall', 'git processes'],
        scenarios.map(name => {
          const a = older.results?.[name], b = now[index].results?.[name];
          const change = a && b && !a.error && !b.error ? factor(median(a.millis), median(b.millis)) : null;
          const spawns = a && b ? `${a.spawns} → ${b.spawns} (${b.spawns - a.spawns})` : null;
          return [name, cell(a), cell(b), change, spawns];
        }),
      ));
    }
    saved.backend = { baseline: before, current: now };
    console.log('\nWall time is a median; the parenthesised number and the last column are Git processes launched, which are deterministic per scenario.');
    console.log('The current tree also builds with the thin-LTO release profile, so timings include that change.');
  } finally {
    removeWorktree();
  }
}

if (!args['skip-frontend']) await frontend();
if (!args['skip-backend']) {
  try {
    await backend();
  } catch (error) {
    console.log(`\nBackend comparison failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (Object.keys(saved).length) {
  const out = join(benchDir(), 'results', `compare-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await mkdir(join(benchDir(), 'results'), { recursive: true });
  await writeFile(out, JSON.stringify({ baseline, head: headSha, iterations, ...saved }, null, 2));
  console.log(`\nRaw results: ${out}`);
}
