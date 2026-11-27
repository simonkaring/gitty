// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { TagDeleteDialog } from './TagDeleteDialog';
import type { RepositoryState } from '../model/repository';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('../model/native', () => ({ native: invoke, errorMessage: (e: unknown) => String(e) }));
const tag = { name: 'v1', fullName: 'refs/tags/v1', kind: 'tag' as const, commitId: 'tagged' };
const state: RepositoryState = {
  session: { handle: 'h', location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'head', headRef: 'refs/heads/main' },
  refs: [tag], remotes: ['origin'], fingerprint: 'refs',
};
const operation = { kind: 'none', label: '', current: null, incoming: null, step: null, total: null, conflicts: [], canContinue: false, canSkip: false, fingerprint: 'reviewed' };
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => command === 'repository_state' ? state : operation);
});

it('deletes on origin first, then retries only the local tag after a partial failure', async () => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const onRemoteWrite = vi.fn().mockResolvedValue('');
  const onWrite = vi.fn().mockRejectedValueOnce('locked').mockResolvedValue(undefined);
  const onComplete = vi.fn();
  await act(async () => { root.render(<TagDeleteDialog handle="h" tag={tag} hasOrigin busy={false} onRemoteWrite={onRemoteWrite} onWrite={onWrite} onClose={vi.fn()} onComplete={onComplete} />); });
  const deleteButton = () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Delete tag')!;
  try {
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => deleteButton().click());
    expect(onRemoteWrite).toHaveBeenCalledWith('repository_remote_action', { action: { kind: 'deleteRemoteTag', remote: 'origin', tag: 'v1', expectedOid: 'tagged' } });
    expect(host.textContent).toContain('deleted on origin, but not locally');
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
    await act(async () => deleteButton().click());
    expect(onRemoteWrite).toHaveBeenCalledTimes(1);
    expect(onWrite).toHaveBeenLastCalledWith('repository_run_operation', { request: expect.objectContaining({ action: { kind: 'deleteTag', name: 'v1', expectedOid: 'tagged' } }) });
    expect(onComplete).toHaveBeenCalledWith('Deleted tag v1.');
  } finally { await act(async () => root.unmount()); host.remove(); }
});
