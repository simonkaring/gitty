// Optional browser smoke with a deterministic IPC fixture. No native files touched.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node src/components/workflow.smoke.mjs
import assert from 'node:assert/strict';
import { createServer } from 'vite';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = await createServer({ server: { host: '127.0.0.1', port: 5187, strictPort: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true });
const errors = [];
const screenshot = async (page, name) => { if (process.env.SCREENSHOT_DIR) { await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/${name}.png`, fullPage: true }); } };
try {
  const url = server.resolvedUrls.local[0];
  const demo = await browser.newPage({ viewport: { width: 1500, height: 1000 }, reducedMotion: 'reduce' });
  demo.on('pageerror', error => errors.push(error.message));
  await demo.addInitScript(() => localStorage.setItem('gitty:theme', 'light'));
  await demo.goto(url);
  await demo.getByRole('listbox', { name: 'Commit history' }).waitFor();
  await demo.evaluate(() => document.fonts.ready);
  assert.equal(await demo.locator('.commit-row').first().evaluate(el => getComputedStyle(el).fontSize), '14px');
  assert.equal(await demo.locator('.commit-row').first().evaluate(el => el.getBoundingClientRect().height), 36);
  await screenshot(demo, 'gitty-history-light');
  const sidebarResize = demo.getByRole('separator', { name: 'Resize repository sidebar' });
  await sidebarResize.focus(); await sidebarResize.press('ArrowRight');
  assert.equal(await sidebarResize.getAttribute('aria-valuenow'), '260');
  await sidebarResize.press('ArrowLeft');
  const inspectorResize = demo.getByRole('separator', { name: 'Resize commit inspector' });
  await inspectorResize.focus(); await inspectorResize.press('ArrowLeft');
   assert.equal(await inspectorResize.getAttribute('aria-valuenow'), '420');
   await inspectorResize.press('ArrowRight');
   assert.equal(await inspectorResize.getAttribute('aria-valuenow'), '400');
  await demo.getByRole('button', { name: /Working changes/ }).click();
  await demo.getByRole('textbox', { name: /Summary/ }).fill('feat: review working changes');
  await demo.getByRole('textbox', { name: /Description/ }).fill('Compose a clear commit message.');
  await demo.getByRole('button', { name: 'Staged: src/styles/tokens.css', exact: true }).click();
  await demo.getByRole('region', { name: 'Working file diff' }).getByText('  --row-height: 48px;', { exact: false }).waitFor();
  await screenshot(demo, 'gitty-working-light');
   await demo.getByRole('button', { name: 'Open settings', exact: true }).click();
   await demo.getByRole('dialog', { name: 'Settings', exact: true }).waitFor();
   await demo.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('gitty-dark');
   await demo.getByRole('button', { name: 'Close settings', exact: true }).click();
   assert.equal(await demo.locator('html').getAttribute('data-theme'), 'dark');
   assert.equal(await demo.getByRole('textbox', { name: /Summary/ }).inputValue(), 'feat: review working changes');
   assert.equal(await demo.evaluate(() => JSON.parse(localStorage.getItem('gitty:settings')).themeId), 'gitty-dark');
  await screenshot(demo, 'gitty-working-dark');
  await demo.getByRole('button', { name: 'Commit staged changes' }).click();
  await demo.getByText(/Created commit/).waitFor();
  assert.equal(await demo.getByRole('textbox', { name: /Summary/ }).inputValue(), '');
  await demo.getByRole('button', { name: 'History', exact: true }).click();
  await demo.getByRole('option', { name: /^feat: review working changes/ }).waitFor();
  await screenshot(demo, 'gitty-history-dark');
  await demo.setViewportSize({ width: 390, height: 844 });
  await demo.getByRole('button', { name: 'Toggle repositories sidebar' }).click();
  await demo.getByRole('button', { name: /Working changes/ }).click();
  await screenshot(demo, 'gitty-working-mobile');
  assert.equal(await demo.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await demo.getByRole('textbox', { name: /Summary/ }).fill('Mobile draft');
  await demo.close();

  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.isTauri = true;
    localStorage.setItem('gitty:theme', 'light');
    const entry = (path, indexStatus, worktreeStatus, untracked = false, conflicted = false) => ({ path, oldPath: null, indexStatus, worktreeStatus, untracked, conflicted });
    const f = window.fixture = { calls: [], head: 'c0', version: 0, bare: false, conflict: false, holdWrite: false, holdRefresh: false, failRefresh: false, commitMode: 'success', entries: [entry('src/partial.ts', 'M', 'M'), entry('src/modified.ts', '.', 'M'), entry('new.md', '?', '?', true)] };
    const commit = (id, parents = []) => ({ id, parents, subject: id === 'c0' ? 'feat: readable repository history' : 'feat: commit staged changes', body: 'Review the changes in context.', author: 'Alex Morgan', email: 'alex@example.test', timestamp: 1700000000 });
    const state = () => ({ session: { handle: 'fixture-session', name: 'gitty', root: '/workspace/gitty', location: { kind: 'native', path: '/workspace/gitty' }, gitDir: '/workspace/gitty/.git', commonDir: '/workspace/gitty/.git', head: f.head, headRef: 'refs/heads/main', shallow: false, bare: f.bare, linkedWorktree: false }, refs: [{ name: 'main', fullName: 'refs/heads/main', commitId: f.head, kind: 'local' }], remotes: ['origin'], fingerprint: `${f.head}:${f.bare}` });
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      f.calls.push({ command, args });
      if (command === 'repository_snapshot') { const [state, status, operation] = await Promise.all(['repository_state', 'repository_status', 'repository_operation_state'].map(name => window.__TAURI_INTERNALS__.invoke(name, args))); return { state, status, operation }; }
      if (command === 'repository_recent') return [{ kind: 'native', path: '/workspace/gitty' }];
      if (command === 'wsl_distributions') return [];
      if (command === 'repository_open' || command === 'repository_state') return state();
      if (command === 'repository_close') return;
      if (command === 'repository_operation_state') return { kind: f.conflict ? 'merge' : 'none', label: f.conflict ? 'Merge in progress' : '', current: 'main', incoming: f.conflict ? 'topic' : null, step: null, total: null, conflicts: f.conflict ? ['conflict.ts'] : [], canContinue: false, canSkip: false, fingerprint: `${f.head}:${f.version}:${f.bare}:${f.conflict}` };
      if (command === 'repository_status') {
        if (f.holdRefresh) { f.refreshWaiting = true; await new Promise(resolve => { f.releaseRefresh = resolve; }); f.refreshWaiting = false; }
        if (f.failRefresh) throw { code: 'io', message: 'Cannot read repository status' };
        return { head: f.head, headRef: 'refs/heads/main', fingerprint: String(f.version), entries: [...f.entries, ...(f.conflict ? [entry('conflict.ts', 'U', 'U', false, true)] : [])] };
      }
      if (command === 'repository_history') return { commits: f.head === 'c0' ? [commit('c0')] : [commit(f.head, ['c0']), commit('c0')], cursor: null, generation: `g:${f.head}`, shallow: false };
      if (command === 'repository_commit') { const detail = commit(args.oid); return { ...detail, body: `${detail.subject}\n\nReview the changes in context.\n` }; }
      if (command === 'repository_diff_files') return [{ path: 'src/partial.ts', oldPath: null, status: 'M', additions: 2, deletions: 1, binary: false }];
      if (command === 'repository_diff') {
        if (f.holdDiff === args.path) { f.diffWaiting = true; await new Promise(resolve => { f.releaseDiff = resolve; }); f.diffWaiting = false; }
        return { path: args.path, binary: false, truncated: false, message: null, hunks: [{ header: '@@ -1,3 +1,4 @@', lines: [{ kind: 'context', content: `// ${args.path}`, oldLine: 1, newLine: 1 }, { kind: 'remove', content: 'const rowHeight = 44;', oldLine: 2, newLine: null }, { kind: 'add', content: `const rowHeight = 48; // ${args.spec.kind}`, oldLine: null, newLine: 2 }, { kind: 'add', content: 'const preserveSelection = true;', oldLine: null, newLine: 3 }] }] };
      }
      if (command === 'repository_search') return { commits: [], truncated: false };
      if (['repository_stage', 'repository_unstage', 'repository_create_commit', 'repository_amend_commit'].includes(command)) {
        if (f.holdWrite) { f.writeWaiting = true; await new Promise(resolve => { f.releaseWrite = resolve; }); f.writeWaiting = false; }
        if (command === 'repository_create_commit' || command === 'repository_amend_commit') {
          if (f.commitMode === 'merge') throw { code: 'merge_in_progress', message: 'Merge in progress. Complete it with another Git tool.' };
          f.head = `commit${++f.version}`;
          f.entries = f.entries.map(item => ({ ...item, indexStatus: '.' })).filter(item => !['.', ' '].includes(item.worktreeStatus));
          if (f.commitMode === 'ambiguous') throw { code: 'commit_failed', message: 'Commit response was interrupted' };
          return { oid: f.head };
        }
        if (!args.paths.length) throw new Error('Empty-all is forbidden');
        f.entries = f.entries.map(item => !args.paths.includes(item.path) ? item : command === 'repository_stage' ? { ...item, indexStatus: ['R', 'C'].includes(item.indexStatus) ? item.indexStatus : item.untracked ? 'A' : 'M', worktreeStatus: '.', untracked: false } : { ...item, indexStatus: '.', worktreeStatus: 'M' });
        f.version++;
        return;
      }
      // The focused tab auto-fetches on open; it has no effect on this fixture.
      if (command === 'repository_remote_action' && args.action.kind === 'backgroundFetch') return { output: '' };
      throw new Error(`Unexpected command ${command}`);
    } };
  });
  // Repository tabs persist across reload: after the first `open()`, a
  // reload reopens the same tab automatically, so the empty-state "Open
  // repository" welcome button (only rendered with zero tabs) is gone.
  const open = async () => {
    const welcomeButton = page.getByRole('button', { name: 'Open repository', exact: true });
    if (await welcomeButton.count()) {
      await welcomeButton.click();
      await page.getByRole('button', { name: 'Native /workspace/gitty', exact: true }).click();
    }
    await page.getByRole('listbox', { name: 'Commit history' }).waitFor();
  };
  await page.goto(url); await open();
  await screenshot(page, 'gitty-native-history');
  await page.getByRole('button', { name: /Working changes/ }).click();
  await page.getByRole('textbox', { name: /Summary/ }).fill('feat: commit staged changes');
  await page.getByRole('textbox', { name: /Description/ }).fill('Keep my draft through failures.');
  await page.reload(); await open();
  await page.getByRole('button', { name: /Working changes/ }).click();
  assert.equal(await page.getByRole('textbox', { name: /Summary/ }).inputValue(), 'feat: commit staged changes');
  assert.equal(await page.getByRole('textbox', { name: /Description/ }).inputValue(), 'Keep my draft through failures.');
  await page.getByRole('checkbox', { name: 'Amend last commit' }).check();
  await page.getByRole('textbox', { name: /Summary/ }).waitFor();
  await page.waitForFunction(() => document.querySelector('input[name="subject"]')?.value === 'feat: readable repository history');
  await page.getByRole('textbox', { name: /Summary/ }).fill('reworded last commit');
  await page.getByRole('checkbox', { name: 'Amend last commit' }).uncheck();
  assert.equal(await page.getByRole('textbox', { name: /Summary/ }).inputValue(), 'feat: commit staged changes', 'ordinary draft is restored after leaving amend mode');
  await page.getByRole('button', { name: 'Staged: src/partial.ts', exact: true }).click();
  await page.getByText('HEAD → index · included in your next commit', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Unstaged: src/partial.ts', exact: true }).click();
  await page.getByText('Index → working tree · not yet staged', { exact: true }).waitFor();
  await screenshot(page, 'gitty-native-working');
  // A late preview for a previously selected file must not replace the new one.
  await page.evaluate(() => { window.fixture.holdDiff = 'src/modified.ts'; });
  await page.getByRole('button', { name: 'Unstaged: src/modified.ts', exact: true }).click();
  await page.waitForFunction(() => window.fixture.diffWaiting);
  await page.getByRole('button', { name: 'Untracked: new.md', exact: true }).click();
  await page.getByRole('region', { name: 'Working file diff' }).getByText('// new.md', { exact: false }).waitFor();
  await page.evaluate(() => { window.fixture.holdDiff = ''; window.fixture.releaseDiff(); });
  await page.waitForFunction(() => !window.fixture.diffWaiting);
  assert.equal(await page.getByRole('region', { name: 'Working file diff' }).getByText('// src/modified.ts', { exact: false }).count(), 0);

  // Two DOM clicks in the same turn must produce just one IPC mutation.
  await page.evaluate(() => { window.fixture.holdWrite = true; });
  await page.getByRole('button', { name: 'Stage all', exact: true }).evaluate(button => { button.click(); button.click(); });
  await page.waitForFunction(() => window.fixture.writeWaiting);
  assert.equal(await page.getByRole('button', { name: 'Commit staged changes' }).isDisabled(), true);
  // "Open repository…" opens an independent tab (its own session/handle) and
  // must stay enabled during another tab's in-flight write: opening a new
  // repository no longer tears down the tab that is mid-mutation.
  assert.equal(await page.getByRole('button', { name: 'Open repository…', exact: true }).isDisabled(), false);
  assert.equal(await page.evaluate(() => window.fixture.calls.filter(call => call.command === 'repository_stage').length), 1);
  assert.deepEqual(await page.evaluate(() => window.fixture.calls.find(call => call.command === 'repository_stage').args.paths), ['src/partial.ts', 'src/modified.ts', 'new.md']);
  await page.evaluate(() => { window.fixture.holdRefresh = true; window.fixture.holdWrite = false; window.fixture.releaseWrite(); });
  await page.waitForFunction(() => window.fixture.refreshWaiting);
  assert.equal(await page.getByRole('button', { name: 'Unstage all', exact: true }).isDisabled(), true);
  await page.evaluate(() => { window.fixture.holdRefresh = false; window.fixture.releaseRefresh(); });
  await page.getByText('Selected changes staged.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /^Staged: / }).count(), 3);
  await page.getByRole('button', { name: 'Unstage src/partial.ts', exact: true }).click();
  await page.getByText('Selected changes unstaged.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Unstaged: src/partial.ts', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Unstage all', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.composer-heading > span')?.textContent === '0 staged paths');
  assert.equal(await page.getByRole('button', { name: 'Commit staged changes' }).isDisabled(), true);
  await page.getByRole('button', { name: 'Stage src/partial.ts', exact: true }).click();
  await page.getByText('Selected changes staged.', { exact: true }).waitFor();

  // The backend is authoritative about unsupported merge states.
  await page.evaluate(() => { window.fixture.commitMode = 'merge'; });
  await page.getByRole('button', { name: 'Commit staged changes' }).click();
  await page.getByRole('alert').filter({ hasText: 'Merge in progress' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: /Summary/ }).inputValue(), 'feat: commit staged changes');
  // Ambiguous commit: HEAD really moved, but the request failed. Never auto retry.
  await page.evaluate(() => { window.fixture.commitMode = 'ambiguous'; });
  await page.getByRole('button', { name: 'Commit staged changes' }).click();
  await page.getByRole('alert').filter({ hasText: 'Commit response was interrupted' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: /Summary/ }).inputValue(), 'feat: commit staged changes');
  assert.equal(await page.evaluate(() => window.fixture.calls.filter(call => call.command === 'repository_create_commit').length), 2);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByRole('option', { name: /^feat: commit staged changes/ }).waitFor();
  await page.getByRole('button', { name: /Working changes/ }).click();

  // An unconfirmed refresh blocks further writes until an explicit read succeeds.
  await page.getByRole('button', { name: 'Stage new.md', exact: true }).click();
  await page.getByText('Selected changes staged.', { exact: true }).waitFor();
  await page.evaluate(() => { window.fixture.failRefresh = true; });
  await page.getByRole('button', { name: 'Stage src/modified.ts', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Refresh failed:' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Commit staged changes' }).isDisabled(), true);
  // The failed-refresh guard must survive hiding/showing the same keyed session,
  // and must guard the handler as well as the disabled submit button.
  const writesBeforeBlockedSubmit = await page.evaluate(() => window.fixture.calls.filter(call => ['repository_stage', 'repository_unstage', 'repository_create_commit'].includes(call.command)).length);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByRole('button', { name: /Working changes/ }).click();
  assert.equal(await page.locator('.composer-heading > span').textContent(), '1 staged path');
  assert.equal(await page.getByRole('button', { name: 'Commit staged changes' }).isDisabled(), true);
  await page.getByRole('textbox', { name: /Summary/ }).press('Enter');
  await page.getByRole('form', { name: 'Commit composer' }).evaluate(form => form.requestSubmit());
  await page.getByRole('button', { name: 'Stage all', exact: true }).evaluate(button => button.click());
  await page.getByRole('button', { name: 'Unstage all', exact: true }).evaluate(button => button.click());
  assert.equal(await page.evaluate(() => window.fixture.calls.filter(call => ['repository_stage', 'repository_unstage', 'repository_create_commit'].includes(call.command)).length), writesBeforeBlockedSubmit);
  await page.evaluate(() => { window.fixture.failRefresh = false; window.fixture.commitMode = 'success'; });
  await page.getByRole('button', { name: 'Refresh repository state', exact: true }).click();
  await page.getByRole('button', { name: 'Staged: src/modified.ts', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Commit staged changes' }).click();
  await page.getByText(/Created commit/).waitFor();
  assert.equal(await page.getByRole('textbox', { name: /Summary/ }).inputValue(), '');
  assert.equal(await page.getByRole('textbox', { name: /Description/ }).inputValue(), '');

  // Rename/copy origins are operation-side specific; displayed file counts are
  // status entries, not the expanded reset pathspec list.
  const resetRenameFixture = async (renameOnly = false) => {
    await page.evaluate(only => {
      const entry = (path, oldPath, indexStatus, worktreeStatus) => ({ path, oldPath, indexStatus, worktreeStatus, conflicted: false, untracked: false });
      window.fixture.entries = [entry('new.ts', 'old.ts', 'R', 'M'), ...(only ? [] : [entry('copy.ts', 'source.ts', 'C', 'M'), entry('source.ts', null, 'M', '.')])];
      window.fixture.version++;
    }, renameOnly);
    await page.getByRole('button', { name: 'Refresh changes', exact: true }).click();
    await page.getByRole('button', { name: 'Staged: new.ts', exact: true }).waitFor();
    await page.waitForFunction(count => document.querySelector('.composer-heading > span')?.textContent === `${count} staged ${count === 1 ? 'path' : 'paths'}`, renameOnly ? 1 : 3);
  };
  const lastPaths = command => page.evaluate(name => window.fixture.calls.filter(call => call.command === name).at(-1).args.paths, command);
  await resetRenameFixture(true);
  await page.getByRole('button', { name: 'Stage new.ts', exact: true }).click();
  await page.getByText('Selected changes staged.', { exact: true }).waitFor();
  assert.deepEqual(await lastPaths('repository_stage'), ['new.ts']);
  assert.equal(await page.locator('.composer-heading > span').textContent(), '1 staged path');
  await page.getByRole('button', { name: 'Unstage new.ts', exact: true }).click();
  await page.getByText('Selected changes unstaged.', { exact: true }).waitFor();
  assert.deepEqual(await lastPaths('repository_unstage'), ['old.ts', 'new.ts']);
  await resetRenameFixture();
  await page.getByRole('button', { name: 'Unstage copy.ts', exact: true }).click();
  await page.getByText('Selected changes unstaged.', { exact: true }).waitFor();
  assert.deepEqual(await lastPaths('repository_unstage'), ['copy.ts']);
  await page.getByRole('button', { name: 'Staged: source.ts', exact: true }).waitFor();
  assert.equal(await page.locator('.composer-heading > span').textContent(), '2 staged paths');
  await resetRenameFixture();
  await page.getByRole('button', { name: 'Stage all', exact: true }).click();
  await page.getByText('Selected changes staged.', { exact: true }).waitFor();
  assert.deepEqual(await lastPaths('repository_stage'), ['new.ts', 'copy.ts']);
  assert.equal(await page.locator('.composer-heading > span').textContent(), '3 staged paths');
  await page.getByRole('button', { name: 'Unstage all', exact: true }).click();
  await page.getByText('Selected changes unstaged.', { exact: true }).waitFor();
  assert.deepEqual(await lastPaths('repository_unstage'), ['old.ts', 'new.ts', 'copy.ts', 'source.ts']);
  assert.equal(await page.locator('.composer-heading > span').textContent(), '0 staged paths');

  // Conflicted paths are inspectable, never included in stage-all.
  await page.evaluate(() => { window.fixture.conflict = true; window.fixture.version++; });
  await page.getByRole('button', { name: 'Refresh changes', exact: true }).click();
  await page.getByRole('button', { name: 'Conflicts: conflict.ts', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Stage conflict.ts', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Commit staged changes' }).isDisabled(), true);
  await page.getByRole('button', { name: 'Conflicts: conflict.ts', exact: true }).click();
   await page.getByText('Unresolved paths · open the conflict editor to resolve', { exact: true }).waitFor();
  await page.evaluate(() => { window.fixture.bare = true; });
  await page.getByRole('button', { name: 'Refresh changes', exact: true }).click();
  await page.getByText('This is a bare repository.', { exact: false }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Stage all', exact: true }).isDisabled(), true);
  assert.deepEqual(errors, []);
   console.log(`Workflow browser smoke passed (mocked native IPC + demo): Settings preserves composer; draft reload; partial staging; rename/copy file/all paths and counts; duplicate clicks; write/refresh lock; merge errors; ambiguous commit; refresh recovery; blocked view-switch/keyboard/form submission; confirmed draft clear; conflicts; bare repo; mobile overflow${process.env.SCREENSHOT_DIR ? '; screenshots' : ''}.`);
} finally { await browser.close(); await server.close(); }
