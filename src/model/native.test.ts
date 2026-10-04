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

describe('native dispatcher activity logging', () => {
  it('logs demo/native calls and records success and error outcomes', async () => {
    const { native, setDemoMode } = await import('./native');
    const { getActivityLog, clearActivityLog } = await import('./activity');
    setDemoMode(true);
    clearActivityLog();

    await native('repository_open', { location: { kind: 'native', path: '~/Developer/gitty' } });
    clearActivityLog();
    const stage = await native('repository_stage', { handle: 'demo:gitty', paths: ['README.md'] });
    expect(stage).toBeUndefined();

    const logAfterSuccess = getActivityLog();
    expect(logAfterSuccess).toHaveLength(1);
    expect(logAfterSuccess[0]).toMatchObject({
      command: 'repository_stage',
      status: 'success',
    });
    expect(typeof logAfterSuccess[0].durationMs).toBe('number');

    await native('repository_state', { handle: 'demo:gitty' });
    expect(getActivityLog()).toHaveLength(1);

    await expect(native('unknown_command', { handle: 'demo:repo' })).rejects.toThrow();
    const logAfterError = getActivityLog();
    expect(logAfterError).toHaveLength(2);
    expect(logAfterError[1].status).toBe('error');
    expect(logAfterError[1].error).toBeDefined();
  });
});

