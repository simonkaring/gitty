// Multi-repository tab integration smoke test with a deterministic IPC
// fixture covering two independent repositories/session handles.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node src/components/tabs.smoke.mjs
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = await createServer({ server: { host: '127.0.0.1', port: 5188, strictPort: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true });
const errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const url = server.resolvedUrls.local[0];
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    window.isTauri = true;
    localStorage.setItem('gitty:theme', 'dark');
    const commit = (id, parents = []) => ({ id, parents, subject: `Commit ${id}`, author: 'Test Author', email: 'test@example.test', timestamp: 1700000000 });
    const repoDefs = {
      '/repo-a': { handle: 'handle-a', name: 'Repo A' },
      '/repo-b': { handle: 'handle-b', name: 'Repo B' },
    };
    const commitsFor = prefix => Array.from({ length: 60 }, (_, i) => commit(`${prefix}${i}`, i === 59 ? [] : [`${prefix}${i + 1}`]));
    const commitsByPath = { '/repo-a': commitsFor('a'), '/repo-b': commitsFor('b') };
    const pathByHandle = Object.fromEntries(Object.entries(repoDefs).map(([path, def]) => [def.handle, path]));
    const f = window.fixture = { calls: [], closes: [], holdRemote: false, remoteWaiting: false, cloneWaiting: false };
    const stateFor = path => {
      const def = repoDefs[path], commits = commitsByPath[path];
      return { session: { handle: def.handle, name: def.name, root: path, gitDir: `${path}/.git`, commonDir: `${path}/.git`, location: { kind: 'native', path }, head: commits[0].id, headRef: 'refs/heads/main', shallow: false, bare: false, linkedWorktree: false }, refs: [{ name: 'main', fullName: 'refs/heads/main', commitId: commits[0].id, kind: 'local' }], remotes: ['origin'], fingerprint: def.handle };
    };
    let callbackId = 0;
    window.__TAURI_INTERNALS__ = { transformCallback: () => ++callbackId, unregisterCallback: () => {}, invoke: async (command, args) => {
      f.calls.push({ command, args: args ? { ...args } : args, at: Date.now() });
      if (command === 'repository_recent') return Object.keys(repoDefs).map(path => ({ kind: 'native', path }));
      if (command === 'wsl_distributions') return [];
      if (command === 'repository_open') return stateFor(args.location.path);
      if (command === 'repository_close') { f.closes.push(args.handle); return; }
      if (command === 'repository_state') return stateFor(pathByHandle[args.handle]);
      if (command === 'repository_operation_state') return { kind: 'none', label: '', current: null, incoming: null, step: null, total: null, conflicts: [], canContinue: false, canSkip: false, fingerprint: args.handle };
      if (command === 'repository_status') return { head: commitsByPath[pathByHandle[args.handle]][0].id, headRef: 'refs/heads/main', fingerprint: args.handle, entries: [] };
      if (command === 'repository_history') { const commits = commitsByPath[pathByHandle[args.handle]]; return { commits, cursor: null, generation: args.handle, shallow: false }; }
      if (command === 'repository_sync_info') return { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, remotes: ['origin'] };
      if (command === 'repository_stashes') return [];
      if (command === 'repository_search') return { commits: [], truncated: false };
      if (command === 'repository_pick_clone_parent') return '/clones';
      if (command === 'repository_clone') {
        const path = `${args.request.parent.path}/${args.request.directoryName}`;
        repoDefs[path] = { handle: 'handle-clone', name: args.request.directoryName };
        commitsByPath[path] = commitsFor('c');
        pathByHandle['handle-clone'] = path;
        args.onProgress.onmessage({ phase: 'receiving_objects', percent: 42, message: 'Receiving objects: 42%' });
        f.cloneWaiting = true;
        await new Promise(resolve => { f.releaseClone = resolve; });
        f.cloneWaiting = false;
        return { kind: 'native', path };
      }
      if (command === 'repository_cancel_clone') throw { code: 'invalidCloneOperation', message: 'Clone publication has already started' };
      if (command === 'repository_remote_action') {
        if (f.holdRemote) { f.remoteWaiting = true; await new Promise(resolve => { f.releaseRemote = resolve; }); f.remoteWaiting = false; }
        return { output: `synced ${args.handle}` };
      }
      if (command === 'repository_stash_action') {
        f.stashWaiting = true;
        await new Promise(resolve => { f.releaseStash = resolve; });
        f.stashWaiting = false;
        throw new Error('Stash fixture failed after closing dialog');
      }
      throw new Error(`Unexpected command: ${command}`);
    } };
  });
  await page.goto(url);
  // Every tab's pane stays mounted (hidden, not unmounted) while inactive, so
  // generic pane-content locators (search box, scroll container, commit
  // options with ambiguous names, etc.) must be scoped to the one pane that
  // is not `hidden`, exactly as real usage would (only it is interactable).
  const activePane = () => page.locator('.tab-pane-host:not([hidden])');

  // --- Open two independent repositories -----------------------------------
  await page.getByRole('button', { name: 'Open repository', exact: true }).click();
  await page.getByRole('button', { name: 'Native /repo-a', exact: true }).click();
  await activePane().getByRole('option', { name: /^Commit a0,/ }).waitFor();
  await page.getByRole('button', { name: 'Open another repository in a new tab', exact: true }).click();
  await page.getByRole('button', { name: 'Native /repo-b', exact: true }).click();
  await activePane().getByRole('option', { name: /^Commit b0,/ }).waitFor();
  assert.equal(await page.locator('.repository-tab').count(), 2, 'two distinct repositories produce two tabs');
  // React StrictMode (dev only) intentionally mounts each pane's open effect
  // twice, so exact call counts aren't meaningful here — only that each
  // distinct location was opened (and, below, that each ended up on its own
  // session handle).
  const opens = await page.evaluate(() => [...new Set(window.fixture.calls.filter(c => c.command === 'repository_open').map(c => c.args.location.path))].sort());
  assert.deepEqual(opens, ['/repo-a', '/repo-b'], 'each tab opened its own location');
  const handleCalls = await page.evaluate(() => [...new Set(window.fixture.calls.filter(c => c.command === 'repository_state').map(c => c.args.handle))].sort());
  assert.deepEqual(handleCalls, ['handle-a', 'handle-b'], 'the two tabs are backed by different session handles');

  // --- A clone reports progress, then opens in a new tab -------------------
  await page.getByRole('button', { name: 'Open another repository in a new tab', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Open repository', exact: true });
  await picker.getByLabel('Repository URL or path').fill('https://example.test/team/repo-c.git');
  await picker.getByLabel('Repository URL or path').blur();
  assert.equal(await picker.getByLabel('New directory name').inputValue(), 'repo-c', 'the clone directory is suggested from the source');
  await picker.getByRole('button', { name: 'Choose destination folder…', exact: true }).click();
  await picker.getByText('/clones', { exact: true }).waitFor();
  await picker.getByRole('button', { name: 'Clone repository', exact: true }).click();
  await page.waitForFunction(() => window.fixture.cloneWaiting);
  const cloneStatus = page.getByRole('status');
  await cloneStatus.getByText('Cloning repo-c', { exact: true }).waitFor();
  await cloneStatus.getByText('Receiving objects: 42%', { exact: true }).waitFor();
  assert.equal(await cloneStatus.locator('progress').getAttribute('value'), '42', 'clone progress is streamed into the workspace');
  const cloneRequest = await page.evaluate(() => window.fixture.calls.find(c => c.command === 'repository_clone').args.request);
  assert.deepEqual(cloneRequest, { source: 'https://example.test/team/repo-c.git', parent: { kind: 'native', path: '/clones' }, directoryName: 'repo-c' });
  await cloneStatus.getByRole('button', { name: 'Cancel clone', exact: true }).click();
  await page.getByText('Could not request clone cancellation: Clone publication has already started', { exact: true }).waitFor();
  await cloneStatus.getByText('Cloning repo-c', { exact: true }).waitFor();
  assert.equal(await cloneStatus.getByRole('button', { name: 'Cancel clone', exact: true }).isEnabled(), true, 'a rejected late cancellation restores the running clone UI');
  await page.evaluate(() => window.fixture.releaseClone());
  await page.waitForFunction(() => !window.fixture.cloneWaiting);
  await page.locator('.repository-tab[data-selected="true"]').getByText('repo-c', { exact: true }).waitFor();
  await activePane().getByRole('option', { name: /^Commit c0,/ }).waitFor();
  assert.equal(await page.locator('.repository-tab').count(), 3, 'a successful clone opens as a third tab');
  await page.locator('.repository-tab').filter({ hasText: 'repo-c' }).getByRole('button', { name: /Close|Cannot close/ }).click();
  await page.waitForFunction(() => window.fixture.closes.includes('handle-clone'));
  assert.equal(await page.locator('.repository-tab').count(), 2, 'the cloned tab can be closed normally');

  // --- Selection/filter/scroll/draft are retained per tab on switch --------
  const tabButton = name => page.locator('.repository-tab-select').filter({ hasText: name });
  await tabButton('Repo A').click();
  await activePane().getByRole('option', { name: /^Commit a0,/ }).waitFor();
  await activePane().getByRole('textbox', { name: 'Search full history' }).fill('needle-a');
  await activePane().getByRole('option', { name: /^Commit a5,/ }).click();
  await activePane().locator('.history-scroll').evaluate(el => { el.scrollTop = 400; });
  await activePane().getByRole('button', { name: /Working changes/ }).click();
  assert.equal(await activePane().getByRole('button', { name: 'Pull', exact: true }).isVisible(), true, 'top toolbar remains available in Working changes');
  const toolbarBounds = await activePane().locator('.repository-toolbar').boundingBox();
  const workspaceBounds = await activePane().locator('main.workspace').boundingBox();
  assert.ok(toolbarBounds.y + toolbarBounds.height <= workspaceBounds.y + 1, 'toolbar sits above the entire workspace');
  await activePane().getByRole('textbox', { name: /Summary/ }).fill('draft for repo A');

  await tabButton('Repo B').click();
  await activePane().getByRole('option', { name: /^Commit b0,/ }).waitFor();
  assert.equal(await activePane().getByRole('textbox', { name: 'Search full history' }).inputValue(), '', 'repo B starts with its own, unrelated filter state');
  await activePane().getByRole('textbox', { name: 'Search full history' }).fill('needle-b');

  await tabButton('Repo A').click();
  // Repo A was left on its "Working changes" view (see above): that view
  // choice is also retained per tab, so the history section (and its search
  // box) is switched back to explicitly, just like a real user would.
  await activePane().getByRole('button', { name: 'History', exact: true }).click();
  assert.equal(await activePane().getByRole('textbox', { name: 'Search full history' }).inputValue(), 'needle-a', 'search filter survives a tab switch');
  assert.equal(await activePane().locator('.history-scroll').evaluate(el => el.scrollTop), 400, 'history scroll position survives a tab switch');
  assert.equal(await activePane().locator('.native-sha').textContent(), 'a5', 'selected commit survives a tab switch');
  await activePane().getByRole('button', { name: /Working changes/ }).click();
  assert.equal(await activePane().getByRole('textbox', { name: /Summary/ }).inputValue(), 'draft for repo A', 'commit draft survives a tab switch');

  await tabButton('Repo B').click();
  assert.equal(await activePane().getByRole('textbox', { name: 'Search full history' }).inputValue(), 'needle-b', 'repo B kept its own filter after A changed its own');

  // --- Active-tab-only refresh: background tabs do not poll ---------------
  const statusCount = async handle => page.evaluate(h => window.fixture.calls.filter(c => c.command === 'repository_status' && c.args.handle === h).length, handle);
  await tabButton('Repo A').click(); // Repo B now backgrounded, Repo A active.
  const bBeforeWait = await statusCount('handle-b');
  const aBeforeWait = await statusCount('handle-a');
  await delay(5600); // Longer than the 5s poll interval.
  const bAfterWait = await statusCount('handle-b');
  const aAfterWait = await statusCount('handle-a');
  assert.equal(bAfterWait, bBeforeWait, 'a backgrounded tab must not poll while hidden');
  assert.ok(aAfterWait > aBeforeWait, 'the active tab keeps polling in the background timer');
  const bBeforeActivate = await statusCount('handle-b');
  await tabButton('Repo B').click(); // Switching back must trigger an immediate refresh.
  await page.waitForFunction(count => window.fixture.calls.filter(c => c.command === 'repository_status' && c.args.handle === 'handle-b').length > count, bBeforeActivate);
  assert.ok(await statusCount('handle-b') > bBeforeActivate, 'activating a stale background tab refreshes it immediately');

  // --- An operation keeps running after switching away from its tab -------
  await page.evaluate(() => { window.fixture.holdRemote = true; });
  await activePane().getByRole('button', { name: 'Pull', exact: true }).click();
  await page.waitForFunction(() => window.fixture.remoteWaiting);
  await tabButton('Repo A').click(); // Leave Repo B mid-write; the promise must keep running, hidden.
  await page.locator('.repository-tab[data-selected="true"]').getByText('Repo A', { exact: true }).waitFor();
  await page.evaluate(() => { window.fixture.holdRemote = false; window.fixture.releaseRemote(); });
  await page.waitForFunction(() => !window.fixture.remoteWaiting);
  await tabButton('Repo B').click();
  await activePane().getByText('synced handle-b', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.fixture.calls.filter(c => c.command === 'repository_remote_action').length), 1, 'the pull ran exactly once, bound to repo B');

  // Normal push delegates upstream resolution to Git, including remotes with
  // slashes or a differently named upstream branch; no display-label parsing.
  await activePane().getByRole('button', { name: 'Push', exact: true }).click();
  await page.waitForFunction(() => window.fixture.calls.some(c => c.command === 'repository_remote_action' && c.args.action.kind === 'push'));
  const pushed = await page.evaluate(() => window.fixture.calls.find(c => c.command === 'repository_remote_action' && c.args.action.kind === 'push'));
  assert.deepEqual(pushed.args, { handle: 'handle-b', action: { kind: 'push' } });

  // Closing a stash dialog while its action runs must not swallow its error.
  await activePane().getByRole('button', { name: 'Stash…', exact: true }).click();
  const stashDialog = page.getByRole('dialog', { name: 'Stashes', exact: true });
  await stashDialog.getByRole('button', { name: 'Save stash', exact: true }).click();
  await page.waitForFunction(() => window.fixture.stashWaiting);
  await stashDialog.getByRole('button', { name: 'Close', exact: true }).click();
  await tabButton('Repo A').click();
  await page.evaluate(() => window.fixture.releaseStash());
  await page.waitForFunction(() => !window.fixture.stashWaiting);
  await tabButton('Repo B').click();
  await activePane().getByRole('alert').filter({ hasText: 'Stash fixture failed after closing dialog' }).waitFor();
  await activePane().getByRole('button', { name: 'Dismiss operation error', exact: true }).click();

  // --- Reload persists both tabs and the active one ------------------------
  await page.reload();
  await page.locator('.repository-tab').getByText('Repo A', { exact: true }).waitFor();
  await page.locator('.repository-tab').getByText('Repo B', { exact: true }).waitFor();
  assert.equal(await page.locator('.repository-tab').count(), 2, 'both tabs are restored after reload');
  assert.equal(await page.locator('.repository-tab[data-selected="true"]').getByText('Repo B', { exact: true }).count(), 1, 'the previously active tab is still active after reload');
  await activePane().getByRole('option', { name: /^Commit b0,/ }).waitFor();

  // --- Cannot close a busy tab; closing an idle one cleans up its handle --
  await page.evaluate(() => { window.fixture.holdRemote = true; });
  await activePane().getByRole('button', { name: 'Pull', exact: true }).click();
  await page.waitForFunction(() => window.fixture.remoteWaiting);
  const closeB = page.locator('.repository-tab').filter({ hasText: 'Repo B' }).getByRole('button', { name: /Close|Cannot close/ });
  assert.equal(await closeB.isDisabled(), true, 'a busy tab cannot be closed');
  await closeB.click({ force: true });
  assert.equal(await page.locator('.repository-tab').count(), 2, 'the busy tab was not removed by the blocked close attempt');
  await page.evaluate(() => { window.fixture.holdRemote = false; window.fixture.releaseRemote(); });
  await page.waitForFunction(() => !window.fixture.remoteWaiting);
  await closeB.click();
  await page.waitForFunction(() => window.fixture.closes.includes('handle-b'));
  assert.equal(await page.locator('.repository-tab').count(), 1, 'closing an idle tab removes it');
  assert.equal(await page.locator('.repository-tab').getByText('Repo A', { exact: true }).count(), 1, 'the remaining tab is focused after closing the other one');

  // --- Offline-first: remote/stash actions never run passively ------------
  const remoteCalls = await page.evaluate(() => window.fixture.calls.filter(c => c.command === 'repository_remote_action').length);
  const stashActionCalls = await page.evaluate(() => window.fixture.calls.filter(c => c.command === 'repository_stash_action').length);
  assert.equal(remoteCalls, 1, 'repository_remote_action only ran for the one explicit Pull click across the whole scenario');
  assert.equal(stashActionCalls, 0, 'repository_stash_action never ran: no stash action was explicitly requested');

  assert.deepEqual(errors, []);
  console.log('Tabs browser smoke passed (mocked native IPC): clone request/progress/rejected-late-cancel/open-tab lifecycle; distinct session handles/canonical identities; per-tab selection/filter/scroll/draft retention; active-only polling with refresh-on-activate; operation completes after switching tabs away; reload restores both tabs and the active one; busy-tab close guard; close cleanup; no passive remote/stash calls.');
} finally {
  await browser.close();
  await server.close();
}
