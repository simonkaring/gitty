import { describe, expect, it, vi } from 'vitest';
import { appendHistoryPage, graphCommit, hostLive, setDemoMode, statusGroups } from './native';
import type { CommitSummary, StatusEntry } from './repository';

describe('native history adaptation', () => {
  const commit: CommitSummary = { id: 'a', parents: ['b', 'c'], subject: 'merge', author: 'A', email: 'a@example.test', timestamp: 12 };
  it('preserves original merge ancestry without eager content', () => {
    expect(graphCommit(commit)).toEqual({ ...commit, files: [], body: '', branch: '' });
    expect(commit).not.toHaveProperty('files');
  });
  it('deduplicates overlapping history pages without reordering ancestry', () => {
    const loaded = new Set(['a']);
    expect(appendHistoryPage([commit], [commit, { ...commit, id: 'b', parents: ['c'] }], loaded).map(item => item.id)).toEqual(['a', 'b']);
    expect([...loaded]).toEqual(['a', 'b']);
  });
  it('rejects duplicates, self-parenting, and ancestry pointing back into the loaded prefix or page without polluting the index', () => {
    const loaded = new Set(['a']);
    const b = { ...commit, id: 'b', parents: [] };
    for (const invalid of [b, { ...b, id: 'c', parents: ['a'] }, { ...b, id: 'c', parents: ['b'] }, { ...b, id: 'c', parents: ['c'] }]) {
      expect(() => appendHistoryPage([commit], [b, invalid], loaded)).toThrow('inconsistent ancestry');
      expect([...loaded]).toEqual(['a']);
    }
    expect(appendHistoryPage([commit], [b], loaded)).toEqual([commit, b]);
  });
  it('reuses row adaptations without confusing normal and stash ancestry', () => {
    const normal = graphCommit(commit);
    const stash = graphCommit(commit, true);
    expect(graphCommit(commit)).toBe(normal);
    expect(graphCommit(commit, true)).toBe(stash);
    expect(stash.parents).toEqual(['b']);
    expect(normal.parents).toEqual(['b', 'c']);
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
describe('host liveness (events and cloning)', () => {
  it('is off for the synthetic demo and on for the desktop', () => {
    setDemoMode(true);
    expect(hostLive()).toBe(false);
    setDemoMode(false);
    expect(hostLive()).toBe(true);
  });
  it('stays on in the real-backend test host even while demo mode is set', async () => {
    vi.stubEnv('VITE_GITTY_TEST_MODE', '1');
    vi.resetModules();
    const fresh = await import('./native');
    fresh.setDemoMode(true);
    expect(fresh.hostLive()).toBe(true);
    vi.unstubAllEnvs();
    vi.resetModules();
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

