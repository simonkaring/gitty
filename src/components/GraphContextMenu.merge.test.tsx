// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { GraphContextMenu, type MenuTarget } from './GraphContextMenu';
import type { ActionContext } from './OperationDialog';
import type { RepositoryState } from '../model/repository';

const nativeCall = vi.hoisted(() => vi.fn());
vi.mock('../model/native', () => ({ native: nativeCall, isDemoHandle: (handle: unknown) => typeof handle === 'string' && handle.startsWith('demo:') }));

const makeState = (headRef: string | null = 'refs/heads/main'): RepositoryState => ({
  session: { handle: 'handle', location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'head', headRef },
  refs: [
    { name: 'main', fullName: 'refs/heads/main', commitId: 'head', kind: 'local' },
    { name: 'topic', fullName: 'refs/heads/topic', commitId: 'local-tip', kind: 'local' },
    { name: 'origin/topic', fullName: 'refs/remotes/origin/topic', commitId: 'origin-tip', kind: 'remote' },
    { name: 'upstream/topic', fullName: 'refs/remotes/upstream/topic', commitId: 'upstream-tip', kind: 'remote' },
  ], remotes: ['origin', 'upstream'], fingerprint: 'state',
});

const noop = () => {};

async function renderMenu(state: RepositoryState, target: MenuTarget, onOperation: (context: ActionContext) => void) {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  const root = createRoot(host);
  const renderTarget = async (target: MenuTarget) => {
    await act(async () => { root.render(<GraphContextMenu target={target} state={state} busy={false} onOperation={onOperation} onSwitchBranch={noop} onShowDetails={noop} onSetBase={noop} onSetTarget={noop} onCompare={noop} onPullRequest={noop} onRemoteAction={noop} onPush={noop} onCopy={noop} onDeleteBranch={noop} onClose={noop} />); });
  };
  await renderTarget(target);
  return { root, renderTarget, menuItems: () => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')] };
}

it('ignores an earlier branch relation response after changing the remote menu target', async () => {
  let finishOrigin!: (value: [number, number]) => void;
  nativeCall.mockImplementation((_command, args) => args.first === 'refs/remotes/origin/topic'
    ? new Promise<[number, number]>(resolve => { finishOrigin = resolve; })
    : Promise.resolve([2, 0]));
  const target: MenuTarget = { context: { oid: 'origin-tip', ref: 'refs/remotes/origin/topic' }, x: 20, y: 20, trigger: document.body };
  const menu = await renderMenu(makeState(), target, vi.fn());
  try {
    await menu.renderTarget({ ...target, context: { oid: 'upstream-tip', ref: 'refs/remotes/upstream/topic' } });
    await act(async () => { finishOrigin([0, 1]); });
    expect(menu.menuItems().find(button => button.textContent?.startsWith('Merge upstream/topic into main'))?.textContent).toMatch(/2 commits/);
  } finally { await act(async () => menu.root.unmount()); }
});

it('merges the exact remote-tracking source into the current local branch without offering a remote destination', async () => {
  nativeCall.mockResolvedValue([2, 0]);
  const onOperation = vi.fn();
  const target: MenuTarget = { context: { oid: 'upstream-tip', ref: 'refs/remotes/upstream/topic' }, x: 20, y: 20, trigger: document.body };
  const { root, menuItems } = await renderMenu(makeState(), target, onOperation);
  try {
    const merge = menuItems().find(button => button.textContent?.startsWith('Merge upstream/topic into main'));
    expect(merge?.textContent).toBe('Merge upstream/topic into main… · 2 commits to bring in');
    expect(menuItems().some(button => button.textContent?.startsWith('Merge main into upstream/topic'))).toBe(false);
    await act(async () => merge!.click());
    expect(onOperation).toHaveBeenCalledExactlyOnceWith({ oid: 'upstream-tip', ref: 'refs/remotes/upstream/topic', destination: 'refs/heads/main', initial: 'merge' });
  } finally { await act(async () => root.unmount()); }
});

it('does not offer a remote merge into a detached HEAD or an empty remote comparison', async () => {
  nativeCall.mockResolvedValue([0, 1]);
  const onOperation = vi.fn();
  const remote: MenuTarget = { context: { oid: 'upstream-tip', ref: 'refs/remotes/upstream/topic' }, x: 20, y: 20, trigger: document.body };
  const detached = await renderMenu(makeState(null), remote, onOperation);
  try {
    expect(detached.menuItems().some(button => button.textContent?.startsWith('Merge upstream/topic'))).toBe(false);
  } finally { await act(async () => detached.root.unmount()); }

  const current = await renderMenu(makeState(), remote, onOperation);
  try {
    const merge = current.menuItems().find(button => button.textContent?.startsWith('Merge upstream/topic'));
    expect(merge).toBeUndefined();
    expect(current.menuItems().find(button => button.textContent === 'upstream/topic has no commits to bring into main')?.disabled).toBe(true);
    expect(onOperation).not.toHaveBeenCalled();
  } finally { await act(async () => current.root.unmount()); }
});
