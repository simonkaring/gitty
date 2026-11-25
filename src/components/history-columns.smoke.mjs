// Optional browser QA: PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node src/components/history-columns.smoke.mjs
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = await createServer({ server: { host: '127.0.0.1', port: 5189, strictPort: false }, logLevel: 'error' });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByRole('listbox', { name: 'Commit history' }).waitFor();
  const messageHandle = page.getByRole('button', { name: 'Resize Commit message column', exact: true });
  const messageWidth = () => messageHandle.evaluate(el => el.parentElement.getBoundingClientRect().width);
  const initialWidth = await messageWidth();
  const grip = await messageHandle.boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 - 50, grip.y + grip.height / 2);
  await page.mouse.up();
  assert.ok(Math.abs(await messageWidth() - (initialWidth - 50)) < 2, 'drag shrinks the actual filled message width');
  await messageHandle.focus();
  await messageHandle.press('ArrowRight');
  assert.ok(Math.abs(await messageWidth() - (initialWidth - 40)) < 2, 'keyboard grows the actual message width');
  assert.ok(Math.abs(await page.locator('.commit-message').first().evaluate(el => el.getBoundingClientRect().width) - await messageWidth()) < 2, 'header and row widths match');
  await page.getByRole('button', { name: 'Customize columns' }).click();
  const menu = page.getByRole('dialog', { name: 'History columns settings' });
  await menu.getByRole('checkbox', { name: 'Date' }).check();
  assert.equal(await page.locator('.history-columns .date-column').count(), 1);
  assert.equal(await page.locator('.commit-row .row-date').nth(1).isVisible(), true); // row 0 is the undated working-changes row
  await menu.getByRole('checkbox', { name: 'Branch / tag' }).uncheck();
  assert.equal(await page.locator('.history-columns').getByText('Branch / tag').count(), 0);
  assert.equal(await page.locator('.commit-row .commit-refs').count(), 0);

  await menu.getByRole('button', { name: 'Move Commit message up' }).click();
  await menu.getByRole('button', { name: 'Move Commit message up' }).click();
  await page.waitForFunction(() => {
    const graph = document.querySelector('.commit-row .commit-graph-cell');
    const canvas = document.querySelector('.graph-canvas');
    return graph && canvas && Math.abs(graph.getBoundingClientRect().left - canvas.getBoundingClientRect().left) < 2;
  });
  assert.equal((await page.locator('.history-columns > span').allTextContents())[0], 'Commit message');

  await page.setViewportSize({ width: 700, height: 800 });
  await menu.getByRole('checkbox', { name: 'Author' }).check();
  assert.equal(await page.locator('.commit-row .row-author').first().evaluate(el => getComputedStyle(el).display !== 'none'), true);
  await menu.getByRole('checkbox', { name: 'Commit', exact: true }).check();
  assert.equal(await page.locator('.commit-row .row-hash').first().evaluate(el => getComputedStyle(el).display !== 'none'), true);

  await menu.getByRole('button', { name: 'Reset to default' }).click();
  assert.equal(await menu.getByRole('checkbox', { name: 'Date' }).isChecked(), false);
  await page.reload();
  await page.getByRole('listbox', { name: 'Commit history' }).waitFor();
  assert.equal(await page.locator('.history-columns .date-column').count(), 0);
  console.log('PASS message column pointer/keyboard resizing, row alignment, column visibility, order, graph alignment, narrow layout, reset and persistence');

  await page.setViewportSize({ width: 1500, height: 900 });
  const history = page.getByRole('listbox', { name: 'Commit history' });
  const theme = page.getByRole('combobox', { name: 'Theme', exact: true });
  const openAppearance = async () => {
    await page.getByRole('button', { name: 'Open settings' }).click();
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  };
  // Sample a row boundary, where only connecting lines (not nodes or ref connectors) can paint pixels.
  const hasGraphLine = () => page.locator('.graph-canvas').evaluate(canvas => {
    const y = Math.floor(document.querySelector('.commit-row').offsetHeight * devicePixelRatio * 2);
    if (canvas.height <= y) return false;
    const pixels = canvas.getContext('2d').getImageData(0, y, canvas.width, 1).data;
    return pixels.some((value, i) => i % 4 === 3 && value > 0);
  });
  await openAppearance();
  await page.getByRole('combobox', { name: 'Theme behavior' }).selectOption('fixed');
  const presets = await theme.locator('option').evaluateAll(options => options.map(option => option.value));
  for (const id of presets) {
    await theme.selectOption(id);
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.getByRole('button', { name: 'Customize columns' }).click();
    const graph = menu.getByRole('checkbox', { name: 'Graph', exact: true });
    // Hide refs so changing the ref-to-graph connector cannot incidentally repaint the canvas.
    await menu.getByRole('checkbox', { name: 'Branch / tag' }).uncheck();
    assert.ok(await hasGraphLine(), `${id}: graph lines before hiding Graph`);
    const selected = await history.getAttribute('aria-activedescendant');
    await graph.uncheck();
    assert.equal(await page.locator('.graph-canvas').count(), 0);
    await graph.check();
    assert.ok(await hasGraphLine(), `${id}: graph lines after showing Graph without changing selection`);
    assert.equal(await history.getAttribute('aria-activedescendant'), selected);
    await page.keyboard.press('Escape');
    await openAppearance();
  }
  console.log(`PASS graph lines repaint without a row click in all ${presets.length} built-in themes`);
} finally {
  await browser?.close();
  await server.close();
}
