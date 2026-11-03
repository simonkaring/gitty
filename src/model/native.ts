import { invoke } from '@tauri-apps/api/core';
import type { Commit } from './types';
import { demoInvoke } from './demoBackend';
import type { CommitSummary, DiffSpec, HistoryPage, RepositorySnapshot, RepositoryState, RepositoryStatus, StatusEntry } from './repository';
import type { OperationState } from './operations';

import { recordCommandEnd, recordCommandStart } from './activity';
import { isCancelledSearch } from './searchFlow';

let demoMode = false;
/** While on, handle-less calls (open, recents, pickers) go to the in-memory demo backend. */
export function setDemoMode(on: boolean) { demoMode = on; }
export const isDemoHandle = (handle: unknown) => typeof handle === 'string' && handle.startsWith('demo:');
const dispatch = <T,>(command: string, args: Record<string, unknown> = {}): Promise<T> =>
  ('handle' in args ? isDemoHandle(args.handle) : demoMode) ? demoInvoke(command, args) as Promise<T> : invoke<T>(command, args);
/** Session calls route by handle, so a pane closing after a mode switch still reaches the backend that owns it. */
export const native = async <T,>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
  const activityId = recordCommandStart(command, args);
  const start = performance.now();
  try {
    const result = await dispatch<T>(command, args);
    recordCommandEnd(activityId, 'success', performance.now() - start);
    return result;
  } catch (error) {
    // A superseded search is routine, not a failure worth logging.
    if (command === 'repository_search' && isCancelledSearch(error)) recordCommandEnd(activityId, 'success', performance.now() - start);
    else recordCommandEnd(activityId, 'error', performance.now() - start, errorMessage(error));
    throw error;
  }
};
export function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) return String(error.message);
  return String(error);
}
export function graphCommit(commit: CommitSummary): Commit { return { ...commit, body: '', branch: '', files: [] }; }
export const WORKING_ID = 'gitty:working-tree';
export type WorkingGroup = Extract<DiffSpec['kind'], 'staged' | 'unstaged' | 'untracked' | 'conflict'>;
export function statusGroups(entries: StatusEntry[]): Record<WorkingGroup, StatusEntry[]> {
  const groups: Record<WorkingGroup, StatusEntry[]> = { staged: [], unstaged: [], untracked: [], conflict: [] };
  for (const entry of entries) {
    if (entry.conflicted) groups.conflict.push(entry);
    else if (entry.untracked) groups.untracked.push(entry);
    else {
      if (entry.indexStatus && ![' ', '.', '?'].includes(entry.indexStatus)) groups.staged.push(entry);
      if (entry.worktreeStatus && ![' ', '.', '?'].includes(entry.worktreeStatus)) groups.unstaged.push(entry);
    }
  }
  return groups;
}
export function appendUnique(current: CommitSummary[], next: CommitSummary[]) {
  const ids = new Set(current.map(commit => commit.id));
  return [...current, ...next.filter(commit => !ids.has(commit.id))];
}

export interface NativeSnapshot {
  state: RepositoryState;
  status: RepositoryStatus;
  operation: OperationState;
  commits: CommitSummary[];
  cursor: string | null;
  generation: string;
}

/** Reject malformed/mixed walks at the IPC boundary, before calling the graph layout. */
export function validateHistory(commits: CommitSummary[]) {
  const seen = new Set<string>();
  for (const commit of commits) {
    if (seen.has(commit.id) || commit.parents.some(id => id === commit.id || seen.has(id))) {
      throw new Error('Repository returned inconsistent ancestry. Refresh to retry.');
    }
    seen.add(commit.id);
  }
}

/** One `repository_snapshot` reads state/status/operation and target-bounded history.
 * The backend pins history to the starting state's tips, rechecks state after paging,
 * and retries before publication. Unchanged state reuses the previous opaque generation. */
