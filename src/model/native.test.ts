import { describe, expect, it } from 'vitest';
import { appendUnique, graphCommit, statusGroups } from './native';
import type { CommitSummary, StatusEntry } from './repository';

describe('native history adaptation', () => {
  const commit: CommitSummary = { id: 'a', parents: ['b', 'c'], subject: 'merge', author: 'A', email: 'a@example.test', timestamp: 12 };
  it('preserves original merge ancestry without eager content', () => {
    expect(graphCommit(commit)).toEqual({ ...commit, files: [], body: '', branch: '' });
    expect(commit).not.toHaveProperty('files');
  });
  it('deduplicates overlapping history pages without reordering ancestry', () => {
    expect(appendUnique([commit], [commit, { ...commit, id: 'b' }]).map(item => item.id)).toEqual(['a', 'b']);
  });
});
describe('working status categories', () => {
  const entry: StatusEntry = { path: 'both.ts', oldPath: null, indexStatus: 'M', worktreeStatus: 'M', conflicted: false, untracked: false };
  it('keeps a file in both staged and unstaged comparisons', () => {
    const groups = statusGroups([entry]);
    expect(groups.staged).toEqual([entry]); expect(groups.unstaged).toEqual([entry]);
  });
  it('separates conflicts and untracked paths from ordinary modifications', () => {
    const conflict = { ...entry, conflicted: true };
    const untracked = { ...entry, untracked: true };
    const groups = statusGroups([conflict, untracked, { ...entry, indexStatus: '.', worktreeStatus: ' ' }]);
    expect(groups.conflict).toEqual([conflict]); expect(groups.untracked).toEqual([untracked]);
    expect(groups.staged).toEqual([]); expect(groups.unstaged).toEqual([]);
  });
});
