// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { StashMessageDialog } from './StashMessageDialog';
import type { StashEntry } from '../model/remote';

const stash: StashEntry = { oid: 'a'.repeat(40), selector: 'stash@{0}', message: 'WIP on main: abc123 base', parents: ['b'.repeat(40)], author: 'Ada', email: 'ada@example.com', timestamp: 1 };

it('prefills and saves a trimmed message, staying open on failure', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  const host = document.createElement('div'); const root = createRoot(host);
  const onSave = vi.fn().mockRejectedValueOnce(new Error('stash busy')).mockResolvedValueOnce(undefined);
  const onClose = vi.fn();
  try {
    await act(async () => root.render(<StashMessageDialog stash={stash} onSave={onSave} onClose={onClose} />));
    const input = host.querySelector('input')!;
    expect(input.value).toBe(stash.message);
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setValue.call(input, '  new message  '); input.dispatchEvent(new Event('input', { bubbles: true })); });
    const submit = () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await act(async () => { submit(); });
    expect(onSave).toHaveBeenLastCalledWith('new message');
    expect(host.textContent).toContain('stash busy');
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { submit(); });
    expect(onClose).toHaveBeenCalled();
  } finally { await act(async () => { root.unmount(); }); host.remove(); }
});
