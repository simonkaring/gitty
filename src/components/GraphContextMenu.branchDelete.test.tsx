// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { GraphContextMenu, type MenuTarget } from './GraphContextMenu';
import type { RepositoryState } from '../model/repository';

const nativeCall = vi.hoisted(() => vi.fn());
vi.mock('../model/native', () => ({ native: nativeCall, isDemoHandle: (handle: unknown) => typeof handle === 'string' && handle.startsWith('demo:') }));

const makeState = (headRef = 'refs/heads/main', handle = 'handle'): RepositoryState => ({
  session: { handle, location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'head', headRef },
  refs: [
    { name: 'main', fullName: 'refs/heads/main', commitId: 'head', kind: 'local' },
    { name: 'topic', fullName: 'refs/heads/topic', commitId: 'local-tip', kind: 'local' },
    { name: 'origin/topic', fullName: 'refs/remotes/origin/topic', commitId: 'origin-tip', kind: 'remote' },
  ], remotes: ['origin'], fingerprint: 'state',
});
const target: MenuTarget = { context: { oid: 'local-tip', ref: 'refs/heads/topic' }, x: 20, y: 20, trigger: document.body };
const noop = () => {};

it('offers explicit local, origin, and both scopes and disables current-local destructive scopes', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  nativeCall.mockResolvedValue([1, 1]);
  const host = document.createElement('div'); const root = createRoot(host); const onDelete = vi.fn();
  const render = (state: RepositoryState) => <GraphContextMenu target={target} state={state} busy={false} onOperation={noop} onSwitchBranch={noop} onShowDetails={noop} onSetBase={noop} onSetTarget={noop} onCompare={noop} onPullRequest={noop} onRemoteAction={noop} onPush={noop} onCopy={noop} onDeleteBranch={onDelete} onClose={noop} />;
  try {
    await act(async () => { root.render(render(makeState())); });
    const local = [...host.querySelectorAll('button')].find(button => button.textContent?.startsWith('Delete local branch')) as HTMLButtonElement;
    const origin = [...host.querySelectorAll('button')].find(button => button.textContent?.startsWith('Delete branch on origin')) as HTMLButtonElement;
    const both = [...host.querySelectorAll('button')].find(button => button.textContent?.startsWith('Delete local and origin')) as HTMLButtonElement;
    expect(local.disabled).toBe(false); expect(origin.disabled).toBe(false); expect(both.disabled).toBe(false);
    await act(async () => { local.click(); origin.click(); both.click(); });
    expect(onDelete.mock.calls.map(call => call[1])).toEqual(['local', 'origin', 'both']);
    onDelete.mockClear();
    await act(async () => { root.render(render(makeState('refs/heads/topic'))); });
    const currentLocal = [...host.querySelectorAll('button')].find(button => button.textContent?.startsWith('Delete local branch')) as HTMLButtonElement;
    const currentBoth = [...host.querySelectorAll('button')].find(button => button.textContent?.startsWith('Delete local and origin')) as HTMLButtonElement;
    const currentOrigin = [...host.querySelectorAll('button')].find(button => button.textContent?.startsWith('Delete branch on origin')) as HTMLButtonElement;
    expect(currentLocal.disabled).toBe(true); expect(currentBoth.disabled).toBe(true); expect(currentOrigin.disabled).toBe(false);
    await act(async () => { root.render(render(makeState('refs/heads/main', 'demo:repo'))); });
    expect([...host.querySelectorAll('button')].filter(button => button.textContent?.startsWith('Delete ')).every(button => (button as HTMLButtonElement).disabled)).toBe(true);
  } finally { await act(async () => { root.unmount(); }); }
});
