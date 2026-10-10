// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { OriginResetDialog } from './OriginResetDialog';
import type { RepositoryState } from '../model/repository';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('../model/native', () => ({ native: invoke, errorMessage: (e: unknown) => String(e) }));
const branch = 'refs/remotes/origin/feature/topic';
const state: RepositoryState = {
  session: { handle: 'h', location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'local', headRef: 'refs/heads/feature/topic' },
  refs: [{ name: 'origin/feature/topic', fullName: branch, kind: 'remote', commitId: 'origin-tip' }], remotes: ['origin'], fingerprint: 'refs',
};
const operation = { kind: 'none', label: '', current: null, incoming: null, step: null, total: null, conflicts: [], canContinue: false, canSkip: false, fingerprint: 'reviewed' };
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => {
    if (command === 'repository_snapshot') return { state, operation, status: { entries: [{ path: 'tracked', untracked: false }, { path: 'new', untracked: true }] } };
    if (command === 'repository_state') return state;
    if (command === 'repository_operation_state') return operation;
    if (command === 'repository_branch_relation') return [2, 1];
    throw new Error(command);
  });
});
async function mount(onWrite = vi.fn().mockResolvedValue(undefined)) {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); const onClose = vi.fn(); const onComplete = vi.fn();
  await act(async () => { root.render(<OriginResetDialog handle="h" branch={branch} busy={false} onWrite={onWrite} onClose={onClose} onComplete={onComplete} />); });
  return { host, onWrite, onClose, onComplete,
    button: (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent === label)!,
    cleanup: async () => { await act(async () => root.unmount()); host.remove(); },
  };
}
it('warns with reviewed counts, focuses Cancel, and never writes on cancellation', async () => {
  const t = await mount();
  try {
    expect(t.host.textContent).toContain('Reset feature/topic to origin/feature/topic?');
    expect(t.host.textContent).toContain('2 commits will be removed');
    expect(t.host.textContent).toContain('1 changed tracked file');
    expect(t.host.textContent).toContain('discards all staged and unstaged tracked changes');
    expect(t.host.textContent).toContain('origin-tip');
    expect(document.activeElement).toBe(t.button('Cancel'));
    await act(async () => t.button('Cancel').click());
    expect(t.onClose).toHaveBeenCalledOnce(); expect(t.onWrite).not.toHaveBeenCalled();
  } finally { await t.cleanup(); }
});
it('submits the captured reset request once, only after confirmation', async () => {
  const t = await mount();
  try {
    expect(t.onWrite).not.toHaveBeenCalled();
    await act(async () => { t.button('Reset branch').click(); t.button('Reset branch').click(); });
    expect(t.onWrite).toHaveBeenCalledExactlyOnceWith('repository_run_operation', { request: {
      action: { kind: 'resetToOrigin', branch, expectedOriginOid: 'origin-tip' }, expectedHead: 'local', expectedHeadRef: 'refs/heads/feature/topic', expectedOperation: 'reviewed',
    } });
    expect(t.onComplete).toHaveBeenCalledOnce();
  } finally { await t.cleanup(); }
});
it('requires an explicit new review after a failed write without retrying it', async () => {
  const t = await mount(vi.fn().mockRejectedValue(new Error('staleOperation')));
  try {
    await act(async () => t.button('Reset branch').click());
    expect(t.host.textContent).toContain('staleOperation');
    expect(t.button('Reset branch')).toBeUndefined();
    expect(t.onWrite).toHaveBeenCalledOnce(); expect(t.onComplete).not.toHaveBeenCalled();
    await act(async () => t.button('Review again').click());
    expect(t.button('Reset branch')).toBeDefined(); expect(t.onWrite).toHaveBeenCalledOnce();
  } finally { await t.cleanup(); }
});
it('refuses a review when working state changes during capture', async () => {
  invoke.mockImplementation(async (command: string) => {
    if (command === 'repository_snapshot') return { state, operation, status: { entries: [] } };
    if (command === 'repository_state') return state;
    if (command === 'repository_operation_state') return { ...operation, fingerprint: 'changed' };
    return [2, 1];
  });
  const t = await mount();
  try {
    expect(t.host.textContent).toContain('Repository changed during review');
    expect(t.button('Reset branch')).toBeUndefined(); expect(t.onWrite).not.toHaveBeenCalled();
  } finally { await t.cleanup(); }
});
