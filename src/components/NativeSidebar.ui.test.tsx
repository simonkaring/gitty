// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { NativeSidebar } from './NativeSidebar';
import type { RepositoryState } from '../model/repository';

it('double-click switches local and origin branches but not tags or other remotes', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const state: RepositoryState = {
    session: { handle: 'test', location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'tip', headRef: 'refs/heads/main' },
    refs: [
      { name: 'topic', fullName: 'refs/heads/topic', kind: 'local', commitId: 'tip' },
      { name: 'origin/feature/topic', fullName: 'refs/remotes/origin/feature/topic', kind: 'remote', commitId: 'tip' },
      { name: 'upstream/topic', fullName: 'refs/remotes/upstream/topic', kind: 'remote', commitId: 'tip' },
      { name: 'origin/HEAD', fullName: 'refs/remotes/origin/HEAD', kind: 'remote', commitId: 'tip' },
      { name: 'v1', fullName: 'refs/tags/v1', kind: 'tag', commitId: 'tip' },
    ], remotes: ['origin', 'upstream'], fingerprint: '',
  };
  const switchBranch = vi.fn();
  const host = document.createElement('div'); const root = createRoot(host);
  try {
    await act(async () => { root.render(<NativeSidebar state={state} commits={[]} filters={null} busy={false} reveal={() => {}} switchBranch={switchBranch} openMenu={() => {}} onAction={() => {}} folderOpen={{}} onFolderOpen={() => {}} />); });
    for (const button of host.querySelectorAll('.ref-item')) {
      await act(async () => { button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    }
    expect(switchBranch.mock.calls).toEqual([['refs/heads/topic'], ['refs/remotes/origin/feature/topic']]);
    expect(host.querySelector('[title="refs/remotes/origin/HEAD"]')).toBeNull();
  } finally { await act(async () => { root.unmount(); }); }
});
