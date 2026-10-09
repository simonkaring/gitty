// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { loadScale, useScale } from './scale';

afterEach(() => { vi.unstubAllGlobals(); });

it('shares one zoom value across consumers and applies and persists it once changed', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } });
  const host = document.createElement('div'), root = createRoot(host);
  let change: (percent: number) => void = () => {};
  function Reader({ name }: { name: string }) {
    const [scale, setScale] = useScale();
    if (name === 'a') change = setScale;
    return <output data-name={name}>{scale}</output>;
  }
  const read = (name: string) => host.querySelector(`[data-name="${name}"]`)!.textContent;
  try {
    await act(async () => { root.render(<><Reader name="a" /><Reader name="b" /></>); });
    expect(read('a')).toBe(read('b'));
    await act(async () => { change(125); });
    expect(read('a')).toBe('125');
    expect(read('b')).toBe('125');
    expect(loadScale()).toBe(125);
    expect(document.documentElement.style.zoom).toBe('1.25');
  } finally {
    await act(async () => { root.unmount(); });
  }
});