export async function readNativeSnapshot(handle: string, options: {
  previous?: Pick<NativeSnapshot, 'state' | 'commits' | 'cursor' | 'generation'>;
   /** Restart history, seeking known anchors up to max(400, deepest anchor index + 400). */
  forceHistory?: boolean;
  /** Automatic keep-visible candidates (selection, scroll anchor). With `previous`, only IDs that were
   * actually in the previous history are kept: an ID outside it, such as an inspector-only orphan, can never
   * be found by walking and would otherwise make every refresh read the entire history. */
  preserve?: string[];
  /** Target OIDs deleted or left unverified by the immediately preceding branch deletion. */
  excludeKeepVisible?: string[];
  /** A confirmed rewrite of the tip, `from` -> `to` (an amend). Applied to `preserve` after the filter above
   * so the old ID, which is in `previous`, is followed to the new commit instead of being searched for. Honored
   * only while the refreshed HEAD is `to`, so a hook that moved HEAD again cannot cause a full-history walk. */
  remap?: { from: string; to: string };
  current?: () => boolean;
  invoke?: typeof native;
  /** Time to produce the first history page of a fresh walk, excluding snapshot reads. */
  onFirstHistoryPage?: (millis: number) => void;
} = {}): Promise<NativeSnapshot> {
  const invoke = options.invoke ?? native;
  const check = () => { if (options.current && !options.current()) throw new Error('Repository request superseded.'); };
  const call = async <T,>(command: string, args: Record<string, unknown> = {}) => {
    check(); const result = await invoke<T>(command, { handle, ...args }); check(); return result;
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const known = options.previous && new Map(options.previous.commits.map((commit, index) => [commit.id, index]));
    const excluded = new Set(options.excludeKeepVisible ?? []);
    const preserve = (options.preserve ?? []).filter(id => id && id !== WORKING_ID && (!known || known.has(id)) && !excluded.has(id));
    const preserveLimit = Math.max(400, ...preserve.map(id => (known?.get(id) ?? 0) + 400));
    const { state: before, status, operation, history } = await call<RepositorySnapshot>('repository_snapshot', {
      history: { fingerprint: options.forceHistory ? undefined : options.previous?.state.fingerprint, previousHead: options.previous?.state.session.head, preserve, preserveLimit, remap: options.remap },
    });
    if (status.head !== before.session.head || status.headRef !== before.session.headRef) continue;
    if (options.previous && !options.forceHistory && before.fingerprint === options.previous.state.fingerprint) {
      validateHistory(options.previous.commits);
      return { state: before, status, operation, commits: options.previous.commits, cursor: options.previous.cursor, generation: options.previous.generation };
    }
    if (history) {
      validateHistory(history.commits);
      if (history.firstPageMillis !== undefined) options.onFirstHistoryPage?.(history.firstPageMillis);
      return { state: before, status, operation, commits: history.commits, cursor: history.cursor, generation: history.generation };
    }
    if (history === null) throw new Error('Repository omitted changed history. Refresh to retry.');
    // Compatibility with older/native mocked snapshot providers. Current native and
    // demo backends return the already-verified history in the snapshot itself.
    let commits: CommitSummary[] = [];
    let cursor: string | null = null;
    let generation = '';
    const remap = options.remap && before.session.head === options.remap.to ? options.remap : undefined;
    const keep = new Set(preserve
      .map(id => remap && id === remap.from ? remap.to : id));
    const count = 200;
    // Keep-visible is best effort, not explicit reveal. A reset/rebase may orphan
    // even an ID in the previous history; never scan an unbounded walk while a
    // write waits for its reconciliation refresh to finish.
    const keepVisibleBudget = preserveLimit;
    do {
      const pageStarted = performance.now();
      const page: HistoryPage = await call<HistoryPage>('repository_history', { cursor, limit: 200, query: {} });
      if (!cursor) options.onFirstHistoryPage?.(performance.now() - pageStarted);
      if (generation && page.generation !== generation) throw new Error('History generation changed during refresh. Retry.');
      if (cursor && cursor === page.cursor) throw new Error('History cursor did not advance. Refresh and retry.');
      generation = page.generation;
      commits = appendUnique(commits, page.commits); cursor = page.cursor;
      page.commits.forEach(commit => keep.delete(commit.id));
    } while (cursor && (commits.length < count || (keep.size > 0 && commits.length < keepVisibleBudget)));
    const after = await call<RepositoryState>('repository_state');
    if (before.fingerprint !== after.fingerprint || status.head !== after.session.head || status.headRef !== after.session.headRef) continue;
    validateHistory(commits);
    return { state: after, status, operation, commits, cursor, generation };
  }
  throw new Error('Repository kept changing during refresh. Showing the last consistent snapshot; retry when changes settle.');
}

export function inspectorSpec(selected: string, group: WorkingGroup, base: string, target: string, parent?: string): DiffSpec {
  if (selected === WORKING_ID) return { kind: group };
  if (base && target) return { kind: 'compare', base, target };
  return { kind: 'commit', oid: selected, ...(parent ? { parent } : {}) };
}

export function handleWindowDrag(event: React.MouseEvent<HTMLElement>) {
  if (event.button !== 0) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest('button, input, select, textarea, a, [role="tab"]')) return;
  void native('app_start_dragging').catch(() => {});
}
