// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { RepositorySession } from '../model/repository';
import { NativeInspector } from './NativeInspector';

type Args = { oid?: string; spec?: { oid?: string } };
const mocks = vi.hoisted(() => ({ native: vi.fn<(command: string, args: Args) => Promise<unknown>>() }));
vi.mock('../model/native', async importOriginal => ({ ...await importOriginal<typeof import('../model/native')>(), native: mocks.native }));

const commit = (id: string, subject: string) => ({ id, parents: ['p1'], subject, body: '', author: 'Ada Lovelace', email: 'ada@example.com', timestamp: 1 });
const files = [{ path: 'src/a.ts', oldPath: null, status: 'M', additions: 1, deletions: 0, binary: false }];

it('shows placeholders only on first load, then keeps the previous commit in place until the next one lands', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const gates = new Map<string, { promise: Promise<void>; open: () => void; fail: boolean }>();
  const gate = (oid: string, fail = false) => {
    let open!: () => void;
    const promise = new Promise<void>(resolve => { open = resolve; });
    gates.set(oid, { promise, open, fail });
  };
  mocks.native.mockImplementation(async (command, args) => {
    const oid = args.oid ?? args.spec!.oid!;
    const g = gates.get(oid)!;
    await g.promise;
    if (g.fail) throw new Error('boom');
    return command === 'repository_commit' ? commit(oid, `Subject ${oid}`) : files;
  });
  const host = document.createElement('div');
  const root = createRoot(host);
  const props = { session: { handle: 'h', head: null } as unknown as RepositorySession, revision: 0, base: '', target: '', onJump() {}, onBase() {}, onTarget() {}, onSwap() {}, onClear() {}, onClose() {}, activePath: null, onActiveDiffChange() {} };
  const render = (selected: string) => act(async () => { root.render(<NativeInspector {...props} selected={selected} />); });
  const aside = () => host.querySelector('aside')!;
  try {
    // First load: nothing to show yet, so layout-matched placeholders hold the space.
    gate('a');
    await render('a');
    expect(aside().getAttribute('aria-busy')).toBe('true');
    expect(host.querySelectorAll('.skeleton-text').length).toBeGreaterThan(0);
    expect(host.textContent).not.toContain('Subject a');
    expect(host.querySelectorAll('.file-row[aria-hidden="true"]')).toHaveLength(4);
    await act(async () => { gates.get('a')!.open(); });
    expect(aside().getAttribute('aria-busy')).toBe('false');
    expect(host.querySelector('.skeleton-text')).toBeNull();
    expect(host.querySelector('h2')?.textContent).toBe('Subject a');

    // Switching rows: previous commit stays rendered (no placeholders, no blank), marked stale and inert.
    gate('b');
    await render('b');
    expect(aside().getAttribute('aria-busy')).toBe('true');
    expect(host.querySelector('.inspector-content')?.hasAttribute('data-stale')).toBe(true);
    expect(host.querySelector('.skeleton-text')).toBeNull();
    expect(host.querySelector('h2')?.textContent).toBe('Subject a');
    expect(host.querySelector('.native-sha')?.textContent).toBe('a');
    expect(host.querySelectorAll('.file-row')).toHaveLength(1);
    expect(host.querySelector<HTMLButtonElement>('.parent-link')?.disabled).toBe(true);
    await act(async () => { gates.get('b')!.open(); });
    expect(aside().getAttribute('aria-busy')).toBe('false');
    expect(host.querySelector('.inspector-content')?.hasAttribute('data-stale')).toBe(false);
    expect(host.querySelector('h2')?.textContent).toBe('Subject b');
    expect(host.querySelector('.native-sha')?.textContent).toBe('b');
    expect(host.querySelector<HTMLButtonElement>('.parent-link')?.disabled).toBe(false);

    // A failed load must not leave the previous commit's data under the new selection.
    gate('c', true);
    await render('c');
    await act(async () => { gates.get('c')!.open(); });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('boom');
    expect(host.textContent).not.toContain('Subject b');
    expect(host.querySelectorAll('.file-row')).toHaveLength(0);
  } finally {
    await act(async () => { root.unmount(); });
  }
});
