// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { GraphContextMenu, type MenuTarget } from './GraphContextMenu';
import type { RepositoryState } from '../model/repository';

const nativeCall = vi.hoisted(() => vi.fn());
vi.mock('../model/native', () => ({ native: nativeCall, isDemoHandle: () => false }));

const state: RepositoryState = {
  session: { handle: 'handle', location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'head', headRef: 'refs/heads/main' },
  refs: [{ name: 'main', fullName: 'refs/heads/main', commitId: 'head', kind: 'local' }, { name: 'stash', fullName: 'refs/stash', commitId: 'stash-oid', kind: 'stash' }],
  remotes: [], fingerprint: 'state',
};
const noop = () => {};

it('offers Pop and Drop only for the stash commit', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  nativeCall.mockResolvedValue(undefined);
  const onStash = vi.fn();
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = async (target: MenuTarget) => act(async () => { root.render(<GraphContextMenu target={target} state={state} busy={false} onOperation={noop} onSwitchBranch={noop} onShowDetails={noop} onSetBase={noop} onSetTarget={noop} onCompare={noop} onPullRequest={noop} onRemoteAction={noop} onPush={noop} onResetToOrigin={noop} onCopy={noop} onDeleteBranch={noop} onStash={onStash} onClose={noop} />); });
  const items = () => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map(button => button.textContent);
  try {
    await render({ context: { oid: 'stash-oid', ref: 'refs/stash' }, x: 0, y: 0, trigger: host });
    expect(items()).toContain('Pop stash…');
    expect(items()).toContain('Drop stash…');
    const pop = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent === 'Pop stash…')!;
    await act(async () => { pop.click(); });
    expect(onStash).toHaveBeenCalledWith({ kind: 'pop', oid: 'stash-oid', restoreIndex: true });
    await render({ context: { oid: 'head' }, x: 0, y: 0, trigger: host });
    expect(items()).not.toContain('Pop stash…');
  } finally { await act(async () => { root.unmount(); }); }
});
