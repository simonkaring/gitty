// Focused DOM → IPC smoke. Git patch/byte correctness lives in the real Rust tests.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node src/components/hunks.smoke.mjs
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = await createServer({ server: { host: '127.0.0.1', port: 5189, strictPort: false }, logLevel: 'error' });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.isTauri = true;
    const path = 'src/two edits.ts';
    const handle = 'hunks-session';
    const location = { kind: 'native', path: '/workspace/hunks' };
    const f = window.hunksFixture = {
      calls: [], unexpected: [], version: 0, head: 'c0', index: [], committed: [],
      rejectNext: false, externalEdit: false, holdRefresh: false, refreshWaiting: false,
    };
    const remaining = () => ['alpha', 'beta'].filter(id => !f.index.includes(id) && !f.committed.includes(id));
    const fingerprint = kind => `${kind}:${f.version}`;
    const commit = id => ({ id, parents: id === 'c0' ? [] : ['c0'], subject: id === 'c0' ? 'Base commit' : 'feat: selected alpha', body: '', author: 'Smoke', email: 'smoke@example.test', timestamp: 1700000000 });
    const state = () => ({
      session: { handle, location, name: 'hunks', root: location.path, gitDir: `${location.path}/.git`, commonDir: `${location.path}/.git`, head: f.head, headRef: 'refs/heads/main', shallow: false, bare: false, linkedWorktree: false },
      refs: [{ name: 'main', fullName: 'refs/heads/main', commitId: f.head, kind: 'local' }], remotes: [], fingerprint: f.head,
    });
    const entry = (file, staged = false, unstaged = true) => ({ path: file, oldPath: null, indexStatus: staged ? 'M' : '.', worktreeStatus: unstaged ? 'M' : '.', conflicted: false, untracked: false });
    const hunk = id => {
      const line = id === 'alpha' ? 2 : 42;
      return { header: `@@ -${line},1 +${line},1 @@`, lines: [
        { kind: 'remove', content: `${id} before`, oldLine: line, newLine: null },
        { kind: 'add', content: `${id} edited${id === 'beta' && f.externalEdit ? ' externally' : ''}`, oldLine: null, newLine: line },
      ] };
    };
    window.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
      f.calls.push({ command, args: structuredClone(args) });
      if (command === 'repository_recent') return [location];
      if (command === 'wsl_distributions') return [];
      if (command === 'repository_open' || command === 'repository_state') return state();
      if (command === 'repository_close') return;
      if (command === 'repository_sync_info') return { branch: 'main', upstream: null, ahead: null, behind: null, remotes: [] };
      if (command === 'repository_operation_state') return { kind: 'none', label: '', current: 'main', incoming: null, step: null, total: null, conflicts: [], canContinue: false, canSkip: false, fingerprint: 'no-operation' };
      if (command === 'repository_status') {
        if (f.holdRefresh) {
          f.refreshWaiting = true;
          await new Promise(resolve => { f.releaseRefresh = resolve; });
          f.refreshWaiting = false;
        }
        return { head: f.head, headRef: 'refs/heads/main', fingerprint: String(f.version), entries: [entry(path, !!f.index.length, !!remaining().length), entry('mode.txt'), entry('large.txt')] };
      }
      if (command === 'repository_history') return { commits: f.head === 'c0' ? [commit('c0')] : [commit(f.head), commit('c0')], cursor: null, generation: `history:${f.head}`, shallow: false };
      if (command === 'repository_commit') return commit(args.oid);
      if (command === 'repository_diff_files') return []; // Historical inspector is outside this smoke's scope.
      if (command === 'repository_diff') {
        const kind = args.spec.kind;
        if (args.path === 'mode.txt' || args.path === 'large.txt') {
          const truncated = args.path === 'large.txt';
          return { path: args.path, binary: false, truncated, message: null, hunks: [hunk('alpha')], hunkAction: { fingerprint: null, reason: truncated ? 'Hunk actions are unavailable for truncated previews. Use the whole-file buttons or Git.' : 'Hunk actions require unchanged file mode. Use the whole-file buttons or Git.' } };
        }
        if (args.path === path && ['staged', 'unstaged'].includes(kind)) {
          return { path, binary: false, truncated: false, message: null, hunks: (kind === 'staged' ? f.index : remaining()).map(hunk), hunkAction: { fingerprint: fingerprint(kind), reason: null } };
        }
      }
      if (command === 'repository_stage_hunk' || command === 'repository_unstage_hunk') {
        const kind = command === 'repository_stage_hunk' ? 'unstaged' : 'staged';
        const candidates = kind === 'unstaged' ? remaining() : f.index;
        if (args.handle !== handle || args.path !== path || args.fingerprint !== fingerprint(kind) || !Number.isInteger(args.hunkIndex) || !candidates[args.hunkIndex]) {
          f.unexpected.push({ command, args });
          throw new Error('Invalid hunk IPC identity');
        }
        if (f.rejectNext) {
          f.rejectNext = false; f.externalEdit = true; f.version++; f.holdRefresh = true;
          throw { code: 'staleDiff', message: 'The diff or index changed. Refresh the preview and select the hunk again.' };
        }
        const id = candidates[args.hunkIndex];
        f.index = kind === 'unstaged' ? [...f.index, id] : f.index.filter(item => item !== id);
        f.version++;
        return;
      }
      if (command === 'repository_create_commit') {
        if (!f.index.length) throw new Error('Nothing staged');
        f.committed.push(...f.index); f.index = []; f.head = 'c1'; f.version++;
        return { oid: f.head };
      }
      // Fail unknown commands even when application error handling catches them.
      f.unexpected.push({ command, args });
      throw new Error(`Unexpected command ${command}`);
    } };
  });

  const path = 'src/two edits.ts';
  const handle = 'hunks-session';
  const button = name => page.getByRole('button', { name, exact: true });
  const preview = page.getByRole('region', { name: 'Working file diff', exact: true });
  const writes = () => page.evaluate(() => window.hunksFixture.calls.filter(call => ['repository_stage_hunk', 'repository_unstage_hunk', 'repository_create_commit'].includes(call.command)));
  const expectedHunk = (command, hunkIndex, fingerprint) => ({ command, args: { handle, path, hunkIndex, fingerprint } });

  await page.goto(server.resolvedUrls.local[0]);
  await button('Open repository').click();
  await button('Native /workspace/hunks').click();
  await page.getByRole('listbox', { name: 'Commit history' }).waitFor();
  await page.getByRole('button', { name: /Working changes/ }).click();
  await button(`Stage hunk 2 in ${path}`).waitFor();
  assert.equal(await preview.locator('.native-diff').getAttribute('aria-label'), `Unified diff for ${path}`);
  assert.equal(await preview.getByRole('button', { name: /^Stage hunk/ }).count(), 2);

  // The second unified hunk must route index 1, not the first hunk or whole file.
  await button(`Stage hunk 2 in ${path}`).click();
  await page.getByText('Selected changes staged.', { exact: true }).waitFor();
  assert.deepEqual(await writes(), [expectedHunk('repository_stage_hunk', 1, 'unstaged:0')]);
  await button(`Staged: ${path}`).waitFor();
  await button(`Unstaged: ${path}`).waitFor();
  assert.equal(await page.getByText('Partially staged', { exact: true }).count(), 2);
  assert.equal(await preview.getByRole('button', { name: /^Stage hunk/ }).count(), 1);
  await button(`Staged: ${path}`).click();
  await button(`Unstage hunk 1 in ${path}`).waitFor();
  assert.match(await preview.innerText(), /beta edited/);
  assert.doesNotMatch(await preview.innerText(), /alpha edited/);
  await button(`Unstage hunk 1 in ${path}`).click();
  await page.getByText('Selected changes unstaged.', { exact: true }).waitFor();
  assert.deepEqual((await writes()).at(-1), expectedHunk('repository_unstage_hunk', 0, 'staged:1'));
  assert.equal(await button(`Staged: ${path}`).count(), 0);
  await button(`Stage hunk 2 in ${path}`).waitFor();

  await button('Side by side').click();
  assert.equal(await preview.locator('.native-diff').getAttribute('aria-label'), `Side-by-side diff for ${path}`);
  assert.ok(await preview.locator('.split-row').count());
  await page.getByRole('textbox', { name: /Summary/ }).fill('feat: selected alpha');

  // A stale rejection must reconcile and clear the prior success, without retrying.
  await page.evaluate(() => { window.hunksFixture.rejectNext = true; });
  await button(`Stage hunk 1 in ${path}`).click();
  await page.waitForFunction(() => window.hunksFixture.refreshWaiting);
  assert.equal(await button('Stage all').isDisabled(), true);
  assert.equal(await button('Commit staged changes').isDisabled(), true);
  assert.equal(await page.getByText(/^Selected changes (un)?staged\.$/).count(), 0);
  await page.evaluate(() => { window.hunksFixture.holdRefresh = false; window.hunksFixture.releaseRefresh(); });
  await page.getByRole('alert').filter({ hasText: 'The diff or index changed.' }).waitFor();
  await button(`Stage hunk 2 in ${path}`).waitFor();
  assert.match(await preview.innerText(), /beta edited externally/);
  assert.equal(await page.getByRole('textbox', { name: /Summary/ }).inputValue(), 'feat: selected alpha');
  assert.equal(await page.getByText(/^Selected changes (un)?staged\.$/).count(), 0);
  assert.equal((await writes()).length, 3);
  const staleCalls = await page.evaluate(() => {
    const calls = window.hunksFixture.calls;
    return calls.slice(calls.findLastIndex(call => call.command === 'repository_stage_hunk'));
  });
  assert.deepEqual(staleCalls[0], expectedHunk('repository_stage_hunk', 0, 'unstaged:2'));
  const refreshIndex = staleCalls.findIndex(call => call.command === 'repository_status');
  assert.ok(refreshIndex > 0, 'stale write must trigger a status refresh');
  assert.ok(staleCalls.findIndex(call => call.command === 'repository_diff' && call.args.path === path) > refreshIndex, 'fresh preview must follow reconciliation');

  // The fresh split-view callback must use the replacement fingerprint.
  await button(`Stage hunk 1 in ${path}`).click();
  await page.getByText('Selected changes staged.', { exact: true }).waitFor();
  assert.deepEqual((await writes()).at(-1), expectedHunk('repository_stage_hunk', 0, 'unstaged:3'));
  await button(`Staged: ${path}`).click();
  await button(`Unstage hunk 1 in ${path}`).waitFor();
  assert.match(await preview.innerText(), /alpha edited/);
  assert.doesNotMatch(await preview.innerText(), /beta edited/);
  await button('Commit staged changes').click();
  await page.getByText('Created commit c1.', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => ({ committed: window.hunksFixture.committed, index: window.hunksFixture.index })), { committed: ['alpha'], index: [] });
  assert.equal(await button(`Staged: ${path}`).count(), 0);
  await button(`Unstaged: ${path}`).click();
  await button(`Stage hunk 1 in ${path}`).waitFor();
  assert.match(await preview.innerText(), /beta edited externally/);
  assert.doesNotMatch(await preview.innerText(), /alpha edited/);
  assert.equal(await preview.getByRole('button', { name: /^Stage hunk/ }).count(), 1);
  assert.equal(await page.getByRole('textbox', { name: /Summary/ }).inputValue(), '');

  // Unsupported and incomplete previews offer whole-file fallback, not writes.
  for (const [file, reason] of [['mode.txt', /unchanged file mode/], ['large.txt', /truncated previews/]]) {
    await button(`Unstaged: ${file}`).click();
    const action = button(`Stage hunk 1 in ${file}`);
    await action.waitFor();
    assert.equal(await action.isDisabled(), true);
    assert.match(await preview.innerText(), reason);
    assert.match(await preview.innerText(), /whole-file buttons or Git/);
    assert.equal(await button(`Stage ${file}`).isEnabled(), true);
    await action.evaluate(element => element.click());
  }
  assert.deepEqual(await writes(), [
    expectedHunk('repository_stage_hunk', 1, 'unstaged:0'),
    expectedHunk('repository_unstage_hunk', 0, 'staged:1'),
    expectedHunk('repository_stage_hunk', 0, 'unstaged:2'),
    expectedHunk('repository_stage_hunk', 0, 'unstaged:3'),
    { command: 'repository_create_commit', args: { handle, message: 'feat: selected alpha' } },
  ]);
  assert.deepEqual(await page.evaluate(() => window.hunksFixture.unexpected), []);
  assert.deepEqual(errors, []);
  console.log('Hunk browser smoke passed (mocked IPC): unified/split exact hunk routing; partial staging; staged inspection and unstage; stale refresh without retry/false success; selected-only fixture commit; unsupported/truncated disabled fallback.');
} finally {
  try { await browser?.close(); } finally { await server.close(); }
}
