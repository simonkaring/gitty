import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { arch, cpus, release, totalmem } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchDir, median, ms, parseArgs, table } from './common.mjs';

const usage = `npm run bench:apps:windows -- --gitty <gitty.exe> --gitcraft <gitcraft.exe>
  [--dir <fixture/output root>] [--repos <path,path>] [--runs 3]
  [--observe 8] [--idle 10] [--timeout 30]

Use release executables and an unlocked desktop. Close both apps yourself.
Durations are in seconds. See README.md for profile and measurement caveats.`;

function machineInfo() {
  const fallback = { windows: release(), arch: arch(), cpu: cpus()[0]?.model, memoryBytes: totalmem() };
  try {
    const command = `
      $ErrorActionPreference = 'Stop'
      $system = Get-CimInstance Win32_ComputerSystem
      $os = Get-CimInstance Win32_OperatingSystem
      $processors = @(Get-CimInstance Win32_Processor)
      [pscustomobject]@{
        manufacturer = $system.Manufacturer
        model = $system.Model
        hypervisorPresent = $system.HypervisorPresent
        logicalProcessors = $system.NumberOfLogicalProcessors
        cores = ($processors | Measure-Object NumberOfCores -Sum).Sum
        edition = $os.Caption
        build = $os.BuildNumber
        displayAdapters = @(Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion)
      } | ConvertTo-Json -Depth 4 -Compress`;
    const details = JSON.parse(execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${command}`,
    ], { encoding: 'utf8', timeout: 15_000 }));
    return { ...fallback, ...details, cpu: fallback.cpu?.trim() };
  } catch (error) {
    console.warn(`Could not read detailed Windows machine specs: ${error.message}`);
    return fallback;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(usage);
  if (process.platform !== 'win32') throw new Error('This comparison runs on Windows only.');
  for (const [key, value] of Object.entries(args)) {
    if (!['gitty', 'gitcraft', 'dir', 'repos', 'runs', 'observe', 'idle', 'timeout'].includes(key) || typeof value !== 'string') {
      throw new Error(`Unknown option or missing value: --${key}`);
    }
  }
  const integer = (key, fallback, min, max) => {
    const n = Number(args[key] ?? fallback);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${key} must be an integer in ${min}–${max}`);
    return n;
  };
  const runs = integer('runs', 3, 1, 50);
  const observe = integer('observe', 8, 3, 300);
  const idle = integer('idle', 10, 1, 300);
  const timeout = integer('timeout', 30, 1, 300);
  const dir = resolve(args.dir ?? benchDir());
  const apps = await Promise.all(['gitty', 'gitcraft'].map(async key => {
    const candidate = args[key] ?? (key === 'gitty' ? 'target/release/gitty.exe' : null);
    if (!candidate || !candidate.toLowerCase().endsWith('.exe') || !existsSync(candidate)) {
      throw new Error(`Supply --${key} with the path to its release executable (not its installer).`);
    }
    const exe = await realpath(candidate);
    if (!(await stat(exe)).isFile()) throw new Error(`Not a file: ${exe}`);
    const binary = await readFile(exe);
    return { key, exe, bytes: binary.length, sha256: createHash('sha256').update(binary).digest('hex') };
  }));
  if (apps[0].exe.toLowerCase() === apps[1].exe.toLowerCase() || apps[0].sha256 === apps[1].sha256) {
    throw new Error('Supply two different executables.');
  }
  const candidates = args.repos
    ? args.repos.split(',')
    : ['small', 'large-history', 'wide-status', 'git-git'].map(name => join(dir, 'repos', name)).filter(existsSync);
  if (!candidates.length) throw new Error('No repositories found: run npm run bench:fixtures or pass --repos.');
  const repos = await Promise.all(candidates.map(async candidate => {
    if (!candidate || !existsSync(join(candidate, '.git'))) throw new Error(`Not a repository root: ${candidate}`);
    return realpath(candidate);
  }));
  if (new Set(repos.map(path => path.toLowerCase())).size !== repos.length) throw new Error('Duplicate repository path.');

  const probe = fileURLToPath(new URL('./probe-windows.ps1', import.meta.url));
  const compareNames = [...new Set(['gitty', 'gitcraft', ...apps.map(app => basename(app.exe).slice(0, -4))])].join(',');
  const report = {
    date: new Date().toISOString(),
    machine: machineInfo(),
    git: execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(),
    settings: { runs, observe, idle, timeout, profile: 'current Windows user' },
    apps, results: [],
  };
  for (const repo of repos) {
    for (let run = 0; run <= runs; run++) {
      // Warm both apps, then alternate order to reduce file-cache and order bias.
      for (const app of run % 2 ? [...apps].reverse() : apps) {
        console.log(`${app.key} · ${basename(repo)} · ${run ? `run ${run}` : 'warm-up'}`);
        const output = execFileSync('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe,
          '-Exe', app.exe, '-Repo', repo, '-CompareNames', compareNames,
          '-ObserveSeconds', String(observe), '-IdleSeconds', String(idle), '-TimeoutSeconds', String(timeout),
        ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
        const result = JSON.parse(output);
        console.log(`  Window ${ms(result.windowMs)}, visual settling ${ms(result.visualSettledMs) ?? 'unavailable'}, private memory ${Math.round(result.memory.privateBytes / 2 ** 20)} MiB`);
        if (result.missedFrames) console.warn(`  Missed ${result.missedFrames} screen samples; keep the window unobstructed on an unlocked desktop.`);
        if (run) report.results.push({ app: app.key, repo, run, ...result });
      }
    }
  }

  const results = join(dir, 'results');
  await mkdir(results, { recursive: true });
  const out = join(results, `apps-windows-${report.date.replace(/[:.]/g, '-')}.json`);
  await writeFile(out, JSON.stringify(report, null, 2));
  const pick = (app, repo, get) => {
    const values = report.results.filter(r => r.app === app.key && r.repo === repo).map(get).filter(Number.isFinite);
    return values.length ? { value: median(values), count: values.length } : null;
  };
  const metrics = [
    ['First visible window', r => r.windowMs, ms],
    ['Visual settling (not readiness)', r => r.visualSettledMs, ms],
    ['Private memory', r => r.memory.privateBytes, n => `${(n / 2 ** 20).toFixed(1)} MiB`],
    ['Working set (shared pages may repeat)', r => r.memory.workingSetBytes, n => `${(n / 2 ** 20).toFixed(1)} MiB`],
    ['Idle CPU (% of one core)', r => r.idleCpuPercent, n => `${n.toFixed(1)}%`],
  ];
  const rows = repos.flatMap((repo, i) =>
    metrics.map(([label, get, format], j) => [j ? '' : `${basename(repo)} (${i + 1})`, label, ...apps.map(app => {
      const result = pick(app, repo, get);
      return result && `${format(result.value)} (${result.count}/${runs})`;
    })]));
  console.log(`\n${table(['Repository', 'Metric (median)', ...apps.map(app => app.key)], rows)}`);
  console.log(`Raw results: ${out}`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
