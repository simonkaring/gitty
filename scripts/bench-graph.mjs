#!/usr/bin/env node
// Standalone graph layout benchmark and equivalence check. See docs/perf-graph-experiments.md.
//
//   node scripts/bench-graph.mjs [--baseline <git-ref|path>] [--candidate <path>] [--runs N] [--json file]
//                                [--only substring] [--no-verify]
//
// Both layouts are bundled from TypeScript with esbuild (a Vite dependency) into a temp
// directory. The default baseline is `git show HEAD:src/graph/layout.ts` and the default
// candidate is the working-tree src/graph/layout.ts. Workloads are generated from a fixed seed.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const runs = Number(opt('runs', 9));
const only = opt('only', '');
const baselineSpec = opt('baseline', 'HEAD');
const candidatePath = resolve(root, opt('candidate', 'src/graph/layout.ts'));
const jsonOut = opt('json', '');
const verify = !args.includes('--no-verify');

// ---------- workloads (deterministic) ----------
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const idOf = n => createHash('sha1').update(`gitty-bench-${n}`).digest('hex');

/** `made` is oldest-first creation order; reversing it gives a valid child-before-parent walk. */
function finish(made) { return made.map(c => ({ id: idOf(c.n), parents: c.parents.map(idOf) })).reverse(); }

function linear(count) {
  const made = [];
  for (let n = 0; n < count; n++) made.push({ n, parents: n ? [n - 1] : [] });
  return finish(made);
}

/** Mirrors scripts/bench/fixtures.mjs synthetic(): main, 2-commit topics merged back after a main commit every
 * `mergeEvery` commits, then `openBranches` unmerged one-commit branches created last (newest) off bases spread over history. */
function fixtureLike(count, mergeEvery, openBranches) {
  const made = []; let n = 0;
  const add = parents => { made.push({ n, parents }); return n++; };
  let tip = add([]);
  while (n < count) {
    if (mergeEvery && n % mergeEvery === 0 && n + 4 < count) {
      let side = add([tip]); side = add([side]);
      tip = add([tip]);
      tip = add([tip, side]);
    } else tip = add([tip]);
  }
  const total = n;
  for (let b = 0; b < openBranches; b++) add([Math.max(1, total - Math.floor((b + 1) * (total / (openBranches + 1))))]);
  return finish(made);
}

/** K concurrently active branches that fork and merge randomly, with occasional octopus merges. */
function braided(count, maxActive, seed) {
  const rand = rng(seed); const made = []; const active = [];
  let n = 0;
  const add = parents => { made.push({ n, parents }); return n++; };
  active.push(add([]));
  while (n < count) {
    const i = Math.floor(rand() * active.length); const r = rand();
    if (r < 0.10 && active.length < maxActive) { active.push(add([active[i]])); }
    else if (r < 0.20 && active.length > 1) {
      let j = Math.floor(rand() * active.length); if (j === i) j = (j + 1) % active.length;
      const parents = [active[i], active[j]];
      if (rand() < 0.1 && active.length > 2) { let k = Math.floor(rand() * active.length); if (k !== i && k !== j) parents.push(active[k]); }
      const merged = add([...new Set(parents)]);
      const drop = new Set(parents.slice(1).map(p => active.indexOf(p)));
      const keep = active.filter((_, idx) => idx !== i && !drop.has(idx));
      active.length = 0; active.push(...keep, merged);
    } else active[i] = add([active[i]]);
  }
  return finish(made);
}

const workloads = [
  { name: 'linear-100k', commits: linear(100_000) },
  { name: 'fixture-100k-300open', commits: fixtureLike(100_000, 25, 300) },
  { name: 'braided-50k-w16', commits: braided(50_000, 16, 7) },
  { name: 'braided-50k-w64', commits: braided(50_000, 64, 11) },
  { name: 'braided-50k-w256', commits: braided(50_000, 256, 13) },
  { name: 'fixture-2k-small', commits: fixtureLike(2_000, 50, 10) },
];
const pagedTargets = [
  { name: 'fixture-100k-300open', rows: 10_000, page: 200 },
  { name: 'braided-50k-w64', rows: 10_000, page: 200 },
];

