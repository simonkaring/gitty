import { describe, expect, it } from 'vitest';
import { buildRefTree } from './NativeSidebar';
import type { RepositoryState } from '../model/repository';

const refs: RepositoryState['refs'] = [
  { name: 'feature/nested/one', fullName: 'refs/heads/feature/nested/one', commitId: 'a', kind: 'local' },
  { name: 'feature/two', fullName: 'refs/heads/feature/two', commitId: 'b', kind: 'local' },
  { name: 'v1/release', fullName: 'refs/tags/v1/release', commitId: 'c', kind: 'tag' },
];

describe('sidebar branch folders', () => {
  it('preserves slash-separated branch identity and keeps tags flat', () => {
    const branches = buildRefTree(refs.filter(ref => ref.kind === 'local'), 'refs/heads/');
    expect([...branches.folders.keys()]).toEqual(['feature']);
    expect([...branches.folders.get('feature')!.folders.keys()]).toEqual(['nested']);
    expect(branches.folders.get('feature')!.refs[0].name).toBe('feature/two');
    const tags = buildRefTree(refs.filter(ref => ref.kind === 'tag'), 'refs/tags/');
    expect(tags.folders.size).toBe(0);
    expect(tags.refs[0].name).toBe('v1/release');
  });
  it('treats a slash-containing configured remote as one folder and excludes origin HEAD alias', () => {
    const remoteRefs: RepositoryState['refs'] = [
      { name: 'foo/bar/feature/topic', fullName: 'refs/remotes/foo/bar/feature/topic', commitId: 'a', kind: 'remote' },
      { name: 'origin/HEAD', fullName: 'refs/remotes/origin/HEAD', commitId: 'b', kind: 'remote' },
    ];
    const tree = buildRefTree(remoteRefs, 'refs/remotes/', ['foo', 'foo/bar', 'origin']);
    expect([...tree.folders.keys()]).toEqual(['foo/bar']);
    expect([...tree.folders.get('foo/bar')!.folders.keys()]).toEqual(['feature']);
    expect(tree.folders.get('foo/bar')!.folders.get('feature')!.refs[0].fullName).toBe('refs/remotes/foo/bar/feature/topic');
    expect(tree.refs).toEqual([]);
  });
});
