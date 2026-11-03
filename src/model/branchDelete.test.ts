import { describe, expect, it } from 'vitest';
import { branchBatchDeleteMessage, branchBatchDeleteRequest, branchBatchRemovedOids, branchDeleteRequest, branchDeleteTargets, folderDeleteTargets } from './branchDelete';
import type { RepositoryState } from './repository';

const state: RepositoryState = {
  session: { handle: 'h', location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'head1', headRef: 'refs/heads/main' },
  refs: [
    { name: 'main', fullName: 'refs/heads/main', commitId: 'head1', kind: 'local' },
    { name: 'feature/topic', fullName: 'refs/heads/feature/topic', commitId: 'local1', kind: 'local' },
    { name: 'origin/feature/topic', fullName: 'refs/remotes/origin/feature/topic', commitId: 'origin1', kind: 'remote' },
    { name: 'upstream/feature/topic', fullName: 'refs/remotes/upstream/feature/topic', commitId: 'other1', kind: 'remote' },
    { name: 'origin/HEAD', fullName: 'refs/remotes/origin/HEAD', commitId: 'head1', kind: 'remote' },
  ], remotes: ['origin', 'upstream'], fingerprint: 'f',
};

describe('branch deletion target resolution', () => {
  it('matches local and literal origin names while excluding other remotes and aliases', () => {
    expect(branchDeleteTargets(state, 'refs/heads/feature/topic')).toMatchObject({ branch: 'feature/topic', localOid: 'local1', originOid: 'origin1', canLocal: true, canOrigin: true, canBoth: true });
    expect(branchDeleteTargets(state, 'refs/remotes/upstream/feature/topic')).toBeNull();
    expect(branchDeleteTargets(state, 'refs/remotes/origin/HEAD')).toBeNull();
    expect(branchDeleteTargets(state, 'refs/remotes/origin/feature/topic')).toMatchObject({ branch: 'feature/topic', localOid: 'local1', originOid: 'origin1', canBoth: true });
  });
  it('captures expected state and only requested target expectations', () => {
    const target = branchDeleteTargets(state, 'refs/heads/feature/topic')!;
    expect(branchDeleteRequest(state, target, { local: true, origin: true, forceLocal: false, pushUrl: 'https://example.test/repo' })).toEqual({ branch: 'feature/topic', expectedHead: 'head1', expectedHeadRef: 'refs/heads/main', expectedLocalOid: 'local1', expectedOriginOid: 'origin1', expectedPushUrl: 'https://example.test/repo', deleteLocal: true, deleteOrigin: true, forceLocal: false });
  });
});

describe('branch folder deletion targets', () => {
  const folderState: RepositoryState = {
    ...state,
    session: { ...state.session, headRef: 'refs/heads/feat/current' },
    refs: [
      { name: 'feat/current', fullName: 'refs/heads/feat/current', commitId: 'c1', kind: 'local' },
      { name: 'feat/a', fullName: 'refs/heads/feat/a', commitId: 'a1', kind: 'local' },
      { name: 'feat/ui/b', fullName: 'refs/heads/feat/ui/b', commitId: 'b1', kind: 'local' },
      { name: 'feature/x', fullName: 'refs/heads/feature/x', commitId: 'x1', kind: 'local' },
      { name: 'origin/feat/a', fullName: 'refs/remotes/origin/feat/a', commitId: 'a2', kind: 'remote' },
      { name: 'origin/feat/remote-only', fullName: 'refs/remotes/origin/feat/remote-only', commitId: 'r2', kind: 'remote' },
      { name: 'upstream/feat/a', fullName: 'refs/remotes/upstream/feat/a', commitId: 'u2', kind: 'remote' },
    ],
  };
  it('includes nested branches, excludes sibling prefixes and skips the current branch', () => {
    expect(folderDeleteTargets(folderState, { kind: 'local', path: 'feat' }, 'local')).toEqual({
      entries: [{ branch: 'feat/a', localOid: 'a1' }, { branch: 'feat/ui/b', localOid: 'b1' }],
      skipped: [{ branch: 'feat/current', reason: 'current branch' }],
    });
  });
  it('scopes origin folders to origin and reports both-scope branches without a counterpart', () => {
    expect(folderDeleteTargets(folderState, { kind: 'origin', path: 'feat' }, 'origin').entries).toEqual([{ branch: 'feat/a', originOid: 'a2' }, { branch: 'feat/remote-only', originOid: 'r2' }]);
    const both = folderDeleteTargets(folderState, { kind: 'local', path: 'feat' }, 'both');
    expect(both.entries).toEqual([{ branch: 'feat/a', localOid: 'a1', originOid: 'a2' }]);
    expect(both.skipped).toContainEqual({ branch: 'feat/ui/b', reason: 'no origin branch' });
  });
  it('builds a batch request pinned to reviewed state and summarizes removed OIDs', () => {
    const { entries } = folderDeleteTargets(folderState, { kind: 'local', path: 'feat' }, 'both');
    const request = branchBatchDeleteRequest(folderState, entries, 'both', { pushUrl: 'https://example.test/repo', force: ['feat/a'] });
    expect(request).toEqual({ branches: [{ branch: 'feat/a', expectedLocalOid: 'a1', expectedOriginOid: 'a2' }], expectedHead: 'head1', expectedHeadRef: 'refs/heads/feat/current', expectedPushUrl: 'https://example.test/repo', deleteLocal: true, deleteOrigin: true, forceLocal: ['feat/a'] });
    const result = { branches: [{ branch: 'feat/a', local: { target: 'local' as const, status: 'deleted' as const, error: null, note: null }, origin: { target: 'origin' as const, status: 'failed' as const, error: null, note: null } }] };
    expect(branchBatchRemovedOids(request, result)).toEqual(['a1']);
    expect(branchBatchDeleteMessage(result)).toBe('local: 1 deleted\norigin: 1 failed');
  });
});
