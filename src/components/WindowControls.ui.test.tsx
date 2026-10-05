// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { WindowControls } from './WindowControls';

const window = vi.hoisted(() => ({
  isMaximized: vi.fn(async () => false),
  onResized: vi.fn(),
  minimize: vi.fn(async () => {}),
  toggleMaximize: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => window }));

it('routes window actions, tracks native maximize changes, reports failures and cleans up', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const stop = vi.fn();
  let resize = () => {};
  window.onResized.mockImplementation(async (callback: () => void) => { resize = callback; return stop; });
  const host = document.createElement('div');
  const root = createRoot(host);
  const onError = vi.fn();
  const button = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
  try {
    await act(async () => { root.render(<WindowControls onError={onError} />); });
    await act(async () => { button('Minimize window').click(); button('Maximize window').click(); });
    expect(window.minimize).toHaveBeenCalledOnce();
    expect(window.toggleMaximize).toHaveBeenCalledOnce();
    window.isMaximized.mockResolvedValue(true);
    await act(async () => { resize(); });
    expect(button('Restore window')).not.toBeNull();
    await act(async () => { button('Restore window').click(); button('Close window').click(); });
    expect(window.toggleMaximize).toHaveBeenCalledTimes(2);
    expect(window.close).toHaveBeenCalledOnce();
    window.minimize.mockRejectedValueOnce(new Error('Denied'));
    await act(async () => { button('Minimize window').click(); });
    expect(onError).toHaveBeenCalledWith('Could not update window: Denied');
  } finally {
    await act(async () => { root.unmount(); });
  }
  expect(stop).toHaveBeenCalledOnce();
});
