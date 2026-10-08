import type { BranchDeleteRequest, BranchDeleteResult } from './operations';
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
