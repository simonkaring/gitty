import { invoke } from '@tauri-apps/api/core';
import type { Commit } from './types';
import { demoInvoke } from './demoBackend';
import type { CommitSummary, DiffSpec, HistoryPage, RepositoryState, RepositoryStatus, StatusEntry } from './repository';

let demoMode = false;
/** While on, handle-less calls (open, recents, pickers) go to the in-memory demo backend. */
export function setDemoMode(on: boolean) { demoMode = on; }
export const isDemoHandle = (handle: unknown) => typeof handle === 'string' && handle.startsWith('demo:');
/** Session calls route by handle, so a pane closing after a mode switch still reaches the backend that owns it. */
export const native = <T,>(command: string, args: Record<string, unknown> = {}): Promise<T> =>
  ('handle' in args ? isDemoHandle(args.handle) : demoMode) ? demoInvoke(command, args) as Promise<T> : invoke<T>(command, args);
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

/** A generation is opaque, not a state fingerprint. Bracket its creation with live
 * state reads and only publish the entire snapshot after HEAD/refs agree. */
export async function readNativeSnapshot(handle: string, options: {
  previous?: Pick<NativeSnapshot, 'state' | 'commits' | 'cursor' | 'generation'>;
  preserve?: string[];
  current?: () => boolean;
  invoke?: typeof native;
} = {}): Promise<NativeSnapshot> {
  const invoke = options.invoke ?? native;
  const check = () => { if (options.current && !options.current()) throw new Error('Repository request superseded.'); };
  const call = async <T,>(command: string, args: Record<string, unknown> = {}) => {
    check(); const result = await invoke<T>(command, { handle, ...args }); check(); return result;
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await call<RepositoryState>('repository_state');
    const status = before.session.bare
      ? { entries: [], head: before.session.head, headRef: before.session.headRef, fingerprint: 'bare' }
      : await call<RepositoryStatus>('repository_status');
    if (status.head !== before.session.head || status.headRef !== before.session.headRef) continue;
    let commits = options.previous?.commits ?? [];
    let cursor = options.previous?.cursor ?? null;
    let generation = options.previous?.generation ?? '';
    if (!options.previous || before.fingerprint !== options.previous.state.fingerprint) {
      commits = []; cursor = null; generation = '';
      const keep = new Set((options.preserve ?? []).filter(id => id && id !== WORKING_ID));
      const count = Math.max(200, options.previous?.commits.length ?? 0);
      do {
        const page: HistoryPage = await call<HistoryPage>('repository_history', { cursor, limit: 200, query: {} });
        if (generation && page.generation !== generation) throw new Error('History generation changed during refresh. Retry.');
        if (cursor && cursor === page.cursor) throw new Error('History cursor did not advance. Refresh and retry.');
        generation = page.generation;
        commits = appendUnique(commits, page.commits); cursor = page.cursor;
        page.commits.forEach(commit => keep.delete(commit.id));
      } while (cursor && (commits.length < count || keep.size > 0));
    }
    const after = await call<RepositoryState>('repository_state');
    if (before.fingerprint !== after.fingerprint || status.head !== after.session.head || status.headRef !== after.session.headRef) continue;
    validateHistory(commits);
    return { state: after, status, commits, cursor, generation };
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