// ---------- module loading ----------
const temp = mkTemp();
function mkTemp() { return mkdtempSync(join(tmpdir(), 'gitty-bench-graph-')); }
async function load(label, entry) {
  const outfile = join(temp, `${label}.mjs`);
  await build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node22', logLevel: 'error' });
  return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
}
let baselineEntry;
if (existsSync(resolve(root, baselineSpec)) && baselineSpec !== 'HEAD') baselineEntry = resolve(root, baselineSpec);
else {
  baselineEntry = join(temp, 'baseline-layout.ts');
  writeFileSync(baselineEntry, execFileSync('git', ['show', `${baselineSpec}:src/graph/layout.ts`], { cwd: root, maxBuffer: 1 << 26 }));
}
const base = await load('baseline', baselineEntry);
const cand = await load('candidate', candidatePath);

// ---------- helpers ----------
const rssGc = () => { if (global.gc) global.gc(); };
function time(fn) {
  rssGc();
  const t0 = performance.now(); const result = fn(); const t1 = performance.now();
  return { ms: t1 - t0, result };
}
function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  return { min: s[0], median: s[s.length >> 1], max: s[s.length - 1] };
}
function measure(fn, n = runs) {
  fn(); // warm-up
  const samples = []; for (let i = 0; i < n; i++) samples.push(time(fn).ms);
  return stats(samples);
}
const fmt = x => x.toFixed(2).padStart(9);

function pagedRun(mod, commits, rows, page) {
  const state = mod.createLayoutState();
  let last;
  for (let at = 0; at < rows; at += page) {
    last = mod.appendHistory(state, commits.slice(at, at + page));
    mod.buildEdgeIndex(last.edges); // the worker does this after every page
  }
  return last;
}

// ---------- equivalence ----------
const failures = [];
function check(label, a, b) { if (!isDeepStrictEqual(a, b)) { failures.push(label); console.error(`  MISMATCH ${label}`); } }
function verifyWorkload(w) {
  const a = base.layoutHistory(w.commits); const b = cand.layoutHistory(w.commits);
  check(`${w.name}: nodes`, a.nodes, b.nodes);
  check(`${w.name}: edges`, a.edges, b.edges);
  check(`${w.name}: laneCount`, a.laneCount, b.laneCount);
  check(`${w.name}: edgeMaxTo`, a.edgeMaxTo, b.edgeMaxTo);
  const qa = base.indexEdges(a.edges, a.edgeMaxTo); const qb = cand.indexEdges(b.edges, b.edgeMaxTo);
  for (let row = -20; row < w.commits.length + 40; row += Math.max(1, Math.floor(w.commits.length / 400)) + 3) {
    check(`${w.name}: indexEdges(${row})`, qa(row, row + 30), qb(row, row + 30));
  }
}
function verifyPaged(w, rows, page) {
  const sa = base.createLayoutState(); const sb = cand.createLayoutState();
  for (let at = 0; at < rows; at += page) {
    const chunk = w.commits.slice(at, at + page);
    const ra = base.appendHistory(sa, chunk); const rb = cand.appendHistory(sb, chunk);
    const tag = `${w.name}: page@${at}`;
    check(`${tag} layout`, ra, rb);
    check(`${tag} lastResolved`, sa.lastResolved, sb.lastResolved);
    check(`${tag} edgeMaxTo`, base.buildEdgeIndex(ra.edges), cand.buildEdgeIndex(rb.edges));
    if (failures.length > 10) break;
  }
}
function verifyErrors() {
  const cases = [
    [{ id: 'a', parents: ['a'] }],
    [{ id: 'a', parents: [] }, { id: 'a', parents: [] }],
    [{ id: 'a', parents: [] }, { id: 'b', parents: ['a'] }],
    [{ id: 'a', parents: ['c', 'b', 'c'] }, { id: 'b', parents: ['c'] }, { id: 'o', parents: [] }, { id: 'c', parents: ['missing'] }],
    [],
  ];
  const run = (mod, commits) => { try { return mod.layoutHistory(commits); } catch (e) { return `throws:${e.message}`; } };
  cases.forEach((c, i) => check(`edge case ${i}`, run(base, c), run(cand, c)));
}

