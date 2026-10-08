// Optional browser QA: demo plus mocked Tauri IPC, never a real native repository.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node src/components/settings.smoke.mjs
// Optional SCREENSHOT_DIR=/existing/directory writes desktop and narrow screenshots.
// Optional SETTINGS_SMOKE_URL=http://127.0.0.1:5173 reuses an existing preview server.
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = process.env.SETTINGS_SMOKE_URL ? null : await createServer({ server: { host: '127.0.0.1', port: 5189, strictPort: false }, logLevel: 'error' });
let browser;
const errors = [];
const checks = [];
const presets = [
  ['gitty-light', 'light', '#fafafa', '#2563a8'], ['gitty-dark', 'dark', '#141416', '#6ea8f0'],
  ['gruvbox-light', 'light', '#fbf1c7', '#076678'], ['gruvbox-dark', 'dark', '#282828', '#8ec07c'],
  ['dracula', 'dark', '#282a36', '#bd93f9'], ['nord', 'dark', '#2e3440', '#88c0d0'],
  ['catppuccin-latte', 'light', '#eff1f5', '#8839ef'], ['catppuccin-mocha', 'dark', '#1e1e2e', '#cba6f7'],
];
const check = async (name, run) => { await run(); checks.push(name); console.log(`PASS ${name}`); };
const stored = page => page.evaluate(() => localStorage.getItem('gitty:settings'));
const preferences = async page => JSON.parse(await stored(page));
const button = (page, name) => page.getByRole('button', { name, exact: true });
const select = (page, name) => page.getByRole('combobox', { name, exact: true });
const dialog = page => page.getByRole('dialog', { name: 'Settings', exact: true });
const open = async page => {
  await button(page, 'Open settings').click();
  await dialog(page).waitFor();
  assert.equal(await dialog(page).locator('.dialog-body').evaluate(el => el.clientHeight > 100), true, 'settings body must not collapse in an auto-height flex dialog');
  await button(page, 'Appearance').click();
};
const close = async page => { await button(page, 'Close dialog').click(); await dialog(page).waitFor({ state: 'hidden' }); };
const token = (page, name) => page.evaluate(key => getComputedStyle(document.documentElement).getPropertyValue(key).trim(), name);
async function painted(page, mode, bg, graph) {
  await page.waitForFunction(({ mode, bg, graph }) => {
    const root = document.documentElement;
    if (root.dataset.theme !== mode || getComputedStyle(root).getPropertyValue('--bg').trim() !== bg) return false;
    const settings = document.querySelector('.settings-dialog[open]');
    if (settings) {
      const rgbToken = token => `rgb(${[1, 3, 5].map(i => parseInt(getComputedStyle(root).getPropertyValue(token).trim().slice(i, i + 2), 16)).join(', ')})`;
      for (const [selector, property, token] of [['.primary-button', 'color', '--button-foreground'], ['.secondary-button', 'color', '--text'], ['.text-button', 'color', '--accent-text']]) {
        const control = settings.querySelector(selector);
        if (control && getComputedStyle(control)[property] !== rgbToken(token)) return false;
      }
    }
    const canvas = document.querySelector('.graph-canvas');
    if (!canvas?.width || !canvas.height) return false;
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const palette = Array.from({ length: 8 }, (_, index) => {
      const color = getComputedStyle(root).getPropertyValue(`--graph-lane${index + 1}`).trim();
      return [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
    });
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] === 255 && palette.some(rgb => pixels[i] === rgb[0] && pixels[i + 1] === rgb[1] && pixels[i + 2] === rgb[2])) return true;
    }
    return false;
  }, { mode, bg, graph });
}
async function screenshot(page, name) {
  if (!process.env.SCREENSHOT_DIR) return;
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/settings-${name}.png`, fullPage: true });
}
async function upload(page, value) {
  await page.getByLabel('Import theme JSON').setInputFiles({ name: 'theme.json', mimeType: 'application/json', buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) });
}

try {
  await server?.listen();
  browser = await chromium.launch({ headless: true });
  const url = process.env.SETTINGS_SMOKE_URL || server.resolvedUrls.local[0];
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(15_000);
  await page.goto(url);
  const history = page.getByRole('listbox', { name: 'Commit history' });
  await history.waitFor();

  await check('Cmd+, / Ctrl+, focus restoration, trapped focus, search/selection/scroll retention', async () => {
    await history.press('PageDown');
    const before = await history.evaluate(el => ({ selected: el.getAttribute('aria-activedescendant'), scroll: el.scrollTop }));
    await page.keyboard.press('Meta+,');
    await dialog(page).waitFor();
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press(i < 15 ? 'Tab' : 'Shift+Tab');
      // Native dialogs may tab to browser chrome (reported as body), but never to the inert workspace.
      assert.equal(await dialog(page).evaluate(el => el.contains(document.activeElement) || document.activeElement === document.body), true);
    }
    await page.keyboard.press('Escape');
    assert.equal(await history.evaluate(el => el === document.activeElement), true);
    assert.deepEqual(await history.evaluate(el => ({ selected: el.getAttribute('aria-activedescendant'), scroll: el.scrollTop })), before);
    const search = page.getByLabel('Search full history');
    await search.fill('theme');
    await page.keyboard.press('Control+,');
    await dialog(page).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await search.inputValue(), 'theme');
    assert.equal(await search.evaluate(el => el === document.activeElement), true);
    await search.fill('');
    await history.press('Home');
  });

  await open(page);
  assert.equal(await dialog(page).evaluate(el => el.getBoundingClientRect().width), 1000, 'desktop settings width must survive global dialog styles');
  assert.equal(await dialog(page).evaluate(el => el.scrollWidth <= el.clientWidth), true, 'desktop settings must not overflow horizontally');
  await check('all eight presets repaint CSS and actual history canvas pixels', async () => {
    await select(page, 'Theme behavior').selectOption('fixed');
    for (const [id, mode, bg, graph] of presets) {
      await select(page, 'Theme').selectOption(id);
      await painted(page, mode, bg, graph);
      assert.equal((await preferences(page)).themeId, id);
      assert.equal(await token(page, '--graph-lane1'), graph);
      await screenshot(page, id);
    }
  });
  await check('system appearance pairs react to OS changes; fixed mode stays fixed', async () => {
    await select(page, 'Theme behavior').selectOption('system');
    await select(page, 'Light appearance').selectOption('gruvbox-light');
    await select(page, 'Dark appearance').selectOption('nord');
    await painted(page, ...presets[2].slice(1));
    await page.emulateMedia({ colorScheme: 'dark' });
    await painted(page, ...presets[5].slice(1));
    await page.emulateMedia({ colorScheme: 'light' });
    await painted(page, ...presets[2].slice(1));
    await select(page, 'Theme behavior').selectOption('fixed');
    await select(page, 'Theme').selectOption('gitty-light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await painted(page, ...presets[0].slice(1));
  });
  await check('custom preview cancel/reset/discard restores palette without persisting', async () => {
    const before = await stored(page);
    await button(page, 'Duplicate & customize').click();
    await page.getByLabel('Theme name', { exact: true }).fill('Discard me');
    await page.getByLabel('bg hex color', { exact: true }).fill('#123456');
    await page.getByLabel('graphSelection hex color', { exact: true }).fill('#fedcba');
    await painted(page, 'light', '#123456', '#fedcba');
    assert.equal(await stored(page), before);
    await button(page, 'Reset edits').click();
    await painted(page, ...presets[0].slice(1));
    await page.getByLabel('bg hex color', { exact: true }).fill('#123456');
    await button(page, 'Cancel edits').click();
    await painted(page, ...presets[0].slice(1));
    assert.equal(await stored(page), before);
    await button(page, 'Duplicate & customize').click();
    await page.keyboard.press('Escape');
    await page.getByText('Discard your unsaved theme edits?', { exact: true }).waitFor();
    await button(page, 'Keep editing').click();
    await page.keyboard.press('Escape');
    await button(page, 'Cancel edits').click();
    assert.equal(await page.getByText('Discard your unsaved theme edits?', { exact: true }).count(), 0, 'canceling the draft clears its discard prompt');
    await button(page, 'Duplicate & customize').click();
    await page.getByLabel('Theme name', { exact: true }).fill('Discard on close');
    // Repeated Escape can produce a non-cancelable native dialog cancel event.
    // The editor must handle the key before that default close drops its preview guard.
    await page.keyboard.press('Escape');
    await dialog(page).waitFor();
    await page.getByText('Discard your unsaved theme edits?', { exact: true }).waitFor();
    await button(page, 'Discard and close').click();
    await dialog(page).waitFor({ state: 'hidden' });
    assert.equal(await stored(page), before);
    await painted(page, ...presets[0].slice(1));
    await open(page);
  });
  let exported;
  let customId;
  await check('custom save, invalid/empty hex validation, JSON download', async () => {
    await button(page, 'Duplicate & customize').click();
    await page.getByLabel('Theme name', { exact: true }).fill('QA custom');
    const bg = page.getByLabel('bg hex color', { exact: true });
    for (const invalid of ['url(https://example.test)', '']) {
      await bg.fill(invalid);
      assert.equal(await bg.getAttribute('aria-invalid'), 'true');
      assert.equal(await button(page, 'Save theme').isDisabled(), true);
      assert.equal(await button(page, 'Export preview JSON').isDisabled(), true);
      assert.equal(await token(page, '--bg'), '#fafafa');
    }
    await bg.fill('#123456');
    await page.getByLabel('graphSelection hex color', { exact: true }).fill('#fedcba');
    await button(page, 'Save theme').click();
    await page.getByText('Theme saved and selected.', { exact: true }).waitFor();
    await painted(page, 'light', '#123456', '#fedcba');
    customId = (await preferences(page)).themeId;
    const downloadPromise = page.waitForEvent('download');
    await button(page, 'Export active theme JSON').click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'QA-custom.gitty-theme.json');
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    exported = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(exported.version, 1);
    assert.equal(exported.theme.id, customId);
    assert.equal(exported.theme.colors.bg, '#123456');
  });
  await check('JSON import rejects malformed/version/token/injection/oversize input atomically', async () => {
    const before = await stored(page);
    const missing = structuredClone(exported); delete missing.theme.colors.graphHead;
    const unknown = structuredClone(exported); unknown.theme.colors.remote = '#ffffff';
    const injection = structuredClone(exported); injection.theme.colors.bg = 'url(https://example.test)';
    const alpha = structuredClone(exported); alpha.theme.colors.text = '#ffffff88';
    for (const bad of ['{bad', { ...exported, version: 2 }, missing, unknown, injection, alpha, ' '.repeat(100_001)]) {
      await upload(page, bad);
      await dialog(page).locator('.settings-error').waitFor();
      await page.waitForFunction(() => !document.querySelector('input[aria-label="Import theme JSON"]').disabled);
      assert.equal(await stored(page), before);
      assert.equal(await page.getByLabel('Theme name', { exact: true }).count(), 0);
      await painted(page, 'light', '#123456', '#fedcba');
    }
  });
  await check('late JSON import cannot replace state after close/reopen', async () => {
    const before = await stored(page);
    await page.evaluate(() => {
      window.originalFileText = File.prototype.text;
      File.prototype.text = function () {
        return new Promise(resolve => { window.releaseThemeRead = async () => resolve(await window.originalFileText.call(this)); });
      };
    });
    await upload(page, exported);
    await page.getByText('Reading theme…', { exact: true }).waitFor();
    await close(page);
    await open(page);
    await page.evaluate(async () => { File.prototype.text = window.originalFileText; await window.releaseThemeRead(); });
    assert.equal(await page.getByLabel('Theme name', { exact: true }).count(), 0);
    assert.equal(await stored(page), before);
  });
  await check('JSON import copy, cancel/save, rename, mode-reference repair and deletion', async () => {
    const before = await stored(page);
    await upload(page, exported);
    await page.getByLabel('Theme name', { exact: true }).waitFor();
    assert.equal(await stored(page), before);
    await button(page, 'Cancel edits').click();
    assert.equal(await stored(page), before);
    assert.equal(await page.getByText('Imported as an unsaved copy. Review and save to keep it.', { exact: true }).count(), 0);
    await upload(page, exported);
    await page.getByLabel('Theme name', { exact: true }).fill('Imported copy');
    await button(page, 'Save theme').click();
    const copyId = (await preferences(page)).themeId;
    assert.notEqual(copyId, customId);
    assert.equal((await preferences(page)).customThemes.length, 2);
    await button(page, 'Edit / rename').click();
    await page.getByLabel('Theme name', { exact: true }).fill('Renamed copy');
    await button(page, 'Save theme').click();
    assert.equal((await preferences(page)).customThemes.find(theme => theme.id === copyId).name, 'Renamed copy');
    await select(page, 'Theme behavior').selectOption('system');
    await select(page, 'Light appearance').selectOption(copyId);
    await page.emulateMedia({ colorScheme: 'light' });
    await button(page, 'Edit / rename').click();
    await select(page, 'Appearance').selectOption('dark');
    await button(page, 'Save theme').click();
    assert.equal((await preferences(page)).lightThemeId, 'gitty-light');
    await select(page, 'Theme behavior').selectOption('system');
    await select(page, 'Dark appearance').selectOption(copyId);
    await page.emulateMedia({ colorScheme: 'dark' });
    await button(page, 'Edit / rename').click();
    await button(page, 'Delete theme').click();
    await button(page, 'Keep theme').click();
    assert.equal((await preferences(page)).customThemes.length, 2);
    await button(page, 'Delete theme').click();
    await button(page, 'Confirm deletion').click();
    const saved = await preferences(page);
    assert.equal(saved.customThemes.length, 1);
    assert.equal(saved.darkThemeId, 'gitty-dark');
    assert.equal(saved.themeId, 'gitty-dark');
    await painted(page, ...presets[1].slice(1));
    await select(page, 'Theme behavior').selectOption('fixed');
    await select(page, 'Theme').selectOption(customId);
  });
  await check('editor defaults, bundled fonts, wrap/layout and custom theme survive reload', async () => {
    await button(page, 'Editor & diffs').click();
    assert.equal(await page.getByLabel('Default diff layout').inputValue(), 'unified');
    assert.equal(await page.getByLabel('Wrap long diff lines').isChecked(), false);
    assert.equal(await page.getByLabel('Code font (bundled locally)').inputValue(), 'Geist Mono Variable');
    assert.equal(await page.getByLabel('Code size: 13px').inputValue(), '13');
    await page.getByLabel('Default diff layout').selectOption('split');
    await page.getByLabel('Wrap long diff lines').check();
    await page.getByLabel('Code font (bundled locally)').selectOption('JetBrains Mono');
    await page.getByLabel('Code size: 13px').fill('17');
    const preview = dialog(page).locator('section:not([hidden]) .native-diff');
    assert.equal(await preview.evaluate(el => getComputedStyle(el).fontSize), '17px');
    assert.match(await preview.evaluate(el => getComputedStyle(el).fontFamily), /JetBrains Mono/);
    assert.equal(await preview.locator('pre').first().evaluate(el => getComputedStyle(el).whiteSpace), 'pre-wrap');
    assert.equal(await preview.evaluate(el => getComputedStyle(el).display), 'grid');
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.fonts.check('17px "JetBrains Mono"')), true);
    await close(page);
    await page.getByRole('option', { name: /^Working changes/ }).click();
    const summary = page.getByRole('textbox', { name: /Summary/ });
    await summary.fill('Settings must preserve this draft');
    await summary.press('Meta+,');
    await dialog(page).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await summary.inputValue(), 'Settings must preserve this draft');
    assert.equal(await summary.evaluate(el => el === document.activeElement), true);
    await button(page, 'Staged: src/styles/tokens.css').click();
    const diff = page.getByRole('region', { name: 'Diff for src/styles/tokens.css' }).locator('.native-diff');
    await diff.waitFor();
    assert.match(await diff.getAttribute('class'), /split/);
    assert.equal(await diff.evaluate(el => getComputedStyle(el).fontSize), '17px');
    const before = await stored(page);
    await page.reload();
    await history.waitFor();
    await painted(page, 'light', '#123456', '#fedcba');
    assert.equal(await stored(page), before);
    await open(page);
    await button(page, 'Editor & diffs').click();
    assert.equal(await page.getByLabel('Default diff layout').inputValue(), 'split');
    assert.equal(await page.getByLabel('Wrap long diff lines').isChecked(), true);
    assert.equal(await page.getByLabel('Code size: 17px').inputValue(), '17');
    await button(page, 'Reset editor preferences').click();
    assert.equal((await preferences(page)).fontSize, 13);
    assert.equal((await preferences(page)).monoFont, 'Geist Mono Variable');
    assert.equal((await preferences(page)).diffView, 'unified');
    assert.equal((await preferences(page)).diffWrap, false);
  });
  await check('pane resize persists in shared settings and reset updates mounted panes', async () => {
    await close(page);
    const sidebar = page.getByRole('separator', { name: 'Resize repository sidebar', exact: true });
    const inspector = page.getByRole('separator', { name: 'Resize inspector', exact: true });
    await sidebar.press('ArrowRight');
    await inspector.press('ArrowLeft');
    assert.deepEqual((await preferences(page)).paneWidths, { sidebar: 260, inspector: 420 });
    await page.reload();
    await history.waitFor();
    assert.equal(await sidebar.getAttribute('aria-valuenow'), '260');
    assert.equal(await inspector.getAttribute('aria-valuenow'), '420');
    await open(page);
    await button(page, 'Workspace reset').click();
    await button(page, 'Reset pane sizes').click();
    assert.deepEqual((await preferences(page)).paneWidths, { sidebar: 240, inspector: 400 });
    await close(page);
    assert.equal(await sidebar.getAttribute('aria-valuenow'), '240');
    assert.equal(await inspector.getAttribute('aria-valuenow'), '400');
    await open(page);
  });
  await check('narrow settings/editor remain within viewport with reachable actions', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await button(page, 'Appearance').click();
    await button(page, 'Edit / rename').click();
    await screenshot(page, 'narrow-editor');
    assert.equal(await dialog(page).evaluate(el => el.scrollWidth <= el.clientWidth), true);
    assert.equal(await dialog(page).evaluate(el => { const rect = el.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth; }), true);
    await button(page, 'Cancel edits').click();
    await button(page, 'About / shortcuts').click();
    await screenshot(page, 'narrow-shortcuts');
    assert.equal(await dialog(page).evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await close(page);
  });
  await page.close();

  await check('corrupt storage is untouched until explicit save; quota failure and retry', async () => {
    const recovery = await browser.newPage();
    recovery.on('pageerror', error => errors.push(error.message));
    await recovery.addInitScript(() => { localStorage.setItem('gitty:settings', '{broken'); });
    await recovery.goto(url);
    await open(recovery);
    await recovery.getByRole('alert').filter({ hasText: 'Stored preferences could not be read' }).waitFor();
    assert.equal(await stored(recovery), '{broken');
    await recovery.evaluate(() => { window.originalSetItem = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new DOMException('Quota', 'QuotaExceededError'); }; });
    await select(recovery, 'Theme behavior').selectOption('fixed');
    await select(recovery, 'Theme').selectOption('dracula');
    await painted(recovery, ...presets[4].slice(1));
    await recovery.getByRole('alert').filter({ hasText: 'could not be saved' }).waitFor();
    assert.equal(await stored(recovery), '{broken');
    await recovery.evaluate(() => { Storage.prototype.setItem = window.originalSetItem; });
    await button(recovery, 'Retry saving').click();
    assert.equal((await preferences(recovery)).themeId, 'dracula');
    assert.equal(await recovery.getByRole('alert').count(), 0);
    await recovery.close();
  });

  await check('mocked native workspace shares settings and repaints its history canvas', async () => {
    const native = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce' });
    native.on('pageerror', error => errors.push(error.message));
    await native.addInitScript(() => {
      window.isTauri = true;
      // Branches are colored by name and the checked-out branch uses the HEAD color, so the lane palette needs a second branch tip.
      const base = { id: 'def5678', parents: [], subject: 'Settings QA side branch', body: '', author: 'QA', email: 'qa@example.test', timestamp: 1699999999 };
      const commit = { id: 'abc1234', parents: [], subject: 'Settings QA fixture', body: '', author: 'QA', email: 'qa@example.test', timestamp: 1700000000 };
      const state = { session: { handle: 'settings-qa', name: 'settings-qa', root: '/fixture/settings', location: { kind: 'native', path: '/fixture/settings' }, gitDir: '/fixture/settings/.git', commonDir: '/fixture/settings/.git', head: commit.id, headRef: 'refs/heads/main', shallow: false, bare: false, linkedWorktree: false }, refs: [{ name: 'main', fullName: 'refs/heads/main', commitId: commit.id, kind: 'local' }, { name: 'side', fullName: 'refs/heads/side', commitId: base.id, kind: 'local' }], remotes: [], fingerprint: 'qa' };
      let callbackId = 0;
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
      window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } }, transformCallback: () => ++callbackId, unregisterCallback: () => {}, invoke: async (command, args) => {
        if (command.startsWith('plugin:webview|') || command.startsWith('plugin:window|')) return;
        if (command === 'plugin:event|listen') return 1;
        if (command === 'plugin:event|unlisten') return;
        if (command === 'repository_snapshot') { const [state, status, operation] = await Promise.all(['repository_state', 'repository_status', 'repository_operation_state'].map(name => window.__TAURI_INTERNALS__.invoke(name, args))); return { state, status, operation }; }
        if (command === 'repository_recent') return [state.session.location];
        if (command === 'wsl_distributions') return [];
        if (command === 'repository_open' || command === 'repository_state') return state;
        if (command === 'repository_close') return;
        if (command === 'repository_history') return { commits: [commit, base], cursor: null, generation: 'qa', shallow: false };
        if (command === 'repository_commit') return args.oid === base.id ? base : commit;
        if (command === 'repository_diff_files') return [];
        if (command === 'repository_status') return { head: commit.id, headRef: 'refs/heads/main', fingerprint: 'qa', entries: [] };
        if (command === 'repository_operation_state') return { kind: 'none', label: '', current: 'main', incoming: null, step: null, total: null, conflicts: [], canContinue: false, canSkip: false, fingerprint: 'qa' };
        throw Error(`Unexpected mocked IPC: ${command}`);
      } };
    });
    await native.goto(url);
    await native.getByRole('button', { name: /\/fixture\/settings$/ }).click();
    await native.getByRole('listbox', { name: 'Commit history' }).waitFor();
    await open(native);
    await select(native, 'Theme behavior').selectOption('fixed');
    for (const [id, mode, bg, graph] of presets) {
      await select(native, 'Theme').selectOption(id);
      await painted(native, mode, bg, graph);
    }
    await screenshot(native, 'mock-native');
    await close(native);
    await native.reload();
    await open(native);
    assert.equal(await select(native, 'Theme').inputValue(), 'catppuccin-mocha');
    await native.close();
  });
  assert.deepEqual(errors, [], 'browser runtime errors');
  console.log(`Settings browser smoke passed: ${checks.length} checks; zero page errors. Native coverage uses mocked IPC, not real Tauri.`);
} finally {
  await browser?.close();
  await server?.close();
}
