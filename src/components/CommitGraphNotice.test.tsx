// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { CommitGraphNotice } from './CommitGraphNotice';
import { ToastProvider } from './ui';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } });
  mocks.invoke.mockReset().mockResolvedValue('missing');
});

it('offers an accessible action, persists dismissal on remount, and does not read hidden tabs', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const run = vi.fn();
  const render = async (key: string, active = true) => {
    await act(async () => { root.render(<ToastProvider value={host}><CommitGraphNotice key={key} handle={key} repositoryKey="native:/repo" active={active} firstPageMs={350} busy={false} onRun={run} /></ToastProvider>); });
  };
  try {
    await render('session-one');
    const action = Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Speed up history');
    expect(action).toBeDefined();
    await act(async () => action!.click());
    expect(run).toHaveBeenCalledOnce();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification"]')!.click());
    expect(host.textContent).not.toContain('History loads faster');
    await render('session-two');
    expect(host.textContent).not.toContain('History loads faster');
    mocks.invoke.mockClear();
    await render('session-hidden', false);
    expect(mocks.invoke).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); host.remove(); }
});
