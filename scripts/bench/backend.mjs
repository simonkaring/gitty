// Times Gitty's native backend against the benchmark repositories.
//
//   node scripts/bench/backend.mjs [--repos a,b,c] [--iterations 5] [--dir <path>]
//
// Builds the ignored `bench_tests::backend_benchmark` test in release mode and
// runs it against each repository (defaults: every fixture from fixtures.mjs).
// Results are written to <dir>/results/backend-<timestamp>.json.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, delimiter, join, resolve } from 'node:path';
import { benchDir, median, ms, parseArgs, table } from './common.mjs';

const args = parseArgs(process.argv.slice(2));
const dir = args.dir ?? benchDir();
const fixtures = join(dir, 'repos');
const repos = typeof args.repos === 'string'
  ? args.repos.split(',').map(path => resolve(path))
  : existsSync(fixtures) ? readdirSync(fixtures).map(name => join(fixtures, name)) : [];
if (!repos.length) throw new Error('No repositories: run `npm run bench:fixtures` or pass --repos');
await mkdir(join(dir, 'results'), { recursive: true });
const out = join(dir, 'results', `backend-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

execFileSync('cargo', ['test', '--release', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', 'bench_tests::backend_benchmark', '--', '--ignored', '--exact', '--nocapture'], {
  stdio: 'inherit',
  env: { ...process.env, GITTY_BENCH_REPOS: repos.join(delimiter), GITTY_BENCH_ITERATIONS: String(args.iterations ?? 5), GITTY_BENCH_OUT: out },
});

const report = JSON.parse(await readFile(out, 'utf8'));
const scenarios = ['tabOpenTotal', 'open', 'snapshotRefresh', 'snapshotHistoryRefresh', 'state', 'status', 'historyFirstPage', 'history5000', 'commitDetail', 'commitEditEligibility', 'commitFiles', 'search', 'rawGitStatus', 'rawGitFirst200'];
const cell = result => result?.error ? 'error' : result ? `${ms(median(result.millis))} (${result.spawns})` : null;
console.log(`\nMedian wall time (Git processes launched)\n`);
console.log(table(['Scenario', ...report.map(repo => basename(repo.path))], scenarios.map(name => [name, ...report.map(repo => cell(repo.results?.[name]))])));
console.log(`\nRaw results: ${out}`);
