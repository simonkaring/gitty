// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { StashContextMenu, type StashMenuTarget } from './StashContextMenu';
import type { StashEntry } from '../model/remote';

const stash: StashEntry = { oid: 'a'.repeat(40), selector: 'stash@{0}', message: 'WIP on main: abc123 base', parents: ['b'.repeat(40), 'c'.repeat(40)], author: 'Ada', email: 'ada@example.com', timestamp: 1 };
const target: StashMenuTarget = { stash, x: 20, y: 20, trigger: document.body };

it('pops, confirms a drop, and opens the message editor', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); const root = createRoot(host);
  const onPop = vi.fn(), onDrop = vi.fn(), onEditMessage = vi.fn();
  const render = (canPop: boolean) => <StashContextMenu target={target} busy={false} canPop={canPop} onPop={onPop} onDrop={onDrop} onEditMessage={onEditMessage} onClose={() => {}} />;
  const item = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent === text);
  try {
    await act(async () => root.render(render(false)));
    expect(item('Pop stash')?.disabled).toBe(true);
    await act(async () => root.render(render(true)));
    await act(async () => item('Pop stash')!.click());
    expect(onPop).toHaveBeenCalledWith(stash);

    await act(async () => item('Delete stash')!.click());
    expect(onDrop).not.toHaveBeenCalled();
    await act(async () => item('Confirm delete')!.click());
    expect(onDrop).toHaveBeenCalledWith(stash);

    await act(async () => item('Edit stash message…')!.click());
    expect(onEditMessage).toHaveBeenCalledWith(stash);
  } finally { await act(async () => { root.unmount(); }); host.remove(); }
});
