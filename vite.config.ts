import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { gittyTestBridge } from './scripts/e2e/viteBridge.mjs';

export default defineConfig({
  plugins: [react(), ...(process.env.GITTY_E2E === '1' ? [gittyTestBridge()] : [])],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**', '**/target/**', '**/crates/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'vendor-react';
        },
      },
    },
  },
  test: { include: ['src/**/*.test.{ts,tsx}'] },
});
