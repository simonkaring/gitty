// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { GraphContextMenu, type MenuTarget } from './GraphContextMenu';
import type { RepositoryState } from '../model/repository';

const nativeCall = vi.hoisted(() => vi.fn());
vi.mock('../model/native', () => ({ native: nativeCall, isDemoHandle: (handle: unknown) => typeof handle === 'string' && handle.startsWith('demo:') }));

const makeState = (headRef = 'refs/heads/main'): RepositoryState => ({
  session: { handle: 'handle', location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'head', headRef },
  refs: [
    { name: 'main', fullName: 'refs/heads/main', commitId: 'head', kind: 'local' },
    { name: 'topic', fullName: 'refs/heads/topic', commitId: 'local-tip', kind: 'local' },
    { name: 'origin/topic', fullName: 'refs/remotes/origin/topic', commitId: 'origin-tip', kind: 'remote' },
  ], remotes: ['origin'], fingerprint: 'state',
});

const noop = () => {};
const target: MenuTarget = { context: { oid: 'local-tip', ref: 'refs/heads/topic' }, x: 20, y: 20, trigger: document.body };

async function renderMenu(state: RepositoryState, onPush: (ref: string) => void, busy = false) {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => { root.render(<GraphContextMenu target={target} state={state} busy={busy} onOperation={noop} onSwitchBranch={noop} onShowDetails={noop} onSetBase={noop} onSetTarget={noop} onCompare={noop} onPullRequest={noop} onRemoteAction={noop} onPush={onPush} onCopy={noop} onDeleteBranch={noop} onClose={noop} />); });
  return { host, root, menuItems: () => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')] };
}

it('offers Push for a non-current local branch ahead of its same-name origin', async () => {
  nativeCall.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === 'repository_branch_relation') return [1, 0];
    if (command === 'repository_sync_info') return { branch: args.branch, upstream: `origin/${args.branch}`, ahead: 2, behind: 0, remotes: ['origin'] };
    return undefined;
  });
  const onPush = vi.fn();
  const { root, menuItems } = await renderMenu(makeState(), onPush);
  try {
    const push = menuItems().find(button => button.textContent === 'Push topic to origin');
    expect(push).toBeDefined();
    expect(menuItems().some(button => button.textContent === 'Push / Publish…')).toBe(false);
    await act(async () => push!.click());
    expect(onPush).toHaveBeenCalledWith('refs/heads/topic');
  } finally { await act(async () => root.unmount()); }
});

it('does not offer branch push without commits ahead or a same-name origin upstream', async () => {
  const scenarios = [
    { ahead: 0, upstream: 'origin/topic' },
    { ahead: null, upstream: 'origin/topic' },
    { ahead: 2, upstream: 'team/topic' },
  ];
  for (const scenario of scenarios) {
    nativeCall.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'repository_branch_relation') return [1, 0];
      if (command === 'repository_sync_info') return { branch: args.branch, upstream: scenario.upstream, ahead: scenario.ahead, behind: 0, remotes: ['origin', 'team'] };
      return undefined;
    });
    const { root, menuItems } = await renderMenu(makeState(), noop);
    try { expect(menuItems().some(button => button.textContent?.startsWith('Push topic to origin'))).toBe(false); }
    finally { await act(async () => root.unmount()); }
  }
});

it('keeps the current branch on the existing Push / Publish flow', async () => {
  nativeCall.mockResolvedValue([1, 0]);
  const { root, menuItems } = await renderMenu(makeState('refs/heads/topic'), noop);
  try {
    expect(menuItems().some(button => button.textContent === 'Push / Publish…')).toBe(true);
    expect(menuItems().some(button => button.textContent?.startsWith('Push topic to origin'))).toBe(false);
  } finally { await act(async () => root.unmount()); }
});

it('disables branch push while the repository is busy', async () => {
  nativeCall.mockImplementation(async (command: string) => command === 'repository_sync_info'
    ? { branch: 'topic', upstream: 'origin/topic', ahead: 2, behind: 0, remotes: ['origin'] }
    : [1, 0]);
  const onPush = vi.fn();
  const { root, menuItems } = await renderMenu(makeState(), onPush, true);
  try {
    const push = menuItems().find(button => button.textContent === 'Push topic to origin');
    expect(push?.disabled).toBe(true);
    await act(async () => push!.click());
    expect(onPush).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});
