import assert from 'node:assert/strict';
import { execFile as execFileCb } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { isolatedEnvironment } from './environment.mjs';

const execFile = promisify(execFileCb);

test('poisoned Git environment cannot redirect disposable fixture writes or inject config', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'gitty-env-test-'));
  try {
    const decoy = path.join(temp, 'decoy');
    const fixture = path.join(temp, 'fixture');
    const home = path.join(temp, 'home');
    const hooks = path.join(temp, 'injected-hooks');
    await Promise.all([mkdir(decoy), mkdir(fixture), mkdir(home), mkdir(hooks)]);

    const clean = isolatedEnvironment(process.env, {
      HOME: home,
      USERPROFILE: home,
      GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'),
      GIT_CONFIG_SYSTEM: path.join(home, 'system-gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
    });
    const git = async (cwd, args, env = clean) =>
      (await execFile('git', ['-C', cwd, ...args], { env })).stdout.trimEnd();

    await execFile('git', ['init', '-b', 'main', decoy], { env: clean });
    await git(decoy, ['config', 'user.name', 'Decoy']);
    await git(decoy, ['config', 'user.email', 'decoy@example.invalid']);
    await writeFile(path.join(decoy, 'keep.txt'), 'decoy stays unchanged\n');
    await git(decoy, ['add', 'keep.txt']);
    await git(decoy, ['commit', '-m', 'decoy base']);
    const decoyHead = await git(decoy, ['rev-parse', 'HEAD']);

    const sentinel = path.join(temp, 'hook-ran');
    await writeFile(
      path.join(hooks, 'pre-commit'),
      `#!/bin/sh\nprintf invoked > '${sentinel.replaceAll('\\', '/')}'\n`,
      { mode: 0o755 },
    );
    const poisoned = isolatedEnvironment({
      ...process.env,
      gIt_DiR: path.join(decoy, '.git'),
      GIT_WORK_TREE: decoy,
      GIT_INDEX_FILE: path.join(temp, 'redirected-index'),
      GIT_OBJECT_DIRECTORY: path.join(decoy, '.git', 'objects'),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: hooks,
      GITTY_E2E: 'attacker-override',
      GITTY_E2E_STATE_FILE: path.join(temp, 'important-user-file'),
      GITTY_TEST_TOKEN: 'attacker-secret',
      GITTY_ASKPASS_TOKEN: 'attacker-askpass',
      EDITOR: 'attacker-editor',
      GIT_EDITOR: 'attacker-git-editor',
    }, {
      HOME: home,
      USERPROFILE: home,
      GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'),
      GIT_CONFIG_SYSTEM: path.join(home, 'system-gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
    });
    assert.equal(poisoned.GIT_DIR, undefined);
    assert.equal(poisoned.gIt_DiR, undefined);
    assert.equal(poisoned.GIT_CONFIG_COUNT, undefined);
    assert.equal(poisoned.GITTY_TEST_TOKEN, undefined);
    assert.equal(poisoned.GITTY_ASKPASS_TOKEN, undefined);
    assert.equal(poisoned.GITTY_E2E_STATE_FILE, undefined);
    assert.equal(poisoned.EDITOR, undefined);

    await execFile('git', ['init', '-b', 'main', fixture], { env: poisoned });
    await git(fixture, ['config', 'user.name', 'Fixture'], poisoned);
    await git(fixture, ['config', 'user.email', 'fixture@example.invalid'], poisoned);
    await writeFile(path.join(fixture, 'tracked.txt'), 'fixture content\n');
    await git(fixture, ['add', 'tracked.txt'], poisoned);
    await git(fixture, ['commit', '-m', 'fixture commit'], poisoned);

    assert.equal(path.resolve(await git(fixture, ['rev-parse', '--show-toplevel'], poisoned)), fixture);
    assert.equal(await git(fixture, ['config', '--get', 'core.hooksPath'], poisoned).catch(() => ''), '');
    assert.equal(await git(decoy, ['rev-parse', 'HEAD']), decoyHead);
    assert.equal(await readFile(path.join(decoy, 'keep.txt'), 'utf8'), 'decoy stays unchanged\n');
    assert.equal(await readFile(path.join(fixture, 'tracked.txt'), 'utf8'), 'fixture content\n');
    await assert.rejects(readFile(path.join(temp, 'hook-ran')));
    await assert.rejects(readFile(path.join(temp, 'redirected-index')));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
