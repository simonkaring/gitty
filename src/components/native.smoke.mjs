// Optional browser integration check; uses an existing Playwright installation.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node src/components/native.smoke.mjs
// Set GITTY_SIDEBAR_SMOKE=1 to run only the focused native layout/filter checks.
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = await createServer({ server: { host: '127.0.0.1', port: 5186, strictPort: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const url = server.resolvedUrls.local[0];
  const demo = await browser.newPage();
  demo.on('pageerror', e => errors.push(e.message));
  await demo.goto(url);
  await demo.locator('.statusbar').getByText('Demo workspace', { exact: false }).waitFor();
  await demo.getByRole('textbox', { name: 'Search commits, authors, branches, or SHA' }).fill('palette');
  await demo.getByText('Full graph preserved', { exact: false }).waitFor();
  await demo.close();

  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    window.isTauri = true;
    localStorage.setItem('gitty:theme', 'dark');
    const commit = (id, parents = []) => ({ id, parents, subject: `Commit ${id}`, body: `Body ${id}`, author: 'Test Author', email: 'test@example.test', timestamp: 1700000000 });
    const original = Array.from({ length: 220 }, (_, i) => commit(`c${i}`, i === 219 ? [] : [`c${i + 1}`]));
    const added = Array.from({ length: 250 }, (_, i) => commit(`n${i}`, [i === 249 ? 'c0' : `n${i + 1}`]));
    const f = window.fixture = { mode: 'old', raceOnce: false, delayStatus: false, statusWaiting: false, holdDiff: false, calls: [], walks: new Map(), sequence: 0 };
    const list = () => f.mode === 'rewrite' ? [commit('replacement')] : f.mode === 'new' ? [...added, ...original] : original;
    const state = () => ({ session: { handle: 's', name: 'Fixture', location: { kind: 'native', path: '/fixture' }, root: '/fixture', gitDir: '/fixture/.git', commonDir: '/fixture/.git', head: list()[0].id, headRef: 'refs/heads/main', shallow: false, bare: false, linkedWorktree: false }, refs: [{ name: 'main', fullName: 'refs/heads/main', commitId: list()[0].id, kind: 'local' }, { name: 'empty', fullName: 'refs/tags/empty', commitId: 'c219', kind: 'tag' }], remotes: [], fingerprint: f.mode });
    let callbackId = 0;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__TAURI_INTERNALS__ = { transformCallback: () => ++callbackId, unregisterCallback: () => {}, invoke: async (command, args) => {
      f.calls.push({ command, args });
      if (command === 'repository_snapshot') { const [state, status, operation] = await Promise.all(['repository_state', 'repository_status', 'repository_operation_state'].map(name => window.__TAURI_INTERNALS__.invoke(name, args))); return { state, status, operation }; }
      if (command === 'plugin:event|listen') return 1;
      if (command === 'plugin:event|unlisten') return;
      if (command === 'repository_recent') return [{ kind: 'native', path: '/fixture' }];
      if (command === 'wsl_distributions') return [];
      if (command === 'repository_pick') return '/fixture';
      if (command === 'repository_open' || command === 'repository_state') return state();
      if (command === 'repository_close') return;
      if (command === 'repository_operation_state') return { kind: 'none', label: '', current: null, incoming: null, step: null, total: null, conflicts: [], canContinue: false, canSkip: false, fingerprint: f.mode };
      if (command === 'repository_status') {
        if (f.raceOnce) { f.raceOnce = false; f.mode = 'new'; }
        if (f.delayStatus) { f.statusWaiting = true; await new Promise(resolve => { f.releaseStatus = resolve; }); f.statusWaiting = false; }
        return { head: list()[0].id, headRef: 'refs/heads/main', fingerprint: f.mode, entries: [{ path: 'file.txt', oldPath: null, indexStatus: 'M', worktreeStatus: 'M', conflicted: false, untracked: false }] };
      }
      if (command === 'repository_history') {
        let generation, offset;
        if (!args.cursor) { generation = `walk${++f.sequence}`; offset = 0; f.walks.set(generation, list()); }
        else { [generation, offset] = args.cursor.split(':'); offset = Number(offset); }
        const items = f.walks.get(generation), end = Math.min(offset + args.limit, items.length);
        return { commits: items.slice(offset, end), cursor: end < items.length ? `${generation}:${end}` : null, generation, shallow: false };
      }
      if (command === 'repository_commit') return [...original, ...added].find(c => c.id === args.oid) ?? commit(args.oid);
      if (command === 'repository_diff_files') return args.spec.oid === 'c219' ? [] : [{ path: 'file.txt', oldPath: null, status: 'M', additions: 1, deletions: 1, binary: false }];
      if (command === 'repository_diff') {
        if (f.holdDiff) await new Promise((resolve, reject) => { f.rejectDiff = reject; });
        return { path: 'file.txt', hunks: [{ header: '@@ -1 +1 @@', lines: [{ kind: 'remove', content: 'before', oldLine: 1, newLine: null }, { kind: 'add', content: 'after', oldLine: null, newLine: 1 }] }], binary: false, truncated: false, message: null };
      }
      if (command === 'repository_search') return { commits: list().filter(c => c.id.includes(args.query.text)), truncated: false };
      if (command === 'repository_sync_info') return { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, remotes: ['origin'] };
      if (command === 'repository_stashes') return [];
      if (command === 'repository_remote_action' || command === 'repository_stash_action') return { output: '' };
      throw new Error(`Unexpected command: ${command}`);
    } };
  });
  await page.goto(url);
  await page.getByRole('button', { name: 'Open repository', exact: true }).click();
  await page.getByRole('button', { name: 'Native /fixture' }).click();
  await page.getByRole('option', { name: /^Commit c0,/ }).waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.getByText('main → origin/main', { exact: false }).waitFor();

  // Native full-history search and scoped filters live in the sidebar, but
  // remain accessible above the graph when the sidebar is collapsed.
  const sidebar = page.getByRole('complementary', { name: 'Repository references' });
  await sidebar.getByText('/fixture', { exact: true }).waitFor();
  assert.equal(await page.locator('.history-pane .repository-heading').count(), 0);
  await sidebar.getByRole('textbox', { name: 'Search full history' }).fill('c1');
  await page.waitForFunction(() => window.fixture.calls.some(call => call.command === 'repository_search' && call.args.query.text === 'c1'));
  await sidebar.getByRole('combobox', { name: 'Branch scope' }).selectOption('refs/heads/main');
  await page.waitForFunction(() => window.fixture.calls.some(call => call.command === 'repository_search' && call.args.query.branch === 'refs/heads/main'));
  await sidebar.getByText('Date & path').click();
  await sidebar.getByRole('textbox', { name: 'Filter path' }).fill('src/');
  await page.waitForFunction(() => window.fixture.calls.some(call => call.command === 'repository_search' && call.args.query.path === 'src/'));
  await sidebar.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByRole('button', { name: 'Toggle references sidebar' }).click();
  await page.locator('.workspace-main').getByRole('textbox', { name: 'Search full history' }).fill('c2');
  await page.waitForFunction(() => window.fixture.calls.some(call => call.command === 'repository_search' && call.args.query.text === 'c2'));
  await page.locator('.workspace-main').getByRole('button', { name: 'Clear search' }).click();
  await page.getByRole('button', { name: 'Toggle references sidebar' }).click();
  if (process.env.GITTY_SIDEBAR_SMOKE) {
    assert.deepEqual(errors, []);
    console.log('Native sidebar smoke passed (mocked IPC): repository path, compact graph, scoped search, collapsed sidebar fallback.');
  } else {

  // Repository tabs: a single open tab, and reopening the same recent
  // location focuses it instead of creating a duplicate.
  await page.locator('.repository-tab').getByText('Fixture', { exact: true }).waitFor();
  assert.equal(await page.locator('.repository-tab').count(), 1);
  await page.getByRole('button', { name: 'Open repository…', exact: true }).click();
  await page.getByRole('button', { name: 'Native /fixture' }).click();
  assert.equal(await page.locator('.repository-tab').count(), 1);

  // Stash dialog reads the (empty) stash list without any network action.
  await page.getByRole('button', { name: 'Stash…', exact: true }).click();
  await page.getByText('No stashes.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  // Background work must not add/remove banners or resize the graph viewport.
  const beforeBounds = await page.locator('.history-scroll').boundingBox();
  await page.evaluate(() => { window.fixture.delayStatus = true; window.dispatchEvent(new Event('focus')); });
  await page.waitForFunction(() => window.fixture.statusWaiting);
  assert.equal(await page.getByText('Loading repository…', { exact: true }).count(), 0);
  assert.deepEqual(await page.locator('.history-scroll').boundingBox(), beforeBounds);
  await page.evaluate(() => { window.fixture.delayStatus = false; window.fixture.releaseStatus(); });
  await page.waitForFunction(() => !window.fixture.statusWaiting);

  // Explicit comparison direction and working-category precedence.
  await page.getByRole('button', { name: 'Set as base', exact: true }).click();
  await page.getByRole('option', { name: /^Commit c1,/ }).click();
  await page.getByRole('button', { name: 'Set as target', exact: true }).click();
  await page.getByText('Changes that turn the base commit into the target commit.', { exact: false }).waitFor();
  await page.getByRole('option', { name: /^Working changes/ }).click();
  await page.getByRole('button', { name: 'Staged: file.txt', exact: true }).click();
  await page.locator('.diff-view-pane .diff-view-group-badge.staged').waitFor();
  await page.waitForFunction(() => window.fixture.calls.filter(c => c.command === 'repository_diff').at(-1)?.args.spec.kind === 'staged');
  await page.getByRole('button', { name: 'Unstaged: file.txt', exact: true }).click();
  await page.locator('.diff-view-pane .diff-view-group-badge.unstaged').waitFor();
  await page.getByRole('button', { name: 'Close diff and show tree' }).click();
  await page.getByRole('option', { name: /^Commit c0,/ }).click();
  await page.getByRole('button', { name: 'Clear comparison', exact: true }).click();

  // More than one page arrives during a state/status race. Selection and pixel
  // offset survive, and the new HEAD is the working node's parent.
  await page.locator('.history-scroll').evaluate(el => { el.scrollTop = 453; });
  await page.evaluate(() => { window.fixture.raceOnce = true; });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent.includes('400 commits loaded'));
  assert.equal(await page.locator('.history-scroll').evaluate(el => el.scrollTop), 250 * 36 + 453);
  assert.equal(await page.locator('.native-sha').textContent(), 'c0');

  // Reject a stale pending diff after selecting a commit with no changed files.
  await page.getByRole('button', { name: 'HEAD', exact: true }).click();
  await page.evaluate(() => { window.fixture.holdDiff = true; });
  await page.getByRole('option', { name: /^Commit n1,/ }).click();
  await page.waitForFunction(() => !!window.fixture.rejectDiff);
  await page.locator('summary').filter({ hasText: 'Tags' }).click();
  await page.getByRole('button', { name: 'empty', exact: true }).click();
  await page.getByText('No changed files in this comparison.', { exact: true }).waitFor();
  await page.evaluate(() => { window.fixture.holdDiff = false; window.fixture.rejectDiff(new Error('Stale diff failure')); });
  assert.equal(await page.getByText('Loading diff…', { exact: true }).count(), 0);
  assert.equal(await page.getByText('Stale diff failure', { exact: false }).count(), 0);

  await page.evaluate(() => { window.fixture.mode = 'rewrite'; });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByText('no longer reachable from the current references', { exact: false }).waitFor();
  assert.equal(await page.locator('.native-sha').textContent(), 'c219');
   await page.getByRole('button', { name: 'Open settings', exact: true }).click();
   await page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor();
   await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('gitty-light');
   await page.getByRole('button', { name: 'Close settings', exact: true }).click();
   assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
   assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('gitty:settings')).themeId), 'gitty-light');
   assert.equal(await page.evaluate(() => window.fixture.calls.filter(call => call.command === 'repository_operation_state').every(call => call.args.handle === 's')), true);
   assert.ok(await page.evaluate(() => window.fixture.calls.filter(call => call.command === 'repository_operation_state').length >= 2));
   await page.reload();
   // The tab (location + active id) persists across reload and reopens the
   // same repository automatically, without an explicit "Open repository".
   // (The init script itself resets the fixture's mocked repository state on
   // each navigation; only the tab/location and the theme are expected to
   // survive here, not the fixture's in-memory commit graph.)
   await page.locator('.repository-tab').getByText('Fixture', { exact: true }).waitFor();
   assert.equal(await page.locator('.repository-tab').count(), 1);
   assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  assert.deepEqual(errors, []);
    console.log('Browser smoke passed (mocked native IPC): demo; operation-state snapshots; native snapshot race; silent polling; selection/anchor preservation; comparison modes; stale diff cleanup; unreachable inspector; Settings theme migration; repository tabs (single-tab dedup, stash dialog); reload persistence.');
  }
} finally {
  await browser.close();
  await server.close();
}
