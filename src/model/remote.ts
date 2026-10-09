/** Remote sync and stash types, agreed as an IPC contract with the Rust
 * backend agent. Reads (`repository_sync_info`, `repository_stashes`) are
 * local-only: ahead/behind counts come from locally known remote-tracking
 * refs and never touch the network. Only `repository_remote_action` (fetch,
 * pull, push, backgroundFetch) performs network I/O. */
export interface SyncInfo { branch: string | null; upstream: string | null; ahead: number | null; behind: number | null; remotes: string[] }
export type PullMode = 'ffOnly' | 'merge' | 'rebase';
export type RemoteActionRequest =
  | { kind: 'fetch'; remote?: string; branch?: string }
  | { kind: 'backgroundFetch'; remote?: string }
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
  if (action.kind === 'backgroundFetch') return 'Background fetch';
  if (action.kind === 'pull') return PULL_MODE_LABELS[action.pullMode ?? DEFAULT_PULL_MODE];
  return `Push${action.remote && action.branch ? ` ${action.remote}/${action.branch}` : ''}`;
}
export function describeStashAction(action: StashActionRequest): string {
  if (action.kind === 'save') return 'Stash changes';
  if (action.kind === 'apply') return 'Apply stash';
  if (action.kind === 'pop') return 'Pop stash';
  return 'Drop stash';
}

/** Success notices use the requested action, not Git's terminal report. Only
 * recognize known no-op results; never guess a remote from an upstream label. */
export function remoteSuccessMessage(action: RemoteActionRequest, output: string, currentBranch?: string | null): string {
  if (action.kind === 'fetch' || action.kind === 'backgroundFetch') {
    return action.remote ? `Fetched updates from ${action.remote}.` : 'Fetched remote updates.';
  }
  if (action.kind === 'push') {
    const branch = action.branch ?? currentBranch;
    if (!action.setUpstream && (/^=\t[^\n]*\t\[up to date\]\s*$/m.test(output) || /^Everything up[- ]to[- ]date\.?\s*$/im.test(output))) {
      return 'Already up to date. Nothing to push.';
    }
    const verb = action.setUpstream ? 'Published' : 'Pushed';
    return `${verb}${branch ? ` ${branch}` : ' changes'}${action.remote ? ` to ${action.remote}` : ''}.`;
  }
  if (/^Already up[- ]to[- ]date\.?\s*$/im.test(output) || /^Current branch .+ is up to date\.\s*$/m.test(output)) {
    return 'Already up to date. Nothing to pull.';
  }
  return `Pulled updates${action.remote ? ` from ${action.remote}${action.branch ? `/${action.branch}` : ''}` : ''}.`;
}

export function stashSuccessMessage(action: StashActionRequest, output: string): string {
  if (action.kind === 'save') {
    return /^No local changes to save\s*$/m.test(output) ? 'No changes to stash.' : 'Saved working changes to a stash.';
  }
  if (action.kind === 'apply') return 'Applied stash. The saved stash is still available.';
  if (action.kind === 'pop') return 'Applied stash and removed it from saved stashes.';
  return 'Deleted saved stash.';
}
