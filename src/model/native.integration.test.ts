import { describe, expect, it, vi } from 'vitest';
import { inspectorSpec, native, readNativeSnapshot, WORKING_ID, type NativeSnapshot } from './native';
import type { CommitSummary, HistoryPage, RepositoryState, RepositoryStatus } from './repository';

const commit = (id: string, parents: string[] = []): CommitSummary => ({ id, parents, subject: id, author: 'Test', email: '', timestamp: 1 });
const state = (head = 'a', bare = false): RepositoryState => ({ session: { handle: 'session', location: { kind: 'native', path: '/repo' }, root: '/repo', name: 'repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare, head, headRef: 'refs/heads/main' }, refs: [], remotes: [], fingerprint: head });
const status = (head = 'a'): RepositoryStatus => ({ entries: [], head, headRef: 'refs/heads/main', fingerprint: head });
const page = (commits: CommitSummary[], cursor: string | null = null, generation = 'walk'): HistoryPage => ({ commits, cursor, generation, shallow: false });
function scripted(steps: [string, unknown][]) {
  const invoke = vi.fn(async (command: string) => {
    const step = steps.shift();
    expect(command).toBe(step?.[0]);
    return step?.[1];
  });
  return { invoke: invoke as typeof native, calls: invoke, steps };
}
const previous: NativeSnapshot = { state: state(), status: status(), commits: [commit('a')], cursor: null, generation: 'old-walk' };

describe('native snapshot IPC integration', () => {
  it('retries a HEAD change between state and status before starting a walk', async () => {
    const mock = scripted([
      ['repository_state', state('a')], ['repository_status', status('b')],
      ['repository_state', state('b')], ['repository_status', status('b')],
      ['repository_history', page([commit('b')])], ['repository_state', state('b')],
    ]);
    const result = await readNativeSnapshot('session', mock);
    expect(result.state.session.head).toBe(result.status.head);
    expect(result.commits[0].id).toBe('b'); expect(mock.steps).toHaveLength(0);
  });
  it('discards a complete candidate when refs move while history is being fetched', async () => {
    const mock = scripted([
      ['repository_state', state('a')], ['repository_status', status('a')],
      ['repository_history', page([commit('a')])], ['repository_state', state('b')],
      ['repository_state', state('b')], ['repository_status', status('b')],
      ['repository_history', page([commit('b')], null, 'new-walk')], ['repository_state', state('b')],
    ]);
    const result = await readNativeSnapshot('session', mock);
    expect(result.generation).toBe('new-walk'); expect(result.cursor).toBeNull();
    expect(result.commits.map(c => c.id)).toEqual(['b']);
  });
  it('loads beyond the old prefix to preserve selection and viewport after more than a page of new commits', async () => {
    const newest = Array.from({ length: 200 }, (_, i) => commit(`new-${i}`, [i === 199 ? 'a' : `new-${i + 1}`]));
    const mock = scripted([
      ['repository_state', state('new-0')], ['repository_status', status('new-0')],
      ['repository_history', page(newest, 'page-2')],
      ['repository_history', page([commit('a', ['anchor']), commit('anchor')])],
      ['repository_state', state('new-0')],
    ]);
    const result = await readNativeSnapshot('session', { ...mock, previous, preserve: ['a', 'anchor'] });
    expect(result.commits).toHaveLength(202);
    expect(mock.calls.mock.calls.filter(([command]) => command === 'repository_history')).toHaveLength(2);
  });
  it('finishes the walk when a retained selection becomes unreachable without adding fake ancestry', async () => {
    const mock = scripted([
      ['repository_state', state('b')], ['repository_status', status('b')],
      ['repository_history', page([commit('b')])], ['repository_state', state('b')],
    ]);
    const result = await readNativeSnapshot('session', { ...mock, previous, preserve: ['a'] });
    expect(result.cursor).toBeNull(); expect(result.commits.map(c => c.id)).toEqual(['b']);
    expect(previous.commits.map(c => c.id)).toEqual(['a']);
  });
  it('reuses the pinned walk on unchanged polls without allocating generations', async () => {
    const mock = scripted([['repository_state', state()], ['repository_status', status()], ['repository_state', state()]]);
    const result = await readNativeSnapshot('session', { ...mock, previous });
    expect(result.commits).toBe(previous.commits); expect(result.generation).toBe('old-walk');
    expect(mock.steps).toHaveLength(0);
  });
  it('does not call the worktree-only status command for a bare repository', async () => {
    const mock = scripted([['repository_state', state('a', true)], ['repository_history', page([commit('a')])], ['repository_state', state('a', true)]]);
    const result = await readNativeSnapshot('session', mock);
    expect(result.status.entries).toEqual([]); expect(mock.steps).toHaveLength(0);
  });
  it('rejects malformed ordering before it reaches graph layout', async () => {
    const mock = scripted([['repository_state', state()], ['repository_status', status()], ['repository_history', page([commit('a'), commit('b', ['a'])])], ['repository_state', state()]]);
    await expect(readNativeSnapshot('session', mock)).rejects.toThrow('inconsistent ancestry');
  });
  it('bounds retries while HEAD keeps moving', async () => {
    const mock = scripted(Array.from({ length: 3 }, (): [string, unknown][] => [['repository_state', state('a')], ['repository_status', status('b')]]).flat());
    await expect(readNativeSnapshot('session', mock)).rejects.toThrow('kept changing');
    expect(mock.calls).toHaveBeenCalledTimes(6);
  });
  it('stops a superseded asynchronous read before issuing another IPC request', async () => {
    let resolve!: (value: RepositoryState) => void;
    let current = true;
    const invoke = vi.fn(() => new Promise<RepositoryState>(done => { resolve = done; }));
    const result = readNativeSnapshot('session', { invoke: invoke as typeof native, current: () => current });
    current = false; resolve(state());
    await expect(result).rejects.toThrow('superseded'); expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe('inspector comparison modes', () => {
  it('working categories take precedence over a saved commit comparison', () => {
    expect(inspectorSpec(WORKING_ID, 'staged', 'base', 'target')).toEqual({ kind: 'staged' });
    expect(inspectorSpec(WORKING_ID, 'unstaged', 'base', 'target')).toEqual({ kind: 'unstaged' });
    expect(inspectorSpec('commit', 'unstaged', 'base', 'target')).toEqual({ kind: 'compare', base: 'base', target: 'target' });
  });
});
