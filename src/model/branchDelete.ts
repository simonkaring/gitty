import type { BranchBatchDeleteRequest, BranchBatchDeleteResult, BranchDeleteRequest, BranchDeleteResult } from './operations';
import type { RepositoryState } from './repository';

export function branchDeleteTargets(state: RepositoryState, fullName: string) {
  const ref = state.refs.find(item => item.fullName === fullName);
  if (!ref || (ref.kind !== 'local' && ref.kind !== 'remote')) return null;
  if (ref.kind === 'remote' && !ref.fullName.startsWith('refs/remotes/origin/')) return null;
  if (ref.kind === 'remote' && ref.fullName === 'refs/remotes/origin/HEAD') return null;
  const branch = ref.kind === 'local'
    ? ref.fullName.slice('refs/heads/'.length)
    : ref.fullName.slice('refs/remotes/origin/'.length);
  const localRef = state.refs.find(item => item.fullName === `refs/heads/${branch}`);
  const originRef = state.refs.find(item => item.fullName === `refs/remotes/origin/${branch}`);
  return {
    branch,
    localOid: localRef?.commitId,
    originOid: originRef?.commitId,
    canLocal: !!localRef && localRef.fullName !== state.session.headRef,
    canOrigin: !!originRef,
    canBoth: !!localRef && !!originRef && localRef.fullName !== state.session.headRef,
  };
}

export function branchDeleteRequest(state: RepositoryState, target: ReturnType<typeof branchDeleteTargets>, options: { local: boolean; origin: boolean; forceLocal: boolean; pushUrl?: string }): BranchDeleteRequest {
  if (!target) throw new Error('Branch target is no longer available. Refresh and review again.');
  return { branch: target.branch, expectedHead: state.session.head, expectedHeadRef: state.session.headRef, ...(options.local && target.localOid ? { expectedLocalOid: target.localOid } : {}), ...(options.origin && target.originOid ? { expectedOriginOid: target.originOid, expectedPushUrl: options.pushUrl } : {}), deleteLocal: options.local, deleteOrigin: options.origin, forceLocal: options.forceLocal };
}

export function branchDeleteMessage(result: BranchDeleteResult) {
  return [result.local, result.origin].filter(Boolean).map(item => `${item!.target}: ${item!.status}${item!.error ? ` — ${item!.error.message}` : ''}${item!.note ? ` (${item!.note})` : ''}`).join('\n');
}

export type BranchDeleteScope = 'local' | 'origin' | 'both';

/** Must match `MAX_BATCH_BRANCHES` in `src-tauri/src/branch_delete.rs`. */
export const MAX_BATCH_BRANCHES = 500;

/** A sidebar branch folder: `path` is the slash-joined prefix without `refs/heads/` or `refs/remotes/origin/`. */
export interface BranchFolder { kind: 'local' | 'origin'; path: string }
export interface FolderDeleteEntry { branch: string; localOid?: string; originOid?: string }
export interface FolderDeleteTargets { entries: FolderDeleteEntry[]; skipped: Array<{ branch: string; reason: string }> }

export function folderLabel(folder: BranchFolder) {
  return `${folder.kind === 'origin' ? 'origin/' : ''}${folder.path}/`;
}

/** Branches under a folder (including nested folders) that a batch deletion of `scope` would target. */
export function folderDeleteTargets(state: RepositoryState, folder: BranchFolder, scope: BranchDeleteScope): FolderDeleteTargets {
  const source = folder.kind === 'local' ? 'refs/heads/' : 'refs/remotes/origin/';
  const prefix = `${source}${folder.path}/`;
  const oids = (base: string) => new Map(state.refs.filter(ref => ref.fullName.startsWith(base) && ref.fullName !== 'refs/remotes/origin/HEAD').map(ref => [ref.fullName.slice(base.length), ref.commitId]));
  const local = oids('refs/heads/');
  const origin = oids('refs/remotes/origin/');
  const names = [...(folder.kind === 'local' ? local : origin).keys()].filter(name => `${source}${name}`.startsWith(prefix)).sort();
  const entries: FolderDeleteEntry[] = [];
  const skipped: FolderDeleteTargets['skipped'] = [];
  for (const branch of names) {
    const localOid = local.get(branch);
    const originOid = origin.get(branch);
    if (scope !== 'origin' && `refs/heads/${branch}` === state.session.headRef) { skipped.push({ branch, reason: 'current branch' }); continue; }
    if (scope === 'local' && !localOid) continue;
    if (scope === 'origin' && !originOid) continue;
    if (scope === 'both' && (!localOid || !originOid)) { skipped.push({ branch, reason: localOid ? 'no origin branch' : 'no local branch' }); continue; }
    entries.push({ branch, ...(scope !== 'origin' ? { localOid } : {}), ...(scope !== 'local' ? { originOid } : {}) });
  }
  return { entries, skipped };
}

export function branchBatchDeleteRequest(state: RepositoryState, entries: FolderDeleteEntry[], scope: BranchDeleteScope, options: { pushUrl?: string; force?: string[] }): BranchBatchDeleteRequest {
  const deleteLocal = scope !== 'origin';
  const deleteOrigin = scope !== 'local';
  return {
    branches: entries.map(entry => ({ branch: entry.branch, ...(deleteLocal && entry.localOid ? { expectedLocalOid: entry.localOid } : {}), ...(deleteOrigin && entry.originOid ? { expectedOriginOid: entry.originOid } : {}) })),
    expectedHead: state.session.head,
    expectedHeadRef: state.session.headRef,
    ...(deleteOrigin && options.pushUrl ? { expectedPushUrl: options.pushUrl } : {}),
    deleteLocal,
    deleteOrigin,
    forceLocal: options.force ?? [],
  };
}

export function branchBatchDeleteMessage(result: BranchBatchDeleteResult) {
  const summarize = (target: 'local' | 'origin') => {
    const counts = new Map<string, number>();
    for (const item of result.branches) { const status = item[target]?.status; if (status) counts.set(status, (counts.get(status) ?? 0) + 1); }
    return counts.size ? `${target}: ${[...counts].map(([status, count]) => `${count} ${status}`).join(', ')}` : '';
  };
  return [summarize('local'), summarize('origin')].filter(Boolean).join('\n');
}

/** OIDs that a batch deletion removed (or may have removed). */
export function branchBatchRemovedOids(request: BranchBatchDeleteRequest, result: BranchBatchDeleteResult) {
  const gone = (status?: string) => status === 'deleted' || status === 'unverified';
  return result.branches.flatMap(item => {
    const reviewed = request.branches.find(entry => entry.branch === item.branch);
    return [gone(item.local?.status) ? reviewed?.expectedLocalOid : undefined, gone(item.origin?.status) ? reviewed?.expectedOriginOid : undefined];
  }).filter((oid): oid is string => !!oid);
}
