import { native } from './native';
import { attemptAndRefresh, type MutationOutcome } from './workflow';

export interface RemoteWriteOutcome extends MutationOutcome { output?: string }

/** The remote/stash IPC contract also returns human-readable `output` text, which
 * `attemptAndRefresh` records before the reload runs. */
export async function remoteAndRefresh(handle: string, command: string, args: Record<string, unknown>, reload: () => Promise<void>, current: () => boolean, invoke = native): Promise<RemoteWriteOutcome> {
  return attemptAndRefresh<{ output: string }, RemoteWriteOutcome>(
    () => invoke<{ output: string }>(command, { ...args, handle }),
    (outcome, result) => { outcome.output = result.output; },
    () => reload(),
    current,
  );
}
