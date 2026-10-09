// Browser QA on synthetic demo history; does not exercise native repository access.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node src/components/graph-avatars.smoke.mjs
// Optional SCREENSHOT_DIR=/existing/directory writes a graph-avatar screenshot.
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = await createServer({ server: { host: '127.0.0.1', port: 5189, strictPort: false }, logLevel: 'error' });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  await page.route('https://gravatar.com/avatar/**', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#569abb"/><circle cx="32" cy="24" r="12" fill="#fff"/><path d="M12 64v-8a20 20 0 0140 0v8" fill="#fff"/></svg>' }));
  await page.goto(server.resolvedUrls.local[0]);
  const history = page.getByRole('listbox', { name: 'Commit history' });
  await history.waitFor();
  assert.equal(await page.locator('.graph-avatar-node').count(), 0);
  const open = async () => {
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  };
  const close = () => page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await open();
  await page.getByRole('combobox', { name: 'Author avatars', exact: true }).selectOption('initials');
  await page.getByRole('checkbox', { name: 'Show author avatars as graph nodes' }).check();
  await close();
  const nodes = page.locator('.graph-avatar-node');
  await nodes.first().waitFor();
  assert.equal(await nodes.locator('img').count(), 0);
  assert.equal(await page.locator('[id="commit-gitty:working-tree"] .graph-avatar-node').count(), 0);
  const checkAlignment = () => page.waitForFunction(() => [...document.querySelectorAll('.graph-avatar-node')].every(node => {
    const rect = node.getBoundingClientRect(), cell = node.closest('.commit-graph-cell').getBoundingClientRect();
    const avatar = node.querySelector('.avatar').getBoundingClientRect();
    return avatar.width === 22 && avatar.height === 22 && rect.width <= 28 && Math.abs(rect.top + rect.height / 2 - cell.top - cell.height / 2) < 1;
  }));
  await checkAlignment();
  await history.evaluate(el => { el.scrollTop = 500; });
  await checkAlignment();
  await page.reload();
  await nodes.first().waitFor();
  await open();
  assert.equal(await page.getByRole('checkbox', { name: 'Show author avatars as graph nodes' }).isChecked(), true);
  await page.getByRole('combobox', { name: 'Author avatars', exact: true }).selectOption('gravatar');
  await close();
  await page.waitForFunction(() => [...document.querySelectorAll('.graph-avatar-node img')].some(img => img.complete && img.naturalWidth > 0 && getComputedStyle(img).opacity === '1'));
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/graph-avatars.png` });
  await page.setViewportSize({ width: 700, height: 800 });
  await history.evaluate(el => { el.scrollLeft = 100; el.scrollTop = 500; });
  await checkAlignment();
  await open();
  await page.getByRole('checkbox', { name: 'Show author avatars as graph nodes' }).uncheck();
  await close();
  assert.equal(await nodes.count(), 0);
  console.log('PASS graph avatar settings, persistence, initials, mocked Gravatar loading, compact alignment, scrolling, narrow layout and dot mode');
} finally {
  await browser?.close();
  await server.close();
}
