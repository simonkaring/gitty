// Optional browser check of file discard, the file context menu and the refresh scope after writes.
// Mocked Tauri IPC; no native files touched. Needs an existing Playwright installation:
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node src/components/discard.smoke.mjs
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = await createServer({ server: { host: '127.0.0.1', port: 5188, strictPort: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const url = server.resolvedUrls.local[0];
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    window.isTauri = true;
    localStorage.setItem('gitty:theme', 'dark');
    const entry = (path, indexStatus, worktreeStatus, untracked = false) => ({ path, oldPath: null, indexStatus, worktreeStatus, untracked, conflicted: false });
    const f = window.fixture = { calls: [], unknown: [], version: 0, head: 'c0', entries: [entry('src/edited.ts', '.', 'M'), entry('src/partial.ts', 'M', 'M'), entry('fresh.md', '?', '?', true), entry('notes/also-new.txt', '?', '?', true)] };
    const commit = (id, parents = []) => ({ id, parents, subject: `Commit ${id}`, body: `Body ${id}`, author: 'Test Author', email: 't@example.test', timestamp: 1700000000 });
    const history = () => f.head === 'c0' ? [commit('c0')] : [commit(f.head, ['c0']), commit('c0')];
    const state = () => ({ session: { handle: 's', name: 'Fixture', location: { kind: 'native', path: '/fixture' }, root: '/fixture', gitDir: '/fixture/.git', commonDir: '/fixture/.git', head: f.head, headRef: 'refs/heads/main', shallow: false, bare: false, linkedWorktree: false }, refs: [{ name: 'main', fullName: 'refs/heads/main', commitId: f.head, kind: 'local' }], remotes: ['origin'], fingerprint: f.head });
    const status = () => ({ head: f.head, headRef: 'refs/heads/main', fingerprint: `v${f.version}`, entries: f.entries });
    const operation = () => ({ kind: 'none', label: '', current: 'main', incoming: null, step: null, total: null, conflicts: [], canContinue: false, canSkip: false, fingerprint: `op-v${f.version}` });
    let callbackId = 0;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } }, transformCallback: () => ++callbackId, unregisterCallback: () => {}, invoke: async (command, args = {}) => {
      f.calls.push({ command, args: JSON.parse(JSON.stringify(args)) });
      switch (command) {
        case 'plugin:event|listen': return 1;
        case 'plugin:event|unlisten': return;
        case 'repository_recent': return [{ kind: 'native', path: '/fixture' }];
        case 'wsl_distributions': case 'repository_stashes': return [];
        case 'repository_open': case 'repository_state': return state();
        case 'repository_close': return;
        case 'repository_operation_state': return operation();
        case 'repository_status': return status();
        case 'repository_snapshot': return { state: state(), status: status(), operation: operation() };
        case 'repository_history': return { commits: history(), cursor: null, generation: `g:${f.head}`, shallow: false };
        case 'repository_commit': return commit(args.oid);
        case 'repository_diff_files': return [];
        case 'repository_diff': return { path: args.path, hunks: [], binary: false, truncated: false, message: null };
        case 'repository_search': return { commits: [], truncated: false };
        case 'repository_sync_info': return { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, remotes: ['origin'] };
        case 'repository_remote_action': return { output: '' };
        case 'repository_stage': f.entries = f.entries.map(e => !args.paths.includes(e.path) ? e : { ...e, indexStatus: e.untracked ? 'A' : 'M', worktreeStatus: '.', untracked: false }); f.version++; return;
        case 'repository_unstage': f.entries = f.entries.map(e => !args.paths.includes(e.path) ? e : { ...e, indexStatus: '.', worktreeStatus: 'M' }); f.version++; return;
        case 'repository_discard':
          if (args.expectedStatusFingerprint !== `v${f.version}`) throw { code: 'staleOperation', message: 'The working tree changed since these changes were reviewed.' };
          f.entries = f.entries.filter(e => !(args.paths.includes(e.path) && e.untracked)).map(e => args.paths.includes(e.path) ? { ...e, worktreeStatus: '.' } : e).filter(e => !(e.indexStatus === '.' && e.worktreeStatus === '.')); f.version++; return;
        case 'repository_ignore_path': f.entries = f.entries.filter(e => e.path !== args.path); f.version++; return;
        case 'repository_open_path': case 'repository_reveal_path': return;
        case 'repository_create_commit': f.head = 'c1'; f.entries = f.entries.map(e => ({ ...e, indexStatus: '.' })).filter(e => e.worktreeStatus !== '.'); f.version++; return { oid: 'c1' };
        default: f.unknown.push(command); return;
      }
    } };
  });

  const calls = () => page.evaluate(() => window.fixture.calls.map(c => c.command));
  const mark = () => page.evaluate(() => window.fixture.calls.length);
  const since = async n => (await calls()).slice(n);
  const settle = () => page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));

  await page.goto(url);
  await page.locator('button:has-text("/fixture")').first().click();
  await page.getByRole('option', { name: /Working changes/ }).click();
  await page.getByLabel('Working changes inspector').waitFor();

  // 1. Stage refreshes status only.
  let n = await mark();
  await page.getByRole('button', { name: 'Stage src/edited.ts' }).click();
  await page.getByRole('button', { name: 'Staged: src/edited.ts' }).waitFor();
  await settle();
  const afterStage = await since(n);
  assert.ok(afterStage.includes('repository_stage') && afterStage.includes('repository_status'));
  for (const heavy of ['repository_snapshot', 'repository_state', 'repository_operation_state', 'repository_history']) assert.ok(!afterStage.includes(heavy), `stage must not call ${heavy}`);

  // 2. Right-click menu, no text selection.
  const row = page.getByRole('button', { name: 'Untracked: fresh.md' });
  await row.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Actions for fresh.md' });
  await menu.waitFor();
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.working-file')).userSelect), 'none');
  assert.equal(await page.evaluate(() => window.getSelection().toString()), '');
  await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });

  // 3. Per-file discard through the menu.
  await row.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Discard changes…' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancel');
  n = await mark();
  await dialog.getByRole('button', { name: 'Discard 1 file' }).click();
  await row.waitFor({ state: 'detached' });
  await settle();
  const afterDiscard = await since(n);
  const discardCall = await page.evaluate(() => window.fixture.calls.find(c => c.command === 'repository_discard'));
  assert.deepEqual(discardCall.args.paths, ['fresh.md']);
  assert.match(discardCall.args.expectedStatusFingerprint, /^v\d+$/);
  for (const heavy of ['repository_snapshot', 'repository_history']) assert.ok(!afterDiscard.includes(heavy), `discard must not call ${heavy}`);
  await page.getByText('Selected changes discarded.').waitFor();

  // 4. Stale review is refused and surfaced.
  const allNew = page.getByRole('button', { name: /Discard all/ });
  await allNew.click();
  await page.evaluate(() => { window.fixture.version++; });
  await page.getByRole('dialog').getByRole('button', { name: /^Discard \d+ files?$/ }).click();
  await page.locator('.workflow-alert.error').waitFor();


  // 6. Open / reveal / ignore.
  await page.getByRole('button', { name: 'Untracked: notes/also-new.txt' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open file' }).click();
  await page.getByRole('button', { name: 'Untracked: notes/also-new.txt' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Reveal in Finder|Show in/ }).click();
  await page.getByRole('button', { name: 'Untracked: notes/also-new.txt' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add to .gitignore' }).click();
  await page.getByText('Added to .gitignore.').waitFor();
  const all = await calls();
  for (const c of ['repository_open_path', 'repository_reveal_path', 'repository_ignore_path']) assert.ok(all.includes(c), c);

  // 7. Commit still does a full refresh.
  await page.getByRole('textbox', { name: /Summary/ }).fill('feat: x');
  n = await mark();
  await page.getByRole('button', { name: 'Commit staged changes' }).click();
  await page.getByText(/Created commit/).waitFor();
  const afterCommit = await since(n);
  assert.ok(afterCommit.includes('repository_snapshot') && afterCommit.includes('repository_history'));
  assert.deepEqual(errors, []);
  console.log('discard smoke OK');
} finally { await browser.close(); await server.close(); }
