// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { DEFAULT_BUTTON_LAYOUT, parseWindowButtonLayout, WindowControls, WindowResizeHandles } from './WindowControls';

const window = vi.hoisted(() => ({
  isMaximized: vi.fn(async () => false),
  onResized: vi.fn(),
  minimize: vi.fn(async () => {}),
  toggleMaximize: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  startResizeDragging: vi.fn(async (_direction: string) => {}),
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => window }));

it('follows GTK placement, order and omitted buttons while filtering unsupported or duplicate entries', () => {
  expect(parseWindowButtonLayout('close,minimize,maximize:appmenu')).toEqual([['close', 'minimize', 'maximize'], []]);
  expect(parseWindowButtonLayout('menu:minimize,maximize,close')).toEqual([[], ['minimize', 'maximize', 'close']]);
  expect(parseWindowButtonLayout('close:maximize,close,unknown')).toEqual([['close'], ['maximize']]);
  expect(parseWindowButtonLayout(':close')).toEqual([[], ['close']]);
  expect(parseWindowButtonLayout(':')).toEqual([[], []]);
  expect(parseWindowButtonLayout('invalid')).toEqual(parseWindowButtonLayout(DEFAULT_BUTTON_LAYOUT));
});

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
    await act(async () => { root.render(<WindowControls buttons={['close', 'minimize']} onError={onError} />); });
    expect([...host.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))).toEqual(['Close window', 'Minimize window']);
  } finally {
    await act(async () => { root.unmount(); });
  }
  expect(stop).toHaveBeenCalledOnce();
});

it('provides native edge and corner resizing without responding to right-clicks', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  const root = createRoot(host);
  const onError = vi.fn();
  try {
    await act(async () => { root.render(<WindowResizeHandles onError={onError} />); });
    expect(host.querySelectorAll('.window-resize')).toHaveLength(8);
    await act(async () => {
      host.querySelector('.window-resize-NorthWest')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }));
    });
    expect(window.startResizeDragging).not.toHaveBeenCalled();
    await act(async () => {
      host.querySelector('.window-resize-NorthWest')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    });
    expect(window.startResizeDragging).toHaveBeenCalledWith('NorthWest');
    window.startResizeDragging.mockRejectedValueOnce(new Error('Denied'));
    await act(async () => {
      host.querySelector('.window-resize-East')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    });
    expect(onError).toHaveBeenCalledWith('Could not resize window: Denied');
  } finally {
    await act(async () => { root.unmount(); });
  }
});
