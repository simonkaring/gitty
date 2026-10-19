// Optional browser smoke: responsive pane layout.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node src/components/responsive-layout.smoke.mjs
//
// Covers: sidebar and inspector stay in normal flow at intermediate widths and
// stack as bounded, independently scrollable panes at narrow widths; history keeps
// a fixed usable box that stays visibly usable inside the single outer workspace
// scroller (no nested scroller); graph/ref labels stay reachable; zoom; opening,
// reopening and resizing panes; short-height windows; a clickable stacked commit
// composer; and no page horizontal overflow.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = await createServer({ server: { host: '127.0.0.1', port: 5192, strictPort: false }, logLevel: 'error' });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('gitty:theme', 'light'));
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByRole('listbox', { name: 'Commit history' }).waitFor();

  const toggleSidebar = () => page.getByRole('button', { name: 'Toggle references sidebar' }).click();
  const toggleInspector = () => page.getByRole('button', { name: 'Toggle working changes and inspector' }).click();
  const at = async (width, height = 900) => {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(60);
    await resetScroll();
  };
  // Measure every width from a fresh scroll position so "visible" is deterministic.
  async function resetScroll() {
    await page.evaluate(() => { const el = document.querySelector('.workspace'); if (el) el.scrollTop = 0; });
    await page.waitForTimeout(30);
  }
  const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y));
  const layout = () => page.evaluate(() => {
    const rect = selector => { const el = document.querySelector(selector); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
    // Height of `pane` actually visible inside the workspace scroller (not its unclipped box).
    const visible = (pane, workspace) => pane && workspace ? Math.max(0, Math.min(pane.bottom, workspace.bottom) - Math.max(pane.y, workspace.y)) : 0;
    const workspaceEl = document.querySelector('.workspace');
    const workspace = workspaceEl ? { ...rect('.workspace'), clientHeight: workspaceEl.clientHeight, scrollHeight: workspaceEl.scrollHeight, scrollTop: workspaceEl.scrollTop, overflowY: getComputedStyle(workspaceEl).overflowY } : null;
    const nestedScroller = document.querySelector('.history-workspace');
    const history = rect('.history-pane') ?? rect('.diff-view-pane');
    const inspector = rect('.native-inspector') ?? rect('.working-inspector-sidebar');
    return {
      sidebar: rect('.sidebar'),
      history,
      inspector,
      workspace,
      graph: rect('.commit-graph-cell'),
      ref: rect('.ref-pill'),
      rows: document.querySelectorAll('.history-scroll .commit-row').length,
      resizerVisible: !!document.querySelector('.pane-resizer')?.getClientRects().length,
      historyScrollClient: document.querySelector('.history-scroll')?.clientHeight ?? 0,
      historyWorkspaceOverflowY: nestedScroller ? getComputedStyle(nestedScroller).overflowY : null,
      visibleHistory: visible(history, workspace),
      visibleInspector: visible(inspector, workspace),
      overflowX: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
      innerWidth,
      innerHeight,
    };
  });
  /** Shared contract for every width and panel combination. */
  async function check(label, expected) {
    await resetScroll();
    const state = await layout();
    assert.ok(state.overflowX <= 1, `${label}: page must not scroll horizontally (overflow ${state.overflowX})`);
    assert.ok(state.history && state.history.w >= 200 && state.history.h >= 150, `${label}: history must keep a usable box (${JSON.stringify(state.history)})`);
    assert.ok(state.visibleHistory >= 120, `${label}: history must be visibly usable inside the workspace scroller (${state.visibleHistory}px visible)`);
    assert.ok(state.historyWorkspaceOverflowY !== 'auto' && state.historyWorkspaceOverflowY !== 'scroll', `${label}: history must not become a nested scroller (overflow-y: ${state.historyWorkspaceOverflowY})`);
    assert.ok(state.rows > 0, `${label}: history rows must render`);
    assert.ok(state.graph && state.graph.w > 0 && state.graph.x >= state.history.x - 1 && state.graph.right <= state.history.right + 1, `${label}: graph column must be reachable inside history`);
    assert.ok(state.ref && state.ref.w > 0 && state.ref.x >= state.history.x - 1 && state.ref.x < state.history.right, `${label}: ref labels must be reachable inside history`);
    assert.equal(!!state.sidebar, expected.sidebar, `${label}: sidebar presence`);
    assert.equal(!!state.inspector, expected.inspector, `${label}: inspector presence`);
    const panels = [state.sidebar, state.history, state.inspector].filter(Boolean);
    for (let i = 0; i < panels.length; i++) for (let j = i + 1; j < panels.length; j++) assert.equal(overlap(panels[i], panels[j]), 0, `${label}: panes must not overlap`);
    if (state.sidebar && state.history) assert.ok(state.sidebar.bottom <= state.history.y + 1 || state.sidebar.right <= state.history.x + 1, `${label}: sidebar must not cover history`);
    if (state.inspector && state.history) assert.ok(state.history.bottom <= state.inspector.y + 1 || state.history.right <= state.inspector.x + 1, `${label}: inspector must not cover history`);
    return state;
  }
  /** Bottom of the workspace scroller: the only way a stacked inspector can be reached at short heights. */
  async function reachInspector(selector) {
    await page.locator('.workspace').evaluate(el => { el.scrollTop = el.scrollHeight; });
    return page.evaluate(sel => {
      const w = document.querySelector('.workspace').getBoundingClientRect();
      const i = document.querySelector(sel).getBoundingClientRect();
      return Math.max(0, Math.min(w.bottom, i.bottom) - Math.max(w.top, i.top));
    }, selector);
  }

  // Extreme saved pane widths: never let a saved width squeeze history to nothing.
  for (const name of ['Resize repository sidebar', 'Resize inspector']) {
    const separator = page.getByRole('separator', { name });
    await separator.focus(); await separator.press('End');
  }
  assert.equal(await page.getByRole('separator', { name: 'Resize repository sidebar' }).getAttribute('aria-valuenow'), '340');
  assert.equal(await page.getByRole('separator', { name: 'Resize inspector' }).getAttribute('aria-valuenow'), '760');

  // Both panes open, commit inspector, across the 1100/800 boundaries and below.
  for (const width of [1100, 1000, 900, 821, 820, 800, 600, 390]) {
    await at(width);
    const state = await check(`both @${width}`, { sidebar: true, inspector: true });
    assert.equal(state.sidebar.w >= 200, true, `both @${width}: sidebar remains a usable column`);
    if (width <= 820) assert.ok(state.sidebar.bottom <= state.history.y + 1, `both @${width}: stacked panes follow DOM order`);
    else assert.ok(state.sidebar.right <= state.history.x + 1, `both @${width}: side-by-side panes keep their own columns`);
    assert.equal(state.resizerVisible, width > 820, `both @${width}: pane resizers only in side-by-side layout`);
  }

  // Keyboard access to the history survives the stacked layout.
  await at(390);
  await page.locator('.history-scroll').focus();
  const selectedBefore = await page.locator('.commit-row[aria-selected="true"]').first().getAttribute('id');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(50);
  const selectedAfter = await page.locator('.commit-row[aria-selected="true"]').first().getAttribute('id');
  assert.notEqual(selectedAfter, selectedBefore, 'stacked layout keeps keyboard history navigation working');

  // Each pane alone around 1100 and 800, plus narrow.
  for (const width of [1100, 800, 390]) {
    await at(width);
    await toggleSidebar();
    await check(`inspector only @${width}`, { sidebar: false, inspector: true });
    await toggleInspector();
    await toggleSidebar();
    await check(`sidebar only @${width}`, { sidebar: true, inspector: false });
    await toggleInspector();
    await check(`both reopened @${width}`, { sidebar: true, inspector: true });
  }

  // Working-changes inspector and its draft survive stacking, hiding and reopening.
  await at(900);
  await page.getByRole('option', { name: /^Working changes/ }).click();
  const summary = page.getByRole('textbox', { name: /Summary/ });
  await summary.waitFor();
  await check('working inspector @900', { sidebar: true, inspector: true });

  // Stacked working inspector, full and short: bounded definite height, a Summary field that a real
  // click can reach, a composer body that scrolls itself, and an inspector reachable by scrolling the
  // outer workspace instead of a nested history scroller.
  for (const height of [844, 600, 500]) {
    await at(390, height);
    const stacked = await check(`working inspector @390x${height}`, { sidebar: true, inspector: true });
    assert.ok(stacked.inspector.h >= 260 && stacked.inspector.h <= 460, `working inspector @390x${height}: stacked inspector keeps a bounded usable height (${stacked.inspector.h})`);
    assert.ok(stacked.historyScrollClient >= 120, `working inspector @390x${height}: history keeps its own usable scroll area (${stacked.historyScrollClient})`);
    assert.ok(stacked.workspace.scrollHeight > stacked.workspace.clientHeight, `working inspector @390x${height}: the outer workspace is the scroller (${stacked.workspace.scrollHeight} > ${stacked.workspace.clientHeight})`);
    const composer = await page.locator('.commit-composer').evaluate(el => ({ clientHeight: el.clientHeight, minHeight: getComputedStyle(el).minHeight }));
    assert.ok(composer.clientHeight >= 140, `working inspector @390x${height}: composer keeps its Summary field (${composer.clientHeight}px, min-height ${composer.minHeight})`);
    await summary.click();
    await summary.fill('responsive layout draft');
    const body = await page.locator('.composer-body').evaluate(el => { const clientHeight = el.clientHeight; const scrollHeight = el.scrollHeight; el.scrollTop = 10000; return { clientHeight, scrollHeight, scrolled: el.scrollTop }; });
    assert.ok(body.clientHeight >= 80, `working inspector @390x${height}: composer body stays scrollable, not collapsed (${body.clientHeight}px)`);
    assert.ok(body.scrollHeight <= body.clientHeight || body.scrolled > 0, `working inspector @390x${height}: overflowing composer body scrolls (${body.scrollHeight} > ${body.clientHeight}, scrollTop ${body.scrolled})`);
    assert.ok(await reachInspector('.working-inspector-sidebar') >= 120, `working inspector @390x${height}: stacked inspector is reachable through the outer workspace`);
  }

  await at(390);
  await check('working inspector @390', { sidebar: true, inspector: true });
  await toggleInspector();
  await check('inspector hidden @390', { sidebar: true, inspector: false });
  await toggleInspector();
  await summary.waitFor();
  assert.equal(await summary.inputValue(), 'responsive layout draft', 'commit draft survives the inspector being hidden and reopened');
  await check('inspector reopened @390', { sidebar: true, inspector: true });

  // Back to a commit inspector: selection survives reopening, and short windows stay usable.
  await at(900);
  await page.getByRole('option', { name: /^Make commit details easier to read/ }).click();
  await page.locator('.native-inspector .native-sha').first().waitFor();
  const selectedSha = await page.locator('.native-inspector .native-sha').first().textContent();
  await toggleInspector();
  await toggleInspector();
  assert.equal(await page.locator('.native-inspector .native-sha').first().textContent(), selectedSha, 'commit selection survives the inspector being hidden and reopened');
  await check('commit inspector @900', { sidebar: true, inspector: true });

  // Short, narrow windows: history keeps a fixed usable box and the outer workspace scrolls to the
  // inspector, instead of history-workspace becoming an inner scroller that clips it to a few pixels.
  for (const height of [600, 500]) {
    await at(390, height);
    const short = await check(`commit inspector @390x${height}`, { sidebar: true, inspector: true });
    assert.ok(short.history.h >= 239, `commit inspector @390x${height}: history keeps its full usable height (${short.history.h})`);
    assert.ok(short.visibleHistory >= 120, `commit inspector @390x${height}: history stays visibly usable (${short.visibleHistory}px visible)`);
    assert.ok(short.historyScrollClient >= 120, `commit inspector @390x${height}: history scroll area stays usable (${short.historyScrollClient})`);
    assert.ok(short.workspace.scrollHeight > short.workspace.clientHeight, `commit inspector @390x${height}: the outer workspace scrolls (${short.workspace.scrollHeight} > ${short.workspace.clientHeight})`);
    assert.ok(await reachInspector('.native-inspector') >= 120, `commit inspector @390x${height}: inspector is reachable through the outer workspace`);
  }

  // Zoom shrinks the effective layout width: stacking must follow the zoomed-out width, not the physical window.
  await at(1000);
  await page.getByRole('combobox', { name: 'Interface zoom' }).selectOption('200');
  const zoomed = await check('both @1000 zoom 200%', { sidebar: true, inspector: true });
  assert.equal(zoomed.innerWidth, 1000);
  assert.ok(zoomed.sidebar.bottom <= zoomed.history.y + 1, 'zoom 200% stacks panes using the effective width');

  // Stacked working inspector under zoom: the CSS-space floors keep the CSS-sized composer controls usable, so
  // the Summary field stays clickable instead of being covered by the composer footer.
  await page.getByRole('option', { name: /^Working changes/ }).click();
  await summary.waitFor();
  await check('working inspector @1000 zoom 200%', { sidebar: true, inspector: true });
  const zoomComposer = await page.locator('.commit-composer').evaluate(el => el.clientHeight);
  assert.ok(zoomComposer >= 120, `working inspector @1000 zoom 200%: composer keeps its Summary field (${zoomComposer}px CSS)`);
  const zoomBody = await page.locator('.composer-body').evaluate(el => { const clientHeight = el.clientHeight; const scrollHeight = el.scrollHeight; el.scrollTop = 10000; return { clientHeight, scrollHeight, scrolled: el.scrollTop }; });
  assert.ok(zoomBody.clientHeight >= 80, `working inspector @1000 zoom 200%: composer body stays usable (${zoomBody.clientHeight}px CSS)`);
  assert.ok(zoomBody.scrollHeight <= zoomBody.clientHeight || zoomBody.scrolled > 0, `working inspector @1000 zoom 200%: overflowing composer body scrolls (${zoomBody.scrollHeight} > ${zoomBody.clientHeight}, scrollTop ${zoomBody.scrolled})`);
  await summary.click();
  await summary.fill('zoomed draft');

  await page.getByRole('combobox', { name: 'Interface zoom' }).selectOption('100');
  await at(1500);
  const wide = await check('both @1500 zoom 100%', { sidebar: true, inspector: true });
  assert.ok(Math.abs(wide.sidebar.w - 340) < 2, 'saved sidebar width is restored when the window is wide again');
  assert.ok(Math.abs(wide.inspector.w - 760) < 2, 'saved inspector width is restored when the window is wide again');

  assert.deepEqual(errors, []);
  console.log('Responsive pane smoke passed: normal-flow panes at 1100/1000/900/821, stacked bounded panes at 820/800/600/390 and short heights 600/500, both panes individually and together, commit and working inspectors, visible history intersections with the outer workspace scroller (no nested scroller), clickable Summary and scrollable composer at 100% and 200% zoom, draft and selection survival, pane resizers, zoom-adjusted stacking, and no horizontal overflow.');
} finally {
  await browser?.close();
  await server.close();
}
