// @vitest-environment jsdom
import { act, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.restoreAllMocks());

it('shows an alert for a render error and Retry remounts fresh children', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let shouldThrow = true;
  const mounts = vi.fn(), unmounts = vi.fn();
  function Child() {
    if (shouldThrow) throw new Error('boom: invalid time value');
    useEffect(() => { mounts(); return unmounts; }, []);
    return <p id="ok">healthy</p>;
  }
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<ErrorBoundary><Child /></ErrorBoundary>));
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('boom: invalid time value');
    expect(host.querySelector('#ok')).toBeNull();

    shouldThrow = false;
    await act(async () => alert.querySelector<HTMLButtonElement>('button')!.click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('#ok')?.textContent).toBe('healthy');
    expect(mounts).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); host.remove(); }
  expect(unmounts).toHaveBeenCalledOnce();
});

it('a child that fails after mounting is cleaned up, and Retry creates a new instance', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const cleanups: number[] = [];
  let created = 0;
  let poison: (() => void) | null = null;
  function Pane() {
    const [id] = useState(() => ++created);
    const [broken, setBroken] = useState(false);
    useEffect(() => { poison = () => setBroken(true); return () => { cleanups.push(id); }; }, [id]);
    if (broken) throw new Error('late failure');
    return <span id="pane">{id}</span>;
  }
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<ErrorBoundary><Pane /></ErrorBoundary>));
    expect(host.querySelector('#pane')?.textContent).toBe('1');
    await act(async () => poison!());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('late failure');
    expect(cleanups).toEqual([1]);
    await act(async () => host.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
    expect(host.querySelector('#pane')?.textContent).toBe('2');
  } finally { await act(async () => root.unmount()); host.remove(); }
});
