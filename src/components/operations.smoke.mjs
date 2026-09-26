// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node src/components/operations.smoke.mjs
import assert from 'node:assert/strict';
import { createServer } from 'vite';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = await createServer({ server: { host: '127.0.0.1', port: 5192, strictPort: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.isTauri = true;
    const f = window.fixture = { version: 0, head: 'c0', calls: [], kind: 'none', conflict: false, conflictVersion: 0, failRefresh: false, failAfterWrite: false, failConflictRead: false, holdWrite: false, failExternal: false, failRemotes: false, conflictText: '<<<<<<< HEAD\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> topic\r\ntail' };
    const commit = (id, parents) => ({ id, parents, subject: `Commit ${id}`, author: 'Test Author', email: 'test@example.test', timestamp: 1700000000, body: '' });
    const commits = Array.from({ length: 180 }, (_, i) => commit(`c${i}`, i === 179 ? [] : [`c${i + 1}`]));
    commits[2].parents = ['c3', 'c4'];
    const state = () => ({ session: { handle: 's', name: 'Operations fixture', root: '/fixture', gitDir: '/fixture/.git', commonDir: '/fixture/.git', location: { kind: 'native', path: '/fixture' }, head: f.head, headRef: 'refs/heads/main', bare: false, shallow: false, linkedWorktree: false }, refs: [{ name: 'main', fullName: 'refs/heads/main', commitId: f.head, kind: 'local' }, { name: 'topic', fullName: 'refs/heads/topic', commitId: 'c2', kind: 'local' }, { name: 'origin/topic', fullName: 'refs/remotes/origin/topic', commitId: 'c2', kind: 'remote' }, { name: 'v1', fullName: 'refs/tags/v1', commitId: 'c3', kind: 'tag' }], remotes: ['origin'], fingerprint: String(f.version) });
    const operation = () => ({ kind: f.kind, label: f.kind === 'merge' ? 'Merge in progress' : '', current: 'main', incoming: f.kind === 'none' ? null : 'topic', conflicts: f.conflict ? ['file.txt'] : [], canContinue: f.kind !== 'none' && !f.conflict, canSkip: f.kind === 'rebase', step: null, total: null, fingerprint: String(f.version) });
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      f.calls.push({ command, args });
      if (command === 'repository_recent') return [{ kind: 'native', path: '/fixture' }];
      if (command === 'wsl_distributions') return [];
      if (command === 'repository_close') return;
      if (command === 'repository_open') return state();
      if (command === 'repository_state') { if (f.failRefresh) throw new Error('Refresh failed fixture'); return state(); }
      if (command === 'repository_operation_state') return operation();
      if (command === 'repository_status') return { head: f.head, headRef: 'refs/heads/main', fingerprint: String(f.version), entries: f.conflict ? [{ path: 'file.txt', indexStatus: 'U', worktreeStatus: 'U', oldPath: null, conflicted: true, untracked: false }] : f.showWorking ? [{ path: 'file.txt', indexStatus: '.', worktreeStatus: 'M', oldPath: null, conflicted: false, untracked: false }] : [] };
      if (command === 'repository_history') return { commits, cursor: null, generation: String(f.version), shallow: false };
      if (command === 'repository_commit') return commits.find(commit => commit.id === args.oid);
      if (command === 'repository_diff_files') return [];
      if (command === 'repository_diff') return { path: args.path, hunks: [], binary: false, truncated: false, message: null };
      if (command === 'repository_run_operation') {
        if (f.holdWrite) { f.writeWaiting = true; await new Promise(resolve => { f.releaseWrite = resolve; }); f.writeWaiting = false; }
        if (args.request.expectedOperation !== String(f.version) || args.request.expectedHead !== f.head || args.request.expectedHeadRef !== 'refs/heads/main') throw new Error('Reviewed state is stale');
        f.version++;
        if (f.failAfterWrite) { f.failRefresh = true; throw new Error('Uncertain write fixture'); }
        if (['continue', 'skip', 'abort'].includes(args.request.action.kind)) { f.kind = 'none'; f.conflict = false; }
        return { head: f.head, operation: operation(), output: 'done' };
      }
      if (command === 'repository_conflict_file') {
        if (f.failConflictRead) throw new Error('Conflict read fixture failed');
        return { path: args.path, fingerprint: String(f.conflictVersion), editable: true, reason: null, base: { oid: 'base', mode: '100644', content: 'base\r\n' }, ours: f.deletedSide === 'ours' ? null : { oid: 'ours', mode: '100644', content: 'ours\r\n' }, theirs: f.deletedSide === 'theirs' ? null : { oid: 'theirs', mode: '100644', content: 'theirs\r\n' }, result: f.conflictText, oursLabel: 'Current (main)', theirsLabel: 'Incoming (topic)' };
      }
      if (command === 'repository_resolve_conflict') {
        if (args.fingerprint !== String(f.conflictVersion)) throw new Error('Stale conflict');
        f.saved = args.resolution; f.conflict = false; f.version++; return;
      }
      if (command === 'repository_remotes') { if (f.failRemotes) throw new Error('Remote read fixture failed'); return [{ name: 'origin', fetchUrl: 'https://github.com/example/repo.git', pushUrl: 'https://github.com/example/repo.git', branches: ['main', 'topic'], currentUpstream: 'main' }]; }
      if (command === 'repository_sync_info') return { branch: 'main', upstream: f.noUpstream ? null : 'origin/main', ahead: 0, behind: 0, remotes: ['origin'] };
      if (command === 'open_external_url') { if (f.failExternal) throw new Error('Browser launch fixture failed'); return; }
      // The focused tab auto-fetches on open; it has no effect on this fixture.
      if (command === 'repository_remote_action' && args.action.kind === 'backgroundFetch') return { output: '' };
      if (command === 'repository_remote_action') return { output: 'synced' };
      throw new Error(`Unexpected command: ${command}`);
    } };
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByRole('button', { name: 'Open repository', exact: true }).click();
  await page.getByRole('button', { name: 'Native /fixture' }).click();
  await page.getByRole('option', { name: /^Commit c0,/ }).waitFor();
  const writes = () => page.evaluate(() => window.fixture.calls.filter(call => ['repository_run_operation', 'repository_resolve_conflict'].includes(call.command)));

  // Actual reference drag only opens review. Cancel is read-only and preserves scroll.
  // Local `topic` and remote `origin/topic` both render a ref-pill whose
  // aria-label contains the substring "topic" (e.g. "Graph actions for
  // origin/topic"), so an exact accessible-name match is required to isolate
  // the local branch's pill specifically.
  const topic = page.getByRole('button', { name: 'Graph actions for topic', exact: true });
  const main = page.locator('.ref-pill[data-current=true]');
  const beforeScroll = await page.locator('.history-scroll').evaluate(el => el.scrollTop);
  const drop = async (target, source, type = 'application/x-gitty-ref') => { const dataTransfer = await page.evaluateHandle(({ value, type }) => { const data = new DataTransfer(); data.setData(type, value); return data; }, { value: source, type }); await target.dispatchEvent('drop', { dataTransfer }); await dataTransfer.dispose(); };
  for (const invalid of ['c2', 'refs/heads/missing', 'refs/tags/v1', 'refs/heads/main']) {
    await drop(main, invalid);
    assert.equal(await page.getByRole('dialog', { name: 'Git actions' }).count(), 0);
  }
  await drop(topic, 'refs/heads/main');
  assert.equal(await page.getByRole('dialog', { name: 'Git actions' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Graph actions for v1', exact: true }).getAttribute('draggable'), 'false');
  await topic.dragTo(main);
  await page.getByRole('dialog', { name: 'Git actions' }).waitFor();
  assert.equal(await page.locator('input[name="operation-action"]:checked').inputValue(), 'merge');
  assert.equal((await writes()).length, 0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.locator('.history-scroll').evaluate(el => el.scrollTop), beforeScroll);
  assert.equal((await writes()).length, 0);

  const summary = page.getByRole('region', { name: 'Operation summary', exact: true });
  const sidebarMain = page.locator('.ref-item[title="refs/heads/main"]');
  const commitSubject = page.getByRole('option', { name: /^Commit c1,/ }).locator('.subject');
  // Real commit subject drags retain the oid and only offer a reviewed cherry-pick.
  for (const target of [main, sidebarMain]) {
    for (const invalid of ['unknown-oid', 'refs/heads/topic', 'gitty:working-tree', '']) {
      await drop(target, invalid, 'application/x-gitty-commit');
      assert.equal(await page.getByRole('dialog', { name: 'Git actions' }).count(), 0);
    }
    await commitSubject.dragTo(target);
    assert.equal(await page.locator('input[name="operation-action"]:checked').inputValue(), 'cherryPick');
    assert.equal(await page.getByRole('button', { name: 'Remove c1', exact: true }).count(), 1);
    await page.getByRole('button', { name: 'Review operation', exact: true }).click();
    await summary.getByRole('heading', { name: 'Cherry-pick commits', exact: true }).waitFor();
    await summary.getByText('Destination: Local branch main', { exact: true }).waitFor();
    assert.deepEqual(await summary.getByRole('list', { name: 'Cherry-pick application order' }).getByRole('listitem').allTextContents(), ['c1 — Commit c1']);
    assert.equal(await page.locator('.operation-review').isVisible(), false);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal((await writes()).length, 0);
  }
  for (const target of [topic, page.locator('.ref-item[title="refs/heads/topic"]')]) {
    await drop(target, 'c1', 'application/x-gitty-commit');
    assert.equal(await page.getByRole('dialog', { name: 'Git actions' }).count(), 0);
  }
  await drop(main, 'c1', 'text/plain');
  assert.equal(await page.getByRole('dialog', { name: 'Git actions' }).count(), 0);
  // A branch drag must not inherit a commit payload or become a cherry-pick.
  const mixed = await page.evaluateHandle(() => { const data = new DataTransfer(); data.setData('application/x-gitty-commit', 'c1'); return data; });
  await topic.dispatchEvent('dragstart', { dataTransfer: mixed });
  assert.deepEqual(await mixed.evaluate(data => [...data.types]), ['application/x-gitty-ref']);
  await main.dispatchEvent('drop', { dataTransfer: mixed });
  await mixed.dispose();
  assert.equal(await page.locator('input[name="operation-action"]:checked').inputValue(), 'merge');
  await page.getByRole('button', { name: 'Review operation', exact: true }).click();
  await summary.getByText('Source: Local branch topic', { exact: true }).waitFor();
  await summary.getByText('Destination: Local branch main', { exact: true }).waitFor();
  await summary.getByText('Fast-forward policy: Allow fast-forward when possible; otherwise create a merge commit.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Always create a merge commit', exact: true }).check();
  await page.getByRole('button', { name: 'Review operation', exact: true }).click();
  await summary.getByText('Fast-forward policy: Always create a merge commit (--no-ff).', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await writes()).length, 0);
  for (const target of [main, page.getByRole('button', { name: 'Actions for main', exact: true })]) {
    await target.click();
    assert.equal(await page.locator('input[name="operation-action"]:checked').inputValue(), 'createBranch');
    assert.equal(await page.getByRole('combobox', { name: 'Source / starting revision', exact: true }).inputValue(), 'refs/heads/main');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
  // Both payload types autoscroll virtual history; dropping stops the animation.
  for (const type of ['application/x-gitty-ref', 'application/x-gitty-commit']) {
    const transfer = await page.evaluateHandle(type => { const data = new DataTransfer(); data.setData(type, type.endsWith('-ref') ? 'refs/heads/topic' : 'c1'); return data; }, type);
    const scroller = page.locator('.history-scroll');
    const bounds = await scroller.boundingBox();
    await scroller.dispatchEvent('dragover', { dataTransfer: transfer, clientY: bounds.y + bounds.height - 2 });
    await page.waitForFunction(() => document.querySelector('.history-scroll').scrollTop > 30);
    await scroller.dispatchEvent('drop', { dataTransfer: transfer });
    await transfer.dispose();
    const stopped = await scroller.evaluate(el => el.scrollTop);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await scroller.evaluate(el => el.scrollTop), stopped);
    await scroller.evaluate(el => { el.scrollTop = 0; });
  }

  // Right click and the context-menu key show a compact menu; Enter keeps the direct dialog.
  for (const gesture of ['rightclick', 'Enter', 'Shift+F10']) {
    if (gesture === 'rightclick') await topic.click({ button: 'right' });
    else { await topic.focus(); await topic.press(gesture); }
    if (gesture !== 'Enter') {
      const menu = page.getByRole('menu', { name: 'Actions for topic' });
      await menu.waitFor();
      assert.equal(await page.getByRole('dialog', { name: 'Git actions' }).count(), 0);
      assert.equal(await menu.getByRole('menuitem', { name: 'Merge into current…' }).count(), 1);
      assert.equal(await menu.getByRole('menuitem', { name: 'Rebase current onto this…' }).count(), 1);
      assert.equal(await menu.getByRole('menuitem', { name: 'Copy reference name' }).count(), 1);
      await menu.getByRole('menuitem', { name: 'Create branch here…' }).click();
    }
    await page.getByRole('dialog', { name: 'Git actions' }).waitFor();
    assert.equal(await page.getByRole('combobox', { name: 'Source / starting revision', exact: true }).inputValue(), 'refs/heads/topic');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
  await main.click({ button: 'right' });
  const currentMenu = page.getByRole('menu', { name: 'Actions for main' });
  await currentMenu.getByRole('menuitem', { name: 'Pull (rebase)' }).click();
  await page.waitForFunction(() => window.fixture.calls.some(call => call.command === 'repository_remote_action' && call.args.action.pullMode === 'rebase'));
  await main.click({ button: 'right' });
  await currentMenu.getByRole('menuitem', { name: 'Push / Publish…' }).click();
  await page.waitForFunction(() => window.fixture.calls.some(call => call.command === 'repository_remote_action' && call.args.action.kind === 'push'));
  await page.evaluate(() => { window.fixture.noUpstream = true; });
  await main.click({ button: 'right' });
  await currentMenu.getByRole('menuitem', { name: 'Push / Publish…' }).click();
  await page.getByRole('dialog', { name: 'Publish branch' }).waitFor();
  await page.getByRole('dialog', { name: 'Publish branch' }).getByRole('button', { name: 'Cancel' }).click();
  await page.evaluate(() => { window.fixture.noUpstream = false; });
  await page.getByRole('option', { name: /^Commit c1,/ }).click({ button: 'right' });
  const commitMenu = page.getByRole('menu', { name: 'Commit actions' });
  assert.equal(await commitMenu.getByRole('menuitem', { name: 'Create tag here…' }).count(), 1);
  assert.equal(await commitMenu.getByRole('menuitem', { name: 'Set as comparison base' }).count(), 1);
  await commitMenu.getByRole('menuitem', { name: 'Cherry-pick commit…' }).click();
  assert.equal(await page.locator('input[name="operation-action"]:checked').inputValue(), 'cherryPick');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('.ref-item[title="refs/heads/topic"]').click({ button: 'right' });
  const sidebarMenu = page.getByRole('menu', { name: 'Actions for topic' });
  await sidebarMenu.getByRole('menuitem', { name: 'Switch to topic…' }).waitFor();
  assert.equal(await sidebarMenu.getByRole('menuitem', { name: 'Create pull request…' }).count(), 1);
  assert.equal(await sidebarMenu.getByRole('menuitem', { name: 'Push / Publish…' }).count(), 0);
  await page.keyboard.press('Escape');
  assert.equal(await sidebarMenu.count(), 0);
  await page.locator('.ref-pill[data-name="origin/topic"]').click({ button: 'right' });
  await page.getByRole('menu', { name: 'Actions for origin/topic' }).getByRole('menuitem', { name: 'Fetch this remote branch' }).click();
  await page.waitForFunction(() => window.fixture.calls.some(call => call.command === 'repository_remote_action' && call.args.action.kind === 'fetch' && call.args.action.remote === 'origin' && call.args.action.branch === 'topic'));

  // Tags and remote-tracking refs have explicit PR restrictions; no prefix guessing.
  await page.getByRole('button', { name: 'Graph actions for v1', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Create pull request…' }).isDisabled(), true);
  await page.getByText('Tags cannot be pull-request source branches.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('summary').filter({ hasText: 'Remote branches' }).click();
  await page.getByRole('button', { name: 'Actions for origin/topic', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Create pull request…' }).isDisabled(), true);
  await page.getByText('Create or check out a local branch from this remote-tracking ref first.', { exact: false }).waitFor();
  assert.equal(await page.getByRole('combobox', { name: 'Source / starting revision', exact: true }).inputValue(), 'refs/remotes/origin/topic');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.evaluate(() => window.fixture.calls.filter(call => call.command === 'open_external_url').length), 0);

  // Keyboard actions and explicit ordered multi-commit review.
  await page.locator('.history-scroll').focus();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menu', { name: 'Commit actions' }).getByRole('menuitem', { name: 'More Git actions…' }).click();
  await page.getByRole('dialog', { name: 'Git actions' }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Branch', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Start cherry-pick sequence…', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Cherry-pick c2', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Cherry-pick c1', exact: true }).check();
  // New/Switch branch and cherry-pick are consolidated into a single "Branch"
  // dropdown menu; cherry-pick only appears there once commits are picked.
  await page.getByRole('button', { name: 'Branch', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Cherry-pick 2 selected…', exact: true }).click();
  await page.getByRole('button', { name: 'Move c1 earlier', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Review operation', exact: true }).isDisabled(), true);
  await page.getByRole('combobox', { name: 'Mainline parent (applies to each merge in this sequence)', exact: true }).selectOption('2');
  await page.getByRole('button', { name: 'Review operation', exact: true }).click();
  await page.getByRole('button', { name: 'Execute operation', exact: true }).waitFor();
  assert.deepEqual(await summary.getByRole('listitem').allTextContents(), ['c1 — Commit c1', 'c2 — Commit c2 · Mainline parent 2: c4']);
  await page.evaluate(() => { window.fixture.version++; });
  await page.getByRole('button', { name: 'Execute operation', exact: true }).click();
  await page.getByText('Reviewed state is stale', { exact: true }).waitFor();
  const first = (await writes())[0];
  assert.deepEqual(first.args.request.action.commits, ['c1', 'c2']);
  assert.equal(first.args.request.action.mainline, 2);
  assert.equal(first.args.request.expectedOperation, '0');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  // An uncertain write must refresh and then block further writes on refresh failure.
  await page.getByRole('button', { name: 'Actions for topic', exact: true }).click();
  await page.getByRole('button', { name: 'Review operation', exact: true }).click();
  await page.getByRole('button', { name: 'Execute operation', exact: true }).waitFor();
  await page.evaluate(() => { window.fixture.failAfterWrite = true; window.fixture.holdWrite = true; });
  const beforeUncertain = (await writes()).length;
  await page.getByRole('button', { name: 'Execute operation', exact: true }).evaluate(button => { button.click(); button.click(); });
  await page.waitForFunction(() => window.fixture.writeWaiting);
  assert.equal((await writes()).length, beforeUncertain + 1);
  assert.equal(await page.getByRole('button', { name: 'Cancel', exact: true }).isDisabled(), true);
  await page.evaluate(() => { window.fixture.holdWrite = false; window.fixture.releaseWrite(); });
  await page.getByText(/Uncertain write fixture/).waitFor();
  // Cancel stays enabled after refresh blocking so the user can retry refresh outside the dialog.
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  // New branch/Switch branch/Cherry-pick are menu items inside the "Branch"
  // dropdown and only exist in the DOM while that menu is open; while blocked
  // the toggle itself is disabled, so the menu can never be opened at all.
  // Checking the toggle is therefore the equivalent (if anything stronger)
  // assertion that branch actions are unavailable.
  assert.equal(await page.getByRole('button', { name: 'Branch', exact: true }).isDisabled(), true);
  await page.evaluate(() => { window.fixture.failRefresh = false; window.fixture.failAfterWrite = false; });
  // The toolbar's own "Refresh" convenience button is bundled with the
  // general busy/blocked state (like the rest of the toolbar) and is
  // therefore also disabled right now; recovery instead uses the blocked-
  // state banner's dedicated, always-enabled "Refresh now" action.
  await page.getByRole('button', { name: 'Refresh now', exact: true }).click();
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find(el => el.textContent.trim() === 'Branch')?.disabled);

  // Conflict content is read in full. Dirty edits survive focus/polling and external changes.
  await page.evaluate(() => { window.fixture.kind = 'merge'; window.fixture.conflict = true; window.fixture.version++; window.dispatchEvent(new Event('focus')); });
  await page.getByRole('button', { name: 'Resolve file.txt', exact: true }).click();
  await page.getByRole('button', { name: 'Accept both', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Editable result', exact: true }).inputValue(), 'ours\ntheirs\ntail');
  const readsBefore = await page.evaluate(() => window.fixture.calls.filter(call => call.command === 'repository_conflict_file').length);
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); });
  await page.waitForFunction(count => window.fixture.calls.filter(call => call.command === 'repository_conflict_file').length > count, readsBefore);
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find(el => el.textContent === 'Save result & mark resolved')?.disabled);
  assert.equal(await page.getByRole('textbox', { name: 'Editable result', exact: true }).inputValue(), 'ours\ntheirs\ntail');
  await page.evaluate(() => { window.fixture.failConflictRead = true; window.dispatchEvent(new Event('focus')); });
  await page.getByRole('alert').filter({ hasText: 'Conflict status could not be confirmed' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save result & mark resolved' }).isDisabled(), true);
  assert.equal(await page.getByRole('textbox', { name: 'Editable result', exact: true }).inputValue(), 'ours\ntheirs\ntail');
  await page.evaluate(() => { window.fixture.failConflictRead = false; });
  await page.getByRole('button', { name: 'Retry conflict read', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Conflict status could not be confirmed' }).waitFor({ state: 'hidden' });
  await page.evaluate(() => { window.fixture.conflictVersion++; window.fixture.conflictText = 'external\r\n'; window.dispatchEvent(new Event('focus')); });
  await page.getByText(/This file changed outside this editor/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save result & mark resolved' }).isDisabled(), true);
  assert.equal(await page.getByRole('textbox', { name: 'Editable result', exact: true }).inputValue(), 'ours\ntheirs\ntail');
  await page.getByRole('button', { name: 'Discard editor edits and load external version' }).click();
  await page.getByRole('textbox', { name: 'Editable result', exact: true }).fill('edited\nwithout final newline');
  const beforeSave = (await writes()).length;
  await page.getByRole('button', { name: 'Save result & mark resolved' }).evaluate(button => { button.click(); button.click(); });
  await page.getByRole('dialog', { name: 'Resolve file.txt' }).waitFor({ state: 'hidden' });
  assert.deepEqual(await page.evaluate(() => window.fixture.saved), { kind: 'text', content: 'edited\r\nwithout final newline' });
  assert.equal((await writes()).length, beforeSave + 1);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Review operation', exact: true }).click();
  await page.getByRole('button', { name: 'Execute operation', exact: true }).click();
  await page.getByRole('dialog', { name: 'Git actions' }).waitFor({ state: 'hidden' });
  assert.deepEqual((await writes()).at(-1).args.request.action, { kind: 'continue' });

  // An absent side must submit explicit deletion, not a request for a missing stage.
  for (const side of ['ours', 'theirs']) {
    await page.evaluate(side => { window.fixture.deletedSide = side; window.fixture.kind = 'merge'; window.fixture.conflict = true; window.fixture.version++; window.fixture.conflictVersion++; window.dispatchEvent(new Event('focus')); }, side);
    await page.getByRole('button', { name: 'Resolve file.txt', exact: true }).click();
    await page.getByRole('button', { name: `Accept deletion (${side === 'ours' ? 'Current (main)' : 'Incoming (topic)'})`, exact: true }).click();
    await page.getByRole('dialog', { name: 'Resolve file.txt' }).waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(() => window.fixture.saved), { kind: 'delete' });
  }
  await page.evaluate(() => { window.fixture.deletedSide = null; window.fixture.kind = 'none'; window.fixture.version++; window.dispatchEvent(new Event('focus')); });
  await page.getByRole('button', { name: 'Continue', exact: true }).waitFor({ state: 'hidden' });

  // Remaining actions send the exact backend DTO after an explicit review.
  const execute = async (expected, descriptions = []) => {
    await page.getByRole('button', { name: 'Review operation', exact: true }).click();
    await summary.waitFor();
    for (const description of descriptions) await summary.getByText(description, { exact: true }).waitFor();
    assert.deepEqual(JSON.parse(await page.locator('.operation-review').textContent()), expected);
    await page.getByRole('button', { name: 'Execute operation', exact: true }).click();
    await page.getByRole('dialog', { name: 'Git actions' }).waitFor({ state: 'hidden' });
    assert.deepEqual((await writes()).at(-1).args.request.action, expected);
  };
  await page.getByRole('button', { name: 'Branch', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New branch…', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('feature/review');
  await execute({ kind: 'createBranch', name: 'feature/review', startPoint: 'refs/heads/main', checkout: true }, ['Source (starting revision): Local branch main', 'Destination: Local branch feature/review', 'Switch to the new branch after creating it.']);
  await page.getByRole('button', { name: 'Branch', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Switch branch…', exact: true }).click();
  await page.getByRole('combobox', { name: 'Local branch', exact: true }).fill('refs/heads/missing');
  assert.equal(await page.getByRole('button', { name: 'Review operation', exact: true }).isDisabled(), true);
  await page.getByRole('combobox', { name: 'Local branch', exact: true }).fill('refs/heads/topic');
  await execute({ kind: 'switchBranch', branch: 'refs/heads/topic' }, ['From: Local branch main', 'Destination: Local branch topic']);
  await page.getByRole('button', { name: 'Actions for topic', exact: true }).click();
  await page.getByRole('radio', { name: /Rebase/ }).check();
  await execute({ kind: 'rebase', onto: 'refs/heads/topic' }, ['Source branch to replay: Local branch main', 'Destination (new base): Local branch topic']);
  await page.getByRole('button', { name: 'Actions for c1', exact: true }).click();
  await page.getByRole('radio', { name: 'Create tag', exact: true }).check();
  await page.getByLabel('Name', { exact: true }).fill('reviewed-v1');
  await page.getByLabel('Annotation (empty for lightweight tag)', { exact: true }).fill('Reviewed release');
  await execute({ kind: 'createTag', name: 'reviewed-v1', oid: 'c1', message: 'Reviewed release' }, ['Source commit: c1', 'Destination: Tag reviewed-v1', 'Tag type: Annotated', 'Annotation: Reviewed release']);
  for (const kind of ['skip', 'abort']) {
    await page.evaluate(() => { window.fixture.kind = 'rebase'; window.fixture.version++; window.dispatchEvent(new Event('focus')); });
    await page.getByRole('button', { name: kind === 'skip' ? 'Skip' : 'Abort', exact: true }).click();
    await execute({ kind });
  }

  await page.evaluate(() => { window.fixture.failRemotes = true; });
  await page.getByRole('button', { name: 'Actions for topic', exact: true }).click();
  await page.getByRole('button', { name: 'Create pull request…' }).click();
  await page.getByRole('alert').filter({ hasText: 'Remote read fixture failed' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Open provider form' }).isDisabled(), true);
  await page.evaluate(() => { window.fixture.failRemotes = false; });
  await page.getByRole('button', { name: 'Reload remotes', exact: true }).click();
  await page.getByText('A locally known origin/topic exists.', { exact: false }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Open provider form' }).isDisabled(), true);
  await page.getByLabel('Base branch', { exact: true }).fill('topic');
  assert.equal(await page.getByRole('button', { name: 'Open provider form' }).isDisabled(), true);
  await page.getByLabel('Base branch', { exact: true }).fill('main');
  await page.evaluate(() => { window.fixture.failExternal = true; });
  await page.getByRole('button', { name: 'Open provider form' }).click();
  await page.getByRole('alert').filter({ hasText: 'Browser launch fixture failed' }).waitFor();
  assert.equal(await page.getByLabel('Base branch', { exact: true }).inputValue(), 'main');
  await page.evaluate(() => { window.fixture.failExternal = false; });
  await page.getByRole('button', { name: 'Open provider form' }).click();
  await page.getByRole('dialog', { name: 'Create pull request' }).waitFor({ state: 'hidden' });
  const external = await page.evaluate(() => window.fixture.calls.find(call => call.command === 'open_external_url'));
  assert.match(external.args.url, /github\.com\/example\/repo\/compare\/main\.\.\.topic/);
  await page.evaluate(() => { window.fixture.showWorking = true; window.fixture.version++; window.dispatchEvent(new Event('focus')); });
  const workingSubject = page.getByRole('option', { name: /^Working changes/ }).locator('.subject');
  await workingSubject.waitFor();
  assert.equal(await workingSubject.getAttribute('draggable'), 'false');
  const pseudoDrag = await page.evaluateHandle(() => new DataTransfer());
  await workingSubject.dispatchEvent('dragstart', { dataTransfer: pseudoDrag });
  assert.deepEqual(await pseudoDrag.evaluate(data => [...data.types]), []);
  await pseudoDrag.dispose();
  assert.deepEqual(errors, []);
  console.log('Operations smoke passed (mocked native IPC): branch/commit current-target graph/sidebar drops, invalid/pseudo-row payload rejection, cancel without writes, both drag autoscroll types, current-branch create default, readable source/destination/order/mainline/fast-forward reviews, right-click/keyboard parity, immutable stale review, duplicate-submit lock, uncertain write/refresh recovery, conflict reread/external dirty edits, CRLF, operation DTOs, provider restrictions/failure/retry.');
} finally { await browser.close(); await server.close(); }
