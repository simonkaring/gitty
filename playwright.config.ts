import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  outputDir: 'test-results',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    headless: true,
    // Session bootstrap and authenticated bridge calls contain the per-run token.
    // Keep screenshots and fixture diagnostics; traces would persist request headers.
    trace: 'off',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
  },
  webServer: {
    command: 'node scripts/e2e/harness.mjs',
    url: 'http://127.0.0.1:4173',
    timeout: 180_000,
    reuseExistingServer: false,
  },
});
