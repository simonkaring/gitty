/** Remote sync and stash types, agreed as an IPC contract with the Rust
 * backend agent. Reads (`repository_sync_info`, `repository_stashes`) are
 * local-only: ahead/behind counts come from locally known remote-tracking
 * refs and never touch the network. Only `repository_remote_action` (fetch,
 * pull, push) performs network I/O, and only when explicitly requested. */
export interface SyncInfo { branch: string | null; upstream: string | null; ahead: number | null; behind: number | null; remotes: string[] }
export type PullMode = 'ffOnly' | 'merge' | 'rebase';
export type RemoteActionRequest =
  | { kind: 'fetch'; remote?: string; branch?: string }
  | { kind: 'pull'; remote?: string; branch?: string; pullMode?: PullMode }
  | { kind: 'push'; remote?: string; branch?: string; setUpstream?: boolean };
export interface RemoteActionResult { output: string }
export interface StashEntry { oid: string; selector: string; message: string }
export type StashActionRequest =
  | { kind: 'save'; message?: string; includeUntracked?: boolean }
  | { kind: 'apply' | 'pop' | 'drop'; oid: string };
export interface StashActionResult { output: string }

/* Tauri commands (camelCase arguments):
 * repository_sync_info({handle}) -> SyncInfo
 * repository_remote_action({handle, action: RemoteActionRequest}) -> RemoteActionResult
 * repository_stashes({handle}) -> StashEntry[]
 * repository_stash_action({handle, action: StashActionRequest}) -> StashActionResult
 */

export const PULL_MODE_LABELS: Record<PullMode, string> = { ffOnly: 'Pull (fast-forward only)', merge: 'Pull (merge)', rebase: 'Pull (rebase)' };
export const DEFAULT_PULL_MODE: PullMode = 'ffOnly';

export function needsPublish(sync: SyncInfo | null): boolean {
  return !!sync?.branch && !sync.upstream;
}

/** A short, human-readable summary for the toolbar's branch/sync badge. */
export function syncSummary(sync: SyncInfo | null): string {
  if (!sync) return '';
  if (!sync.branch) return 'Detached HEAD';
  if (!sync.upstream) return `${sync.branch} · no upstream`;
  if (sync.ahead === null || sync.behind === null) return `${sync.branch} → ${sync.upstream} · counts unavailable`;
  const parts: string[] = [];
  if (sync.ahead) parts.push(`↑${sync.ahead}`);
  if (sync.behind) parts.push(`↓${sync.behind}`);
  return `${sync.branch} → ${sync.upstream}${parts.length ? ` (${parts.join(' ')})` : ' · up to date'}`;
}

/** Prefer a remote the caller already knows about (e.g. the upstream's
 * remote), then `origin`, then whatever is first; never guess when there are
 * no remotes at all. */
export function defaultRemote(remotes: string[], preferred?: string | null): string {
  if (preferred && remotes.includes(preferred)) return preferred;
  if (remotes.includes('origin')) return 'origin';
  return remotes[0] ?? '';
}

function stashIndex(selector: string): number {
  const match = /stash@\{(\d+)\}/.exec(selector);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}
/** Trust the numeric `stash@{n}` selector (n=0 is newest) rather than array
 * order, so a backend returning stashes in any order still displays newest
 * first. */
export function sortStashes(entries: StashEntry[]): StashEntry[] {
  return [...entries].sort((a, b) => stashIndex(a.selector) - stashIndex(b.selector));
}

export function describeRemoteAction(action: RemoteActionRequest): string {
  if (action.kind === 'fetch') return `Fetch${action.remote ? ` ${action.remote}` : ''}`;
  if (action.kind === 'pull') return PULL_MODE_LABELS[action.pullMode ?? DEFAULT_PULL_MODE];
  return `Push${action.remote && action.branch ? ` ${action.remote}/${action.branch}` : ''}`;
}
export function describeStashAction(action: StashActionRequest): string {
  if (action.kind === 'save') return 'Stash changes';
  if (action.kind === 'apply') return 'Apply stash';
  if (action.kind === 'pop') return 'Pop stash';
  return 'Drop stash';
}
