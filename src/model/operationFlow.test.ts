import { expect, it, vi } from 'vitest';
import { captureOperation, operationAndRefresh, operationContent } from './operationFlow';
import type { native } from './native';

const op = { kind: 'none', fingerprint: 'reviewed', conflicts: [] };
const state = { session: { head: 'original-head', headRef: 'refs/heads/main', bare: false } };
it('captures fresh expected state at review and executes it verbatim without rereading', async () => {
  const reads = vi.fn().mockResolvedValueOnce(op).mockResolvedValueOnce(state).mockResolvedValueOnce(op);
  const action = { kind: 'cherryPick' as const, commits: ['first', 'second'], mainline: 2 };
  const request = await captureOperation('handle', action, reads as typeof native);
  action.commits.reverse();
  expect(request.action).toEqual({ kind: 'cherryPick', commits: ['first', 'second'], mainline: 2 });
  const invoke = vi.fn().mockRejectedValue(new Error('HEAD changed after review'));
  const refresh = vi.fn().mockResolvedValue(undefined);
  const outcome = await operationAndRefresh('handle', 'repository_run_operation', { request }, refresh, () => true, invoke as typeof native);
  expect(invoke.mock.calls).toEqual([['repository_run_operation', { handle: 'handle', request }]]);
  expect(request.expectedHead).toBe('original-head');
  expect(request.expectedOperation).toBe('reviewed');
  expect(outcome.error).toMatch(/HEAD changed/);
  expect(refresh).toHaveBeenCalledOnce();
});
it('rejects a review raced by an external mutation', async () => {
  const invoke = vi.fn().mockResolvedValueOnce(op).mockResolvedValueOnce(state).mockResolvedValueOnce({ ...op, fingerprint: 'new-state' });
  await expect(captureOperation('h', { kind: 'merge', source: 'topic', noFastForward: false }, invoke as typeof native)).rejects.toThrow(/changed during review/);
});
it('captures a local branch switch for immediate execution but refuses an active operation', async () => {
  const reads = vi.fn().mockResolvedValueOnce(op).mockResolvedValueOnce(state).mockResolvedValueOnce(op);
  const request = await captureOperation('handle', { kind: 'switchBranch', branch: 'refs/heads/topic' }, reads as typeof native);
  expect(request).toMatchObject({ action: { kind: 'switchBranch', branch: 'refs/heads/topic' }, expectedHeadRef: 'refs/heads/main', expectedOperation: 'reviewed' });
  const invoke = vi.fn().mockResolvedValue(undefined);
  await operationAndRefresh('handle', 'repository_run_operation', { request }, async () => {}, () => true, invoke as typeof native);
  expect(invoke).toHaveBeenCalledWith('repository_run_operation', { handle: 'handle', request });
  const blocked = vi.fn().mockResolvedValueOnce({ ...op, kind: 'merge' }).mockResolvedValueOnce(state).mockResolvedValueOnce({ ...op, kind: 'merge' });
  await expect(captureOperation('handle', { kind: 'switchBranch', branch: 'refs/heads/topic' }, blocked as typeof native)).rejects.toThrow(/Finish or abort/);
});
it('awaits refresh after uncertain writes and reports refresh failure for mutation blocking', async () => {
  let finish!: () => void;
  const reload = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const invoke = vi.fn().mockRejectedValue(new Error('timeout'));
  let done = false;
  const result = operationAndRefresh('h', 'repository_resolve_conflict', {}, reload, () => true, invoke as typeof native).then(value => { done = true; return value; });
  await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  expect(done).toBe(false); finish(); expect((await result).error).toBe('timeout');
  expect(await operationAndRefresh('h', 'repository_run_operation', {}, async () => { throw new Error('offline'); }, () => true, invoke as typeof native)).toEqual({ error: 'timeout', refreshError: 'offline' });
});
it('ignores stale sessions without refreshing the replacement repository', async () => {
  let current = true;
  const invoke = vi.fn(async () => { current = false; });
  const refresh = vi.fn();
  expect(await operationAndRefresh('old', 'repository_run_operation', {}, refresh, () => current, invoke as typeof native)).toEqual({ superseded: true });
  expect(refresh).not.toHaveBeenCalled();
  await operationAndRefresh('old', 'repository_run_operation', {}, refresh, () => false, invoke as typeof native);
  expect(invoke).toHaveBeenCalledOnce();
});
it('ignores the fingerprint when comparing operation content, since it also covers status and index', () => {
  expect(operationContent({ ...op, fingerprint: 'a' } as never)).toBe(operationContent({ ...op, fingerprint: 'b' } as never));
  expect(operationContent({ ...op, step: 1 } as never)).not.toBe(operationContent({ ...op, step: 2 } as never));
});
