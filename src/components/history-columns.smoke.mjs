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
} finally {
  await browser?.close();
  await server.close();
}
