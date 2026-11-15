import { native } from './native';
import type { GitAction, OperationRequest, OperationResult, OperationState } from './operations';
import type { RepositoryState } from './repository';
import { actionReason } from './operationUi';
import { attemptAndRefresh, type MutationOutcome } from './workflow';

/** Operation state without its fingerprint, which also covers status and index and so moves on every stage. */
export const operationContent = (operation: OperationState) => JSON.stringify({ ...operation, fingerprint: '' });

/** Capture once at review. Execute must pass this request verbatim. */
export async function captureOperation(handle: string, action: GitAction, invoke = native): Promise<OperationRequest> {
  const before = await invoke<OperationState>('repository_operation_state', { handle });
  const fresh = await invoke<RepositoryState>('repository_state', { handle });
  const after = await invoke<OperationState>('repository_operation_state', { handle });
  if (before.fingerprint !== after.fingerprint) throw new Error('Repository changed during review. Review again.');
  const blocked = actionReason(action, fresh.session, after);
  if (blocked) throw new Error(blocked);
  return { action: structuredClone(action), expectedHead: fresh.session.head, expectedHeadRef: fresh.session.headRef, expectedOperation: after.fingerprint };
}

/** Caller holds the shared mutation lock through the awaited reload, including
 * when a write failed or timed out: its outcome may be uncertain. */
export async function operationAndRefresh(handle: string, command: string, args: Record<string, unknown>, reload: () => Promise<void>, current: () => boolean, invoke = native): Promise<MutationOutcome & { notice?: string }> {
  return attemptAndRefresh<OperationResult | undefined, MutationOutcome & { notice?: string }>(
    () => invoke<OperationResult | undefined>(command, { ...args, handle }),
    (outcome, result) => { if (result?.notice) outcome.notice = result.notice; },
    () => reload(),
    current,
  );
}
