// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { GraphContextMenu, type MenuTarget } from './GraphContextMenu';
import type { RepositoryState } from '../model/repository';

vi.mock('../model/native', () => ({ native: vi.fn().mockResolvedValue([0, 0]), isDemoHandle: (handle: unknown) => typeof handle === 'string' && handle.startsWith('demo:') }));

const state = (remotes: string[]): RepositoryState => ({
  session: { handle: 'handle', location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'head', headRef: 'refs/heads/main' },
  refs: [
    { name: 'main', fullName: 'refs/heads/main', commitId: 'head', kind: 'local' },
    { name: 'v1.0.0', fullName: 'refs/tags/v1.0.0', commitId: 'tagged', kind: 'tag' },
  ], remotes, fingerprint: 'state',
});
const noop = () => {};
const target: MenuTarget = { context: { oid: 'tagged', ref: 'refs/tags/v1.0.0' }, x: 20, y: 20, trigger: document.body };

async function renderMenu(remotes: string[], onRemoteAction = vi.fn(), onDeleteTag = vi.fn()) {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => { root.render(<GraphContextMenu target={target} state={state(remotes)} busy={false} onOperation={noop} onSwitchBranch={noop} onShowDetails={noop} onSetBase={noop} onSetTarget={noop} onCompare={noop} onPullRequest={noop} onRemoteAction={onRemoteAction} onPush={noop} onResetToOrigin={noop} onCopy={noop} onDeleteBranch={noop} onDeleteTag={onDeleteTag} onStash={noop} onClose={noop} />); });
  const item = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent === text);
  return { root, item };
}

it('pushes and deletes a tag pinned to its commit', async () => {
  const onRemoteAction = vi.fn(), onDeleteTag = vi.fn();
  const { root, item } = await renderMenu(['origin'], onRemoteAction, onDeleteTag);
  try {
    await act(async () => item('Push tag v1.0.0 to origin')!.click());
    expect(onRemoteAction).toHaveBeenCalledWith({ kind: 'pushTag', remote: 'origin', tag: 'v1.0.0', expectedOid: 'tagged' });
    await act(async () => item('Delete tag v1.0.0…')!.click());
    expect(onDeleteTag).toHaveBeenCalledWith('refs/tags/v1.0.0');
  } finally { await act(async () => root.unmount()); }
});

it('offers no tag push without an origin remote', async () => {
  const { root, item } = await renderMenu([]);
  try {
    expect(item('Push tag v1.0.0 to origin')).toBeUndefined();
    expect(item('Delete tag v1.0.0…')).toBeDefined();
  } finally { await act(async () => root.unmount()); }
});
