// Browser QA with mocked Tauri IPC; does not exercise real OAuth or credential storage.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node src/components/integrations.smoke.mjs
// Optional SCREENSHOT_DIR=/existing/directory saves light, dark and narrow views.
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = await createServer({ server: { host: '127.0.0.1', port: 5192, strictPort: false }, logLevel: 'error' });
let browser;
const errors = [];
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.isTauri = true;
    let callback = 0;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
      transformCallback: () => ++callback, unregisterCallback: () => {},
      invoke: async command => {
        if (command === 'list_provider_accounts') return [{ id: 'qa', provider: 'github', username: 'octocat', oauth: true }];
        if (command === 'provider_oauth_start') return { id: 'device', userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device', interval: 60, expiresIn: 900 };
        if (command === 'repository_recent' || command === 'wsl_distributions') return [];
        if (command === 'plugin:event|listen') return 1;
        if (command.startsWith('plugin:') || command === 'open_external_url' || command === 'provider_oauth_cancel') return;
        throw new Error(`Unexpected mocked IPC: ${command}`);
      },
    };
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.getByRole('button', { name: 'Integrations', exact: true }).click();
  const section = page.locator('.integrations-settings');
  await section.getByText('octocat', { exact: true }).waitFor();
  assert.equal(await section.getByRole('button', { pressed: true }).count(), 1);
  const noOverflow = async () => assert.equal(await section.evaluate(element => element.scrollWidth <= element.clientWidth), true, 'integration content must not overflow');
  for (const theme of ['gitty-light', 'gitty-dark']) {
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await page.getByRole('combobox', { name: 'Theme behavior', exact: true }).selectOption('fixed');
    await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(theme);
    await page.getByRole('button', { name: 'Integrations', exact: true }).click();
    await noOverflow();
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/integrations-${theme}.png` });
  }
  await section.getByRole('button', { name: 'Bitbucket Cloud bitbucket.org', exact: true }).click();
  assert.equal(await section.locator('.integration-token').evaluate(element => element.open), true);
  assert.equal(await section.getByRole('button', { name: /in browser/ }).count(), 0);
  await section.getByRole('button', { name: 'GitHub github.com', exact: true }).click();
  await section.getByRole('button', { name: 'Connect GitHub in browser', exact: true }).click();
  await section.getByText('ABCD-EFGH', { exact: true }).waitFor();
  assert.equal(await section.locator('.integration-provider:disabled').count(), 4);
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/integrations-device.png` });
  await section.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
  await page.setViewportSize({ width: 600, height: 850 });
  await noOverflow();
  assert.equal(await section.locator('.integration-provider-grid').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length), 1);
  await section.getByRole('button', { name: 'Bitbucket Cloud bitbucket.org', exact: true }).click();
  await section.getByLabel('Account username', { exact: true }).fill('qa-user');
  await section.getByLabel('Access token', { exact: true }).fill('qa-token');
  await noOverflow();
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/integrations-narrow.png` });
  assert.deepEqual(errors, []);
  console.log('Integrations smoke passed: light/dark, narrow layout, provider setup, and device cancellation; mocked IPC only.');
} finally {
  await browser?.close();
  await server.close();
}
