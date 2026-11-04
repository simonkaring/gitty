// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { GraphContextMenu, type MenuTarget } from './GraphContextMenu';
import type { RepositoryState } from '../model/repository';

const nativeCall = vi.hoisted(() => vi.fn());
vi.mock('../model/native', () => ({ native: nativeCall, isDemoHandle: (handle: unknown) => typeof handle === 'string' && handle.startsWith('demo:') }));

const makeState = (headRef = 'refs/heads/main', originTip = 'origin-tip'): RepositoryState => ({
  session: { handle: 'handle', location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: headRef === 'refs/heads/main' ? 'head' : 'local-tip', headRef },
  refs: [
    { name: 'main', fullName: 'refs/heads/main', commitId: 'head', kind: 'local' },
    { name: 'topic', fullName: 'refs/heads/topic', commitId: 'local-tip', kind: 'local' },
    { name: 'origin/topic', fullName: 'refs/remotes/origin/topic', commitId: originTip, kind: 'remote' },
  ], remotes: ['origin'], fingerprint: 'state',
});
const noop = () => {};
const local: MenuTarget = { context: { oid: 'local-tip', ref: 'refs/heads/topic' }, x: 1, y: 1, trigger: document.body };
const remote: MenuTarget = { context: { oid: 'origin-tip', ref: 'refs/remotes/origin/topic' }, x: 1, y: 1, trigger: document.body };

async function open(target: MenuTarget, state: RepositoryState) {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  nativeCall.mockResolvedValue([1, 1]);
  const onRemoteAction = vi.fn(); const onResetToOrigin = vi.fn();
  const host = document.createElement('div'); const root = createRoot(host);
  await act(async () => root.render(<GraphContextMenu target={target} state={state} busy={false} onOperation={noop} onSwitchBranch={noop} onShowDetails={noop} onSetBase={noop} onSetTarget={noop} onCompare={noop} onPullRequest={noop} onRemoteAction={onRemoteAction} onPush={noop} onResetToOrigin={onResetToOrigin} onCopy={noop} onDeleteBranch={noop} onClose={noop} />));
  const item = (prefix: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent?.startsWith(prefix));
  return { item, onRemoteAction, onResetToOrigin, close: () => act(async () => root.unmount()) };
}

it.each([['local', local], ['origin', remote]])('pulls and resets a branch that is not checked out from its %s menu', async (_, target) => {
  const menu = await open(target, makeState());
  try {
    await act(async () => menu.item('Pull topic from origin')!.click());
    expect(menu.onRemoteAction).toHaveBeenCalledWith({ kind: 'pull', remote: 'origin', branch: 'topic', target: 'topic' });
    await act(async () => menu.item('Reset topic to origin/topic')!.click());
    expect(menu.onResetToOrigin).toHaveBeenCalledWith('refs/remotes/origin/topic');
  } finally { await menu.close(); }
});

it('hides reset once the local branch already matches origin', async () => {
  const menu = await open(local, makeState('refs/heads/main', 'local-tip'));
  try {
    expect(menu.item('Pull topic from origin')).toBeDefined();
    expect(menu.item('Reset topic')).toBeUndefined();
  } finally { await menu.close(); }
});

it('offers reset, and pull modes on the origin menu, for the checked-out branch', async () => {
  const state = makeState('refs/heads/topic');
  const fromLocal = await open(local, state);
  try {
    expect(fromLocal.item('Reset topic to origin/topic')).toBeDefined();
    expect(fromLocal.item('Pull topic from origin')).toBeUndefined();
  } finally { await fromLocal.close(); }
  const fromOrigin = await open(remote, state);
  try {
    await act(async () => fromOrigin.item('Pull (merge)')!.click());
    expect(fromOrigin.onRemoteAction).toHaveBeenCalledWith({ kind: 'pull', remote: 'origin', branch: 'topic', pullMode: 'merge' });
    expect(fromOrigin.item('Pull topic from origin')).toBeUndefined();
  } finally { await fromOrigin.close(); }
});
