// Real variable-height file list with synthetic status/diffs and simulated writes.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
const engines = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
// The desktop app renders in the platform webview, so the fixture must hold in WebKit as well as
// Chromium: SMOKE_BROWSER=webkit node src/components/working-files.smoke.mjs
const engine = process.env.SMOKE_BROWSER === 'webkit' ? 'webkit' : 'chromium';
const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkingChanges } from '/src/components/WorkingChanges.tsx';
import { SettingsProvider } from '/src/model/settings.tsx';
import '/src/styles.css';
const entries = Array.from({ length: 10000 }, (_, i) => ({ path: 'file-' + String(i).padStart(5, '0') + (i % 7 === 0 ? '/a-very-long-directory-name/'.repeat(4) + 'wrapped-file.ts' : '.ts'), oldPath: i % 17 === 0 ? 'old/path.ts' : null, indexStatus: i % 5 === 0 ? 'M' : '.', worktreeStatus: 'M', untracked: i % 3 === 1, conflicted: false }));
const session = { handle: 'repo', location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'head', headRef: 'refs/heads/main' };
const status = { entries, head: 'head', headRef: session.headRef, fingerprint: 'fixture' };
window.writes = []; window.reads = [];
const loadDiff = async (handle, spec, path) => { window.reads.push({ spec, path }); return { path, hunks: [], binary: false, truncated: false, message: 'Fixture preview' }; };
const onMutation = async request => { window.writes.push(request); return {}; };
function Fixture() {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(null);
  const [snapshot, setSnapshot] = useState(status);
  const [revision, setRevision] = useState(0);
  return <div style={{ display: 'flex', height: '100vh' }}>
    <main style={{ flex: 1 }}><button onClick={() => setOpen(true)}>Working changes</button><p id="preview">{active?.diff?.path || ''}</p></main>
    {open && <aside style={{ width: 'min(380px, 70vw)', height: '100vh' }} className="working-inspector-sidebar"><WorkingChanges session={session} status={snapshot} revision={revision} busy={false} onMutation={onMutation} onRefresh={async () => { setSnapshot({ ...status, entries: entries.map(entry => ({ ...entry })) }); setRevision(value => value + 1); }} loadDiff={loadDiff} onActiveDiffChange={setActive} /></aside>}
  </div>;
}
createRoot(document.getElementById('root')).render(<SettingsProvider><Fixture /></SettingsProvider>);
`;
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 5197, strictPort: false }, plugins: [{
  name: 'working-files-fixture',
  resolveId(id) { if (id === '/working-files-fixture.tsx') return id; },
  load(id) { if (id === '/working-files-fixture.tsx') return fixture; },
  configureServer(server) { server.middlewares.use((req, res, next) => {
    if (req.url !== '/working-files-preview') return next();
    res.setHeader('Content-Type', 'text/html');
    void server.transformIndexHtml('/working-files-preview', '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="/working-files-fixture.tsx"></script></body></html>').then(html => res.end(html)).catch(next);
  }); },
}] });
let browser;
try {
  await server.listen();
  browser = await engines[engine].launch({ headless: true, ...(engine === 'chromium' && process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, reducedMotion: 'reduce' });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${server.resolvedUrls.local[0]}working-files-preview`);
  await page.getByRole('button', { name: 'Working changes', exact: true }).waitFor();
  const started = Date.now();
  await page.getByRole('button', { name: 'Working changes', exact: true }).click();
  await page.locator('.working-file-select').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  console.log(`10,000-file inspector ready in ${Date.now() - started} ms; ${await page.locator('.working-file').count()} mounted rows`);
  assert.ok(await page.locator('.working-file').count() < 150);
  const surface = page.locator('.working-files-list');
  const unstaged = page.locator('.unstaged .working-file-window');
  // Measured wrapped rows fit the sidebar, and the spacers preserve a genuinely deep scroll range.
  assert.ok(await unstaged.evaluate(el => el.getBoundingClientRect().height > 200000));
  await surface.evaluate(el => { el.scrollTop = 180000; });
  await page.waitForFunction(() => Number(document.querySelector('.unstaged [data-working-index]')?.dataset.workingIndex) > 1000);
  const deep = page.locator('.unstaged .working-file-select').nth(15);
  const label = await deep.getAttribute('aria-label');
  const path = label.substring(label.indexOf(': ') + 2);
  const selectedAt = Date.now();
  await deep.click();
  await page.waitForFunction(path => document.querySelector('#preview').textContent === path, path);
  console.log(`Deep-file synthetic preview in ${Date.now() - selectedAt} ms`);
  await page.getByRole('button', { name: `Stage ${path}`, exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.writes[0].paths), [path]);
  assert.ok(await page.locator('.working-file').count() < 150);
  await deep.focus();
  await page.keyboard.press('End');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Unstaged: file-09999.ts');
  await page.keyboard.press('ArrowUp');
  assert.match(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), /file-09998/);
  // Focus is pinned independently of the scroll window.
  await surface.evaluate(el => { el.scrollTop = 0; });
  await page.waitForFunction(() => document.querySelector('.unstaged [data-working-index="0"]'));
  assert.match(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), /file-09998/);
  assert.ok(await page.locator('.working-file').count() < 150);
  await page.keyboard.press('Home');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label')?.startsWith('Unstaged: file-00000/'));
  await page.getByRole('button', { name: 'Unstaged, 10000 files', exact: true }).click();
  assert.equal(await page.locator('.unstaged .working-file').count(), 0);
  await page.locator('.staged .working-file-select').first().waitFor({ state: 'visible' });
  assert.equal(await page.locator('#preview').textContent(), path);
  await page.getByRole('button', { name: 'Unstaged, 10000 files', exact: true }).click();
  // Resize while scrolled: wrapped rows are remeasured without unbounded rendering or horizontal overflow.
  await surface.evaluate(el => { el.scrollTop = 50000; });
  await page.waitForFunction(() => Number(document.querySelector('.unstaged [data-working-index]')?.dataset.workingIndex) > 100);
  const anchor = await surface.evaluate(el => {
    const top = el.getBoundingClientRect().top;
    const row = [...el.querySelectorAll('.unstaged [data-working-index]')].find(row => row.getBoundingClientRect().bottom > top);
    return { index: row.dataset.workingIndex, top: row.getBoundingClientRect().top - top };
  });
  await page.setViewportSize({ width: 420, height: 650 });
  await page.waitForTimeout(100);
  const anchoredTop = await page.locator(`.unstaged [data-working-index="${anchor.index}"]`).evaluate(el => el.getBoundingClientRect().top - el.closest('.working-files-list').getBoundingClientRect().top);
  assert.ok(Math.abs(anchoredTop - anchor.top) < 2, `resize moved the visible anchor by ${anchoredTop - anchor.top}px`);
  await page.getByRole('button', { name: 'Refresh changes', exact: true }).click();
  const refreshedTop = await page.locator(`.unstaged [data-working-index="${anchor.index}"]`).evaluate(el => el.getBoundingClientRect().top - el.closest('.working-files-list').getBoundingClientRect().top);
  assert.ok(Math.abs(refreshedTop - anchoredTop) < 2, 'unchanged status refresh moved the viewport');
  assert.ok(await page.locator('.working-file').count() < 150);
  assert.ok(await surface.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await page.getByRole('button', { name: 'Stage all (10000)', exact: true }).click();
  assert.equal(await page.evaluate(() => window.writes.at(-1).paths.length), 10000);
  assert.deepEqual(errors, []);
  console.log(`Working-file virtualization smoke passed (synthetic IPC, ${engine}).`);
} finally { await browser?.close(); await server.close(); }