// ---------- run ----------
console.log(`baseline: ${baselineSpec}:src/graph/layout.ts   candidate: ${candidatePath}`);
console.log(`node ${process.version} ${process.platform}/${process.arch}, runs=${runs}${global.gc ? ', gc exposed' : ''}`);
const results = { node: process.version, platform: `${process.platform}/${process.arch}`, runs, baseline: baselineSpec, scenarios: {} };

if (verify) {
  console.log('\nverifying semantic equivalence ...');
  for (const w of workloads) { verifyWorkload(w); }
  for (const p of pagedTargets) verifyPaged(workloads.find(w => w.name === p.name), p.rows, p.page);
  verifyPaged({ name: 'fixture-2k-small', commits: workloads.at(-1).commits }, 2000, 37);
  verifyErrors();
  if (failures.length) { console.error(`\nFAILED: ${failures.length} mismatches`); process.exit(1); }
  console.log('equivalent: nodes, edges, laneCount, edgeMaxTo, indexEdges, per-page snapshots, lastResolved, error cases');
}

function report(name, a, b) {
  const delta = ((b.median / a.median - 1) * 100).toFixed(1);
  console.log(`${name.padEnd(46)} base ${fmt(a.median)} (min ${fmt(a.min)})  cand ${fmt(b.median)} (min ${fmt(b.min)})  ${delta.padStart(7)}% median`);
  results.scenarios[name] = { baseline: a, candidate: b, deltaMedianPct: Number(delta) };
}

console.log('\nworkloads');
for (const w of workloads) {
  const l = base.layoutHistory(w.commits);
  console.log(`  ${w.name.padEnd(24)} commits ${String(w.commits.length).padStart(7)}  edges ${String(l.edges.length).padStart(7)}  lanes ${l.laneCount}`);
}
console.log('\nms (median of runs after one warm-up; lower is better)');
// Interleave baseline/candidate samples so thermal and GC drift affect both alike.
function pair(name, fnBase, fnCand, n = runs) {
  fnBase(); fnCand();
  const sa = [], sb = [];
  for (let i = 0; i < n; i++) {
    if (i % 2) { sb.push(time(fnCand).ms); sa.push(time(fnBase).ms); } else { sa.push(time(fnBase).ms); sb.push(time(fnCand).ms); }
  }
  report(name, stats(sa), stats(sb));
}
for (const w of workloads) {
  if (only && !w.name.includes(only)) continue;
  pair(`layoutHistory ${w.name}`, () => base.layoutHistory(w.commits), () => cand.layoutHistory(w.commits), w.commits.length > 20_000 ? runs : runs * 3);
}
for (const p of pagedTargets) {
  if (only && !p.name.includes(only)) continue;
  const w = workloads.find(x => x.name === p.name);
  pair(`paged append+index ${p.name} ${p.rows}x${p.page}`, () => pagedRun(base, w.commits, p.rows, p.page), () => pagedRun(cand, w.commits, p.rows, p.page));
}
for (const w of workloads.filter(x => ['fixture-100k-300open', 'braided-50k-w64'].includes(x.name))) {
  if (only && !w.name.includes(only)) continue;
  const la = base.layoutHistory(w.commits); const lb = cand.layoutHistory(w.commits);
  pair(`buildEdgeIndex ${w.name}`, () => base.buildEdgeIndex(la.edges), () => cand.buildEdgeIndex(lb.edges));
  const qa = base.indexEdges(la.edges, la.edgeMaxTo); const qb = cand.indexEdges(lb.edges, lb.edgeMaxTo);
  const step = Math.floor(w.commits.length / 500);
  const scan = q => () => { let n = 0; for (let row = 0; row < w.commits.length; row += step) n += q(row, row + 30).length; return n; };
  pair(`indexEdges 500 viewports ${w.name}`, scan(qa), scan(qb));
}
if (jsonOut) writeFileSync(resolve(root, jsonOut), JSON.stringify(results, null, 2));
rmSync(temp, { recursive: true, force: true });
