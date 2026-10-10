// Focused browser rendering of the real DiffPreview, with synthetic hunks and mocked writes.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { DiffPreview } from '/src/components/WorkingChanges.tsx';
import { SettingsProvider, useSettings } from '/src/model/settings.tsx';
import '/src/styles.css';
const line = (kind, content, oldLine = null, newLine = null) => ({ kind, content, oldLine, newLine });
const lines = [
  line('context', 'export function renderDiff(input) {', 101, 101),
  line('remove', '  const layout = "stacked";', 102),
  line('remove', '  const gutter = false;', 103),
  line('add', '  const layout = "side-by-side";', null, 102),
  line('add', '  const gutter = true;', null, 103),
  line('add', '  const alignReplacements = true;', null, 104),
  line('context', '  return render(layout, gutter);', 104, 105),
  line('context', '}', 105, 106),
];
const long = '  const description = "' + 'Long content with indentation and readable wrapped text. '.repeat(12) + '";';
const diff = { path: 'src/diff/render.ts', binary: false, truncated: false, message: null, hunkAction: { fingerprint: 'fixture', reason: null }, hunks: [
  { header: '@@ -101,5 +101,6 @@ export function renderDiff(input)', lines },
  { header: '@@ -201,2 +202,2 @@ long content', lines: [line('remove', long, 201), line('add', '  const description = "Short replacement";', null, 202), line('context', '  return description;', 202, 203)] },
  { header: '@@ -301,1 +302,2 @@ trailing metadata', lines: [line('remove', 'old ending', 301), line('add', 'new ending', null, 302), line('add', 'extra ending', null, 303), line('meta', '\\\\ No newline at end of file')] },
] };
const params = new URLSearchParams(location.search);
// ?large renders a 20,000-line diff through the virtualized path; ?unified switches layout.
const large = params.has('large') ? { ...diff, path: 'src/large.ts', hunks: [0, 1].map(h => ({ header: '@@ large ' + h + ' @@', lines: Array.from({ length: 10000 }, (_, i) => {
  const number = h * 100000 + i;
  if (i % 100 === 50) return line('remove', (i === 50 && h === 0 ? long : '  removed ' + i), number);
  if (i % 100 === 51) return line('add', '  added ' + i, null, number);
  return line('context', '  context ' + i, number, number);
}) })) } : diff;
const split = !params.has('unified');
window.diffWrites = [];
function Preview() {
  const { settings, updateSettings } = useSettings();
  return <div className="app-shell"><section className="diff-view-pane"><div className="diff-view-header"><span className="diff-view-filepath">src/diff/render.ts</span><div className="diff-view-actions"><button className="secondary-button" onClick={() => updateSettings({ diffWrap: !settings.diffWrap })}>{settings.diffWrap ? 'Unwrap lines' : 'Wrap lines'}</button><button className="secondary-button" onClick={() => updateSettings({ themeId: settings.themeId === 'gitty-dark' ? 'gitty-light' : 'gitty-dark' })}>Toggle theme</button></div></div><div className="diff-view-body"><DiffPreview diff={large} split={split} hunkAction="stage_hunk" onHunk={request => window.diffWrites.push(request)} /></div></section></div>;
}
createRoot(document.getElementById('root')).render(<SettingsProvider><Preview /></SettingsProvider>);
`;
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 5196, strictPort: false }, plugins: [{
  name: 'split-diff-fixture',
  resolveId(id) { if (id === '/split-fixture.tsx') return id; },
  load(id) { if (id === '/split-fixture.tsx') return fixture; },
  configureServer(server) { server.middlewares.use((req, res, next) => {
    if (req.url.split('?')[0] !== '/split-preview') return next();
    res.setHeader('Content-Type', 'text/html');
    void server.transformIndexHtml('/split-preview', '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="/split-fixture.tsx"></script></body></html>').then(html => res.end(html)).catch(next);
  }); },
}] });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1100, height: 780 }, reducedMotion: 'reduce' });
  const errors = []; page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  await page.goto(`${server.resolvedUrls.local[0]}split-preview`);
  await page.locator('.split-cell').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  const surface = page.locator('.native-diff.split');
  const scrollbar = page.getByRole('region', { name: 'Scroll both diff sides horizontally' });
  const columns = page.locator('.split-row').first().locator('.split-cell');
  const bounds = await columns.evaluateAll(cells => cells.map(cell => ({ width: cell.getBoundingClientRect().width, top: cell.getBoundingClientRect().top })));
  assert.ok(Math.abs(bounds[0].width - bounds[1].width) < 1);
  assert.equal(bounds[0].top, bounds[1].top);
  assert.ok(await scrollbar.evaluate(el => el.scrollWidth > el.clientWidth));
  assert.ok(await surface.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  assert.equal(await page.locator('.split-code').evaluateAll(codes => codes.some(code => getComputedStyle(code).overflowX === 'auto')), false);
  await page.getByRole('button', { name: 'Select line 102 for staging (before)', exact: true }).click();
  await page.getByRole('button', { name: 'Select line 102 for staging (after)', exact: true }).click();
  await page.getByRole('button', { name: 'Stage selected lines 1 in src/diff/render.ts', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.diffWrites[0].lineIndices), [1, 3]);
  await page.getByRole('button', { name: 'Wrap lines', exact: true }).click();
  assert.equal(await scrollbar.isVisible(), false);
  assert.ok(await surface.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  for (const theme of ['dark', 'light']) {
    if (theme === 'light') await page.getByRole('button', { name: 'Toggle theme' }).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    const replacement = page.locator('.split-row').nth(7);
    const cells = await replacement.locator('.split-cell').evaluateAll(nodes => nodes.map(node => ({ height: node.getBoundingClientRect().height, top: node.getBoundingClientRect().top })));
    assert.equal(cells[0].height, cells[1].height);
    assert.equal(cells[0].top, cells[1].top);
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/gitty-split-${theme}.png` });
  }
  await page.setViewportSize({ width: 600, height: 780 });
  assert.ok(await surface.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole('button', { name: 'Unwrap lines', exact: true }).click();
  await scrollbar.waitFor();
  assert.ok(await scrollbar.evaluate(el => el.scrollWidth > el.clientWidth));
  await scrollbar.evaluate(el => { el.scrollLeft = 200; });
  await page.waitForFunction(() => document.querySelector('.native-diff').style.getPropertyValue('--split-scroll-offset') === '200px');
  const transforms = await columns.locator('.split-code').evaluateAll(codes => codes.map(code => getComputedStyle(code).transform));
  assert.equal(transforms[0], transforms[1]);
  assert.ok(await columns.nth(1).evaluate(el => el.getBoundingClientRect().right <= innerWidth + 1));
  await surface.hover();
  await page.mouse.wheel(120, 0);
  await page.waitForFunction(() => document.querySelector('.split-horizontal-scroll').scrollLeft > 200);
  assert.deepEqual(errors, []);

  // Large diffs: bounded DOM, measured rows, anchored wrapping, keyboard reveal, and original indices.
  for (const layout of ['split', 'unified']) {
    const big = await browser.newPage({ viewport: { width: 1100, height: 780 }, reducedMotion: 'reduce' });
    big.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    const started = Date.now();
    await big.goto(`${server.resolvedUrls.local[0]}split-preview?large${layout === 'unified' ? '&unified' : ''}`);
    const view = big.locator('.native-diff');
    await view.locator('[data-row]').first().waitFor();
    const loadMs = Date.now() - started;
    assert.equal(await view.getAttribute('data-virtual'), 'true');
    const count = () => view.locator(':scope > div > [data-row]').count();
    assert.ok(await count() < 200, `rendered ${await count()} rows`);
    // Rows directly at the viewport top must exist after a long jump (no blank gap).
    const firstVisible = () => view.evaluate(el => { const top = el.getBoundingClientRect().top + (el.querySelector('.split-column-header')?.offsetHeight ?? 0) + 1; const row = [...el.querySelectorAll('[data-row]')].find(node => { const box = (node.classList.contains('split-row') ? node.firstElementChild : node).getBoundingClientRect(); return box.top <= top && box.bottom > top; }); return row ? Number(row.dataset.row) : -1; });
    await view.evaluate(el => { el.scrollTop = el.scrollHeight / 2; });
    await big.waitForTimeout(100);
    const middle = await firstVisible();
    assert.ok(middle > 5000, `first visible row ${middle}`);
    assert.ok(await count() < 200);
    if (layout === 'split') {
      // The long line was measured near the top; the shared scrollbar keeps its width after it leaves the window.
      assert.equal(await big.locator('.split-horizontal-scroll').evaluate(el => getComputedStyle(el).display), 'block');
    }
    // Wrapping changes row heights; the first visible row stays put and pairs stay aligned.
    await big.getByRole('button', { name: 'Wrap lines', exact: true }).click();
    await big.waitForTimeout(150);
    assert.ok(Math.abs(await firstVisible() - middle) <= 2, `anchor moved from ${middle} to ${await firstVisible()}`);
    if (layout === 'split') {
      const cells = await view.locator('.split-row').nth(5).locator('.split-cell').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
      assert.equal(cells[0], cells[1]);
    }
    await big.getByRole('button', { name: 'Unwrap lines', exact: true }).click();
    // Keyboard: End reveals the last row, Home returns; Space toggles the active changed line.
    await view.focus();
    await big.keyboard.press('End');
    await big.waitForTimeout(100);
    const last = await view.evaluate(el => Number(el.querySelector('.diff-active')?.closest('[data-row]')?.dataset.row ?? -1));
    assert.ok(last > 19000, `active ${last}`);
    assert.ok(await view.evaluate(el => { const active = el.querySelector('.diff-active').getBoundingClientRect(); const box = el.getBoundingClientRect(); return active.top >= box.top && active.bottom <= box.bottom + 1; }));
    assert.equal(await view.evaluate(el => !!document.getElementById(el.getAttribute('aria-activedescendant'))), true);
    await big.keyboard.press('Home');
    await big.waitForTimeout(50);
    for (let i = 0; i < 50; i++) await big.keyboard.press('ArrowDown');
    await big.keyboard.press('Space');
    await big.getByRole('button', { name: 'Stage selected lines 1 in src/large.ts', exact: true }).click();
    assert.deepEqual(await big.evaluate(() => window.diffWrites.at(-1).lineIndices), [50]);
    assert.ok(await big.evaluate(() => document.querySelectorAll('.line-select-toggle[tabindex="0"], .line-select-toggle:not([tabindex])').length === 0));
    console.log(`Large ${layout} diff: ${await count()} rows rendered, first paint ${loadMs}ms.`);
    await big.close();
  }
  assert.deepEqual(errors, []);
  console.log('Split diff browser smoke passed: equal columns, paired rows, original line indices, shared scrolling, wrapped alignment, both themes, narrow layouts, and virtualized large diffs.');
} finally { await browser?.close(); await server.close(); }
