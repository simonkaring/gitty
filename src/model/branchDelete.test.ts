import { describe, expect, it } from 'vitest';
import { branchDeleteRequest, branchDeleteTargets } from './branchDelete';
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
