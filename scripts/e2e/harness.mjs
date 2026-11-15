import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isolatedEnvironment } from './environment.mjs';

const execFile = promisify(execFileCb);
const project = process.cwd();
const port = 4173;
const stateFile = path.join(project, 'test-results', 'e2e-fixture.json');
const root = await mkdtemp(path.join(tmpdir(), 'gitty-e2e-'));
const repository = path.join(root, 'repo');
const home = path.join(root, 'home');
const hooks = path.join(root, 'empty-hooks');
const globalConfig = path.join(home, 'gitconfig');
let vite;
let stopped = false;

async function stopTree() {
  if (!vite || vite.exitCode !== null) return;
  if (process.platform === 'win32') {
    try { await execFile('taskkill', ['/PID', String(vite.pid), '/T', '/F']); } catch { /* already exited */ }
  } else {
    try { process.kill(-vite.pid, 'SIGTERM'); } catch { vite.kill('SIGTERM'); }
  }
  await new Promise(resolve => {
    const timeout = setTimeout(() => resolve(), 5000);
    vite.once('exit', () => { clearTimeout(timeout); resolve(); });
  });
}

async function cleanup(exitCode = 0) {
  if (stopped) return;
  stopped = true;
  await stopTree();
  if (stateFile) await rm(stateFile, { force: true }).catch(() => {});
  await rm(root, { recursive: true, force: true });
  process.exit(exitCode);
}

process.once('SIGINT', () => void cleanup(130));
process.once('SIGTERM', () => void cleanup(0));

try {
  const baseEnv = isolatedEnvironment(process.env);
  await execFile('cargo', ['build', '--manifest-path', 'crates/gitty-cli/Cargo.toml', '--bin', 'gitty-cli'], {
    cwd: project,
    env: baseEnv,
  });
  await mkdir(repository, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(hooks, { recursive: true });
  const env = isolatedEnvironment(process.env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_SYSTEM: path.join(home, 'system-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GITTY_E2E: '1',
    GITTY_TEST_ROOT: repository,
    GITTY_TEST_PORT: String(port),
    GITTY_TEST_TOKEN: randomBytes(32).toString('hex'),
    GITTY_CLI_BIN: path.join(project, 'target', 'debug', process.platform === 'win32' ? 'gitty-cli.exe' : 'gitty-cli'),
    VITE_GITTY_TEST_MODE: '1',
  });
  const gitEnv = isolatedEnvironment(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_SYSTEM: path.join(home, 'system-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  });
  await execFile('git', ['init', '--initial-branch=main', repository], { env: gitEnv });
  await execFile('git', ['-C', repository, 'config', 'user.name', 'Gitty E2E'], { env: gitEnv });
  await execFile('git', ['-C', repository, 'config', 'user.email', 'gitty-e2e@example.invalid'], { env: gitEnv });
  await execFile('git', ['-C', repository, 'config', 'core.hooksPath', hooks], { env: gitEnv });
  await execFile('git', ['-C', repository, 'config', 'commit.gpgSign', 'false'], { env: gitEnv });
  await execFile('git', ['-C', repository, 'config', 'core.autocrlf', 'false'], { env: gitEnv });
  await writeFile(path.join(repository, 'tracked.txt'), 'base content\nstable line\n');
  await execFile('git', ['-C', repository, 'add', '--', 'tracked.txt'], { env: gitEnv });
  await execFile('git', ['-C', repository, 'commit', '-m', 'fixture base'], { env: gitEnv });
  const { stdout: initialHead } = await execFile('git', ['-C', repository, 'rev-parse', 'HEAD'], { env: gitEnv });
  await writeFile(path.join(repository, 'tracked.txt'), 'changed by the rendered app\nstable line\nextra working line\n');
  await writeFile(path.join(repository, 'keep-untracked.txt'), 'must remain uncommitted\n');
  const { stdout: version } = await execFile('git', ['--version'], { env: gitEnv });
  if (stateFile) {
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(stateFile, JSON.stringify({
      fixtureId: 'disposable-local-git',
      root: repository,
      initialHead: initialHead.trim(),
      gitVersion: version.trim(),
    }));
  }
  vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: project,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  vite.once('error', error => {
    console.error(`Could not start Vite: ${error.message}`);
    void cleanup(1);
  });
  vite.once('exit', code => {
    if (!stopped) void cleanup(code ?? 1);
  });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) throw new Error(`Vite exited with ${vite.exitCode}`);
    try {
      const response = await fetch(origin);
      if (response.ok) {
        console.log(`Gitty E2E ready: ${JSON.stringify({ url: origin, fixtureId: 'disposable-local-git', gitVersion: version.trim(), artifacts: path.join(project, 'test-results') })}`);
        break;
      }
    } catch { /* wait for Vite readiness */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (Date.now() >= deadline) throw new Error('Vite did not become ready within 60 seconds');
} catch (error) {
  console.error(`Gitty E2E harness failed: ${error.stack ?? error}`);
  await cleanup(1);
}
