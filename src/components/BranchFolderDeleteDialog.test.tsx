// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { BranchFolderDeleteDialog } from './BranchFolderDeleteDialog';
import { folderDeleteTargets } from '../model/branchDelete';
import type { BranchBatchDeleteExecution } from '../model/operations';
import type { RepositoryState } from '../model/repository';

const nativeCall = vi.hoisted(() => vi.fn());
vi.mock('../model/native', () => ({ native: nativeCall, errorMessage: (error: unknown) => String(error) }));

const state: RepositoryState = {
  session: { handle: 'handle', location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'head', headRef: 'refs/heads/feat/current' },
  refs: [
    { name: 'feat/current', fullName: 'refs/heads/feat/current', commitId: 'head', kind: 'local' },
    { name: 'feat/merged', fullName: 'refs/heads/feat/merged', commitId: 'm1', kind: 'local' },
    { name: 'feat/wip', fullName: 'refs/heads/feat/wip', commitId: 'w1', kind: 'local' },
  ], remotes: [], fingerprint: 'state',
};
const ok = { target: 'local' as const, status: 'deleted' as const, error: null, note: null };
const refused: BranchBatchDeleteExecution = { result: { branches: [
  { branch: 'feat/merged', local: ok, origin: null },
  { branch: 'feat/wip', local: { target: 'local', status: 'failed', error: { code: 'branchNotMerged', message: 'Not merged' }, note: null }, origin: null },
] } };
const forced: BranchBatchDeleteExecution = { result: { branches: [{ branch: 'feat/wip', local: ok, origin: null }] } };

it('reviews folder branches, skips the current branch, and force-deletes only refused unmerged branches after one confirmation', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  const onDelete = vi.fn().mockResolvedValueOnce(refused).mockResolvedValueOnce(forced);
  const onComplete = vi.fn();
  const folder = { kind: 'local' as const, path: 'feat' };
  const host = document.createElement('div'); const root = createRoot(host);
  const button = (text: string) => [...host.querySelectorAll('button')].find(item => item.textContent === text) as HTMLButtonElement | undefined;
  try {
    await act(async () => { root.render(<BranchFolderDeleteDialog state={state} folder={folder} scope="local" targets={folderDeleteTargets(state, folder, 'local')} onClose={() => {}} onComplete={onComplete} onDelete={onDelete} />); });
    expect(host.textContent).toContain('Delete 2 branches in feat/?');
    expect(host.textContent).toContain('feat/current — current branch');
    await act(async () => { button('Confirm local deletion of 2 branches')!.click(); });
    expect(onDelete.mock.calls[0][0]).toMatchObject({ deleteLocal: true, deleteOrigin: false, forceLocal: [], branches: [{ branch: 'feat/merged', expectedLocalOid: 'm1' }, { branch: 'feat/wip', expectedLocalOid: 'w1' }] });
    expect(button('Force delete 1 branch and continue')!.disabled).toBe(true);
    await act(async () => { (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
    await act(async () => { button('Force delete 1 branch and continue')!.click(); });
    expect(onDelete.mock.calls[1][0]).toMatchObject({ forceLocal: ['feat/wip'], branches: [{ branch: 'feat/wip', expectedLocalOid: 'w1' }] });
    expect(onComplete).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain('Force delete');
    expect(host.querySelectorAll('[data-status="deleted"]').length).toBe(2);
    expect(nativeCall).not.toHaveBeenCalled();
  } finally {
    await act(async () => { root.unmount(); });
  }
});
