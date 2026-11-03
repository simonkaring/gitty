import { describe, expect, it, vi } from 'vitest';
import { inspectorSpec, native, readNativeSnapshot, WORKING_ID, type NativeSnapshot } from './native';
import type { OperationState } from './operations';
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
const operation: OperationState = { kind: 'none', label: '', current: null, incoming: null, step: null, total: null, conflicts: [], canContinue: false, canSkip: false, fingerprint: 'op' };
const snap = (head = 'a', bare = false) => ({ state: state(head, bare), status: status(head), operation, history: page([commit(head)]) });
const previous: NativeSnapshot = { state: state(), status: status(), operation, commits: [commit('a')], cursor: null, generation: 'old-walk' };

describe('native snapshot IPC integration', () => {
  it('retries mismatched snapshot HEAD before publishing fresh or reused history', async () => {
    for (const reuse of [false, true]) {
      const mock = scripted([
        ['repository_snapshot', { ...snap(), status: status('raced') }],
        ['repository_snapshot', snap()],
      ]);
      const result = await readNativeSnapshot('session', { ...mock, previous: reuse ? previous : undefined });
      expect(result.state.session.head).toBe(result.status.head);
      expect(mock.calls).toHaveBeenCalledTimes(2);
    }
  });
  it('bounds retries for persistently mismatched snapshot HEAD', async () => {
    const invoke = vi.fn().mockResolvedValue({ ...snap(), status: status('raced') });
    await expect(readNativeSnapshot('session', { invoke })).rejects.toThrow('Repository kept changing');
    expect(invoke).toHaveBeenCalledTimes(3);
  });
  it('publishes backend-verified history without another IPC or state read', async () => {
    const commits = [commit('feature'), commit('a')];
    const mock = scripted([['repository_snapshot', { ...snap(), history: page(commits, 'older') }]]);
    const result = await readNativeSnapshot('session', mock);
    expect(result.commits).toBe(commits);
    expect(result.cursor).toBe('older');
    expect(mock.calls).toHaveBeenCalledExactlyOnceWith('repository_snapshot', { handle: 'session', history: { fingerprint: undefined, previousHead: undefined, preserve: [], preserveLimit: 400, remap: undefined } });
  });
  it('requests selection/anchor depth, not the entire previously loaded prefix', async () => {
    const deep = { ...previous, commits: Array.from({ length: 5000 }, (_, i) => commit(`c${i}`)) };
    const mock = scripted([['repository_snapshot', snap('new')]]);
    await readNativeSnapshot('session', { ...mock, previous: deep, preserve: ['c0', 'c12', 'orphan', WORKING_ID] });
    expect(mock.calls).toHaveBeenCalledWith('repository_snapshot', expect.objectContaining({ history: expect.objectContaining({ preserve: ['c0', 'c12'], preserveLimit: 412 }) }));
  });
  it('filters deleted and orphan IDs before handing remapping to the backend', async () => {
    const deep = { ...previous, commits: Array.from({ length: 5000 }, (_, i) => commit(`c${i}`)) };
    const mock = scripted([['repository_snapshot', snap('new')]]);
    const remap = { from: 'c4500', to: 'new' };
    await readNativeSnapshot('session', { ...mock, previous: deep, preserve: ['c4500', 'c1', 'orphan'], excludeKeepVisible: ['c1'], remap });
    expect(mock.calls).toHaveBeenCalledWith('repository_snapshot', expect.objectContaining({ history: expect.objectContaining({ preserve: ['c4500'], preserveLimit: 4900, remap }) }));
  });
  it('hands a confirmed amend to the snapshot without extra history reads', async () => {
    const mock = scripted([['repository_snapshot', { ...snap('new'), history: page([commit('new')], 'more', 'new-walk') }]]);
    const remap = { from: 'a', to: 'new' };
    const result = await readNativeSnapshot('session', { ...mock, previous, preserve: ['a'], remap });
    expect(mock.calls).toHaveBeenCalledExactlyOnceWith('repository_snapshot', { handle: 'session', history: { fingerprint: 'a', previousHead: 'a', preserve: ['a'], preserveLimit: 400, remap } });
    expect(result.generation).toBe('new-walk');
    expect(result.cursor).toBe('more');
  });
  it('reuses the pinned walk on unchanged polls with a single IPC call', async () => {
    const mock = scripted([['repository_snapshot', { ...snap(), history: null }]]);
    const result = await readNativeSnapshot('session', { ...mock, previous });
    expect(result.commits).toBe(previous.commits);
    expect(result.generation).toBe('old-walk');
    expect(mock.calls).toHaveBeenCalledOnce();
  });
  it('accepts a bare snapshot with empty working status', async () => {
    const mock = scripted([['repository_snapshot', snap('a', true)]]);
    expect((await readNativeSnapshot('session', mock)).status.entries).toEqual([]);
    expect(mock.calls).toHaveBeenCalledOnce();
  });
  it.each([null, undefined])('rejects missing changed history (%s) instead of using a legacy walk', async history => {
    const mock = scripted([['repository_snapshot', { ...snap('new'), history }]]);
    await expect(readNativeSnapshot('session', { ...mock, previous })).rejects.toThrow('omitted changed history');
    expect(mock.calls).toHaveBeenCalledOnce();
  });
  it('rejects malformed ordering before it reaches graph layout', async () => {
    const mock = scripted([['repository_snapshot', { ...snap(), history: page([commit('a'), commit('b', ['a'])]) }]]);
    await expect(readNativeSnapshot('session', mock)).rejects.toThrow('inconsistent ancestry');
  });
  it('stops a superseded read before publishing the snapshot', async () => {
    let resolve!: (value: unknown) => void;
    let current = true;
    const invoke = vi.fn(() => new Promise<unknown>(done => { resolve = done; }));
    const result = readNativeSnapshot('session', { invoke: invoke as typeof native, current: () => current });
    current = false; resolve(snap());
    await expect(result).rejects.toThrow('superseded');
    expect(invoke).toHaveBeenCalledOnce();
  });
});

describe('inspector comparison modes', () => {
  it('working categories take precedence over a saved commit comparison', () => {
    expect(inspectorSpec(WORKING_ID, 'staged', 'base', 'target')).toEqual({ kind: 'staged' });
    expect(inspectorSpec(WORKING_ID, 'unstaged', 'base', 'target')).toEqual({ kind: 'unstaged' });
    expect(inspectorSpec('commit', 'staged', 'base', 'target')).toEqual({ kind: 'compare', base: 'base', target: 'target' });
  });
});
