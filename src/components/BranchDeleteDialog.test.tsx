// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { BranchDeleteDialog } from './BranchDeleteDialog';
import type { BranchDeleteExecution } from '../model/operations';
import type { RepositoryState } from '../model/repository';

const nativeCall = vi.hoisted(() => vi.fn());
vi.mock('../model/native', () => ({ native: nativeCall, errorMessage: (error: unknown) => String(error) }));

const state: RepositoryState = {
  session: { handle: 'handle', location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'head', headRef: 'refs/heads/main' },
  refs: [
    { name: 'topic', fullName: 'refs/heads/topic', commitId: 'local-tip', kind: 'local' },
    { name: 'origin/topic', fullName: 'refs/remotes/origin/topic', commitId: 'origin-tip', kind: 'remote' },
  ], remotes: ['origin'], fingerprint: 'state',
};
const target = { branch: 'topic', localOid: 'local-tip', originOid: 'origin-tip', canLocal: true, canOrigin: true, canBoth: true };
const refused: BranchDeleteExecution = { result: {
  local: { target: 'local', status: 'failed', error: { code: 'branchNotMerged', message: 'Not merged into HEAD' }, note: null },
  origin: { target: 'origin', status: 'notAttempted', error: null, note: 'Local deletion did not succeed.' },
} };
const partial: BranchDeleteExecution = { result: {
  local: { target: 'local', status: 'deleted', error: null, note: null },
  origin: { target: 'origin', status: 'failed', error: { code: 'git', message: 'Lease rejected' }, note: null },
}, refreshError: 'Snapshot failed' };

it('keeps the selected both scope through the separately confirmed force step and displays partial results', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  nativeCall.mockResolvedValue([{ name: 'origin', pushUrl: 'https://example.test/repo.git' }]);
  const onDelete = vi.fn().mockResolvedValueOnce(refused).mockResolvedValueOnce(partial);
  const onComplete = vi.fn();
  const host = document.createElement('div'); const root = createRoot(host);
  try {
    await act(async () => { root.render(<BranchDeleteDialog state={state} target={target} scope="both" onClose={() => {}} onComplete={onComplete} onDelete={onDelete} />); });
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain('local-tip');
    expect(host.textContent).toContain('origin-tip');
    const initial = [...host.querySelectorAll('button')].find(button => button.textContent === 'Confirm both deletion') as HTMLButtonElement;
    await act(async () => { initial.click(); });
    expect(onDelete.mock.calls[0][0]).toMatchObject({ deleteLocal: true, deleteOrigin: true, forceLocal: false, expectedLocalOid: 'local-tip', expectedOriginOid: 'origin-tip' });
    expect(host.textContent).toContain('This is a separate confirmation');
    const forceCheck = host.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => { forceCheck.click(); });
    const force = [...host.querySelectorAll('button')].find(button => button.textContent === 'Force delete and continue') as HTMLButtonElement;
    await act(async () => { force.click(); });
    expect(onDelete.mock.calls[1][0]).toMatchObject({ deleteLocal: true, deleteOrigin: true, forceLocal: true, expectedLocalOid: 'local-tip', expectedOriginOid: 'origin-tip' });
    expect(host.textContent).toContain('Local: deleted');
    expect(host.textContent).toContain('Origin: failed');
    expect(host.textContent).toContain('Lease rejected');
    expect(host.textContent).toContain('Snapshot failed');
    expect(host.querySelector('dialog[open]')).not.toBeNull();
    expect([...host.querySelectorAll('button')].some(button => button.textContent === 'Force delete and continue')).toBe(false);
  } finally {
    await act(async () => { root.unmount(); });
  }
});
