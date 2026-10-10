// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { RemoteStashDialog } from './RemoteStashDialog';

const nativeCall = vi.hoisted(() => vi.fn());
vi.mock('../model/native', () => ({ native: nativeCall, errorMessage: (error: unknown) => String(error) }));

it('restores staging by default when recovering a merge stash and permits a worktree-only apply', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  nativeCall.mockResolvedValue([{ oid: 'saved-oid', selector: 'stash@{0}', message: 'Gitty merge work saved' }]);
  const onWrite = vi.fn().mockResolvedValue('applied');
  const host = document.createElement('div'), root = createRoot(host);
  const button = (text: string) => [...host.querySelectorAll('button')].find(value => value.textContent === text)!;
  try {
    await act(async () => { root.render(<RemoteStashDialog handle="repo" onWrite={onWrite} onClose={() => {}} notify={() => {}} />); });
    const check = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(input => input.parentElement?.textContent === ' Restore staged changes')!;
    expect(check.checked).toBe(true);
    await act(async () => { button('Pop').click(); });
    expect(onWrite).toHaveBeenLastCalledWith('repository_stash_action', { action: { kind: 'pop', oid: 'saved-oid', restoreIndex: true } });
    await act(async () => { check.click(); });
    await act(async () => { button('Apply').click(); });
    expect(onWrite).toHaveBeenLastCalledWith('repository_stash_action', { action: { kind: 'apply', oid: 'saved-oid', restoreIndex: false } });
  } finally {
    await act(async () => { root.unmount(); });
  }
});
