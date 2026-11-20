// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_KEY, SettingsProvider, useSettings } from './settings';

it('applies the theme style hook and theme code font, restoring both for plain themes', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })));
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, themeId: 'gitty-editorial-dark', monoFont: 'JetBrains Mono' }));
  let api: ReturnType<typeof useSettings> | null = null;
  function Probe() { api = useSettings(); return null; }
  const root = createRoot(document.createElement('div'));
  const html = document.documentElement;
  try {
    await act(async () => root.render(<SettingsProvider><Probe /></SettingsProvider>));
    expect(html.dataset.themeStyle).toBe('editorial');
    expect(html.style.getPropertyValue('--mono')).toBe("'IBM Plex Mono', monospace");
    await act(async () => api!.updateSettings({ themeId: 'gitty-dark' }));
    expect(html.dataset.themeStyle).toBeUndefined();
    expect(html.style.getPropertyValue('--mono')).toBe("'JetBrains Mono', monospace");
  } finally { await act(async () => root.unmount()); localStorage.clear(); vi.unstubAllGlobals(); }
});
