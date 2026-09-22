import { native, errorMessage } from './native';
import type { MutationOutcome } from './workflow';

export interface RemoteWriteOutcome extends MutationOutcome { output?: string }

/** Mirrors `operationAndRefresh`'s write+refresh lifecycle (same one attempt,
 * always-refresh, "superseded wins" semantics) for the remote/stash IPC
 * contract, which additionally returns human-readable `output` text. Kept
 * alongside that lifecycle rather than inside it to avoid touching the
 * shared operation model owned by another workstream. */
export async function remoteAndRefresh(handle: string, command: string, args: Record<string, unknown>, reload: () => Promise<void>, current: () => boolean, invoke = native): Promise<RemoteWriteOutcome> {
  if (!current()) return { superseded: true };
  const outcome: RemoteWriteOutcome = {};
  try { const result = await invoke<{ output: string }>(command, { ...args, handle }); outcome.output = result.output; }
  catch (e) { outcome.error = errorMessage(e); }
  if (!current()) return { ...outcome, superseded: true };
  try { await reload(); } catch (e) { outcome.refreshError = errorMessage(e); }
  return current() ? outcome : { ...outcome, superseded: true };
}
