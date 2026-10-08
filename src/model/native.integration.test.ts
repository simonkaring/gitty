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
const snap = (head = 'a', bare = false) => ({ state: state(head, bare), status: status(head), operation });
const previous: NativeSnapshot = { state: state(), status: status(), operation, commits: [commit('a')], cursor: null, generation: 'old-walk' };

describe('native snapshot IPC integration', () => {
  it('reads state, status and operation in one call before starting a walk', async () => {
    const mock = scripted([['repository_snapshot', snap('b')], ['repository_history', page([commit('b')])], ['repository_state', state('b')]]);
    const result = await readNativeSnapshot('session', mock);
    expect(result.state.session.head).toBe(result.status.head);
    expect(result.operation).toBe(operation);
    expect(result.commits[0].id).toBe('b'); expect(mock.steps).toHaveLength(0);
  });
  it('discards a complete candidate when refs move while history is being fetched', async () => {
    const mock = scripted([
      ['repository_snapshot', snap('a')], ['repository_history', page([commit('a')])], ['repository_state', state('b')],
      ['repository_snapshot', snap('b')], ['repository_history', page([commit('b')], null, 'new-walk')], ['repository_state', state('b')],
    ]);
    const result = await readNativeSnapshot('session', mock);
    expect(result.generation).toBe('new-walk'); expect(result.cursor).toBeNull();
    expect(result.commits.map(c => c.id)).toEqual(['b']);
  });
  it('loads beyond the old prefix to preserve selection and viewport after more than a page of new commits', async () => {
    const newest = Array.from({ length: 200 }, (_, i) => commit(`new-${i}`, [i === 199 ? 'a' : `new-${i + 1}`]));
    const mock = scripted([
      ['repository_snapshot', snap('new-0')],
      ['repository_history', page(newest, 'page-2')],
      ['repository_history', page([commit('a', ['anchor']), commit('anchor')])],
      ['repository_state', state('new-0')],
    ]);
    const result = await readNativeSnapshot('session', { ...mock, previous, preserve: ['a', 'anchor'] });
    expect(result.commits).toHaveLength(202);
    expect(mock.calls.mock.calls.filter(([command]) => command === 'repository_history')).toHaveLength(2);
  });
  it('finishes the walk when a retained selection becomes unreachable without adding fake ancestry', async () => {
    const mock = scripted([['repository_snapshot', snap('b')], ['repository_history', page([commit('b')])], ['repository_state', state('b')]]);
    const result = await readNativeSnapshot('session', { ...mock, previous, preserve: ['a'] });
    expect(result.cursor).toBeNull(); expect(result.commits.map(c => c.id)).toEqual(['b']);
    expect(previous.commits.map(c => c.id)).toEqual(['a']);
  });
  it('excludes a deleted target from automatic keep-visible paging without filtering returned history', async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => commit(`tip-${index}`, [`parent-${index}`]));
    const mock = scripted([['repository_snapshot', snap('tip-0')], ['repository_history', page(firstPage, 'next')], ['repository_state', state('tip-0')]]);
    const result = await readNativeSnapshot('session', { ...mock, previous, preserve: ['a'], excludeKeepVisible: ['a'] });
    expect(result.commits).toHaveLength(200);
    expect(result.commits.some(item => item.id === 'a')).toBe(false);
    expect(result.cursor).toBe('next');
    expect(mock.calls.mock.calls.filter(([command]) => command === 'repository_history')).toHaveLength(1);
  });
  describe('following an amended tip', () => {
    const chain = (prefix: string, length: number) => Array.from({ length }, (_, i) => commit(`${prefix}${i}`, [`${prefix}${i + 1}`]));
    const before: NativeSnapshot = { ...previous, state: state('old'), status: status('old'), commits: [commit('old', ['base']), commit('base')], cursor: null };
    const walks = (mock: ReturnType<typeof scripted>) => mock.calls.mock.calls.filter(([command]) => command === 'repository_history').length;

    it('follows the old tip to the new commit and stops at the first page instead of searching for an unreachable ID', async () => {
      const mock = scripted([['repository_snapshot', snap('new')], ['repository_history', page([commit('new', ['base']), ...chain('x', 199)], 'more')], ['repository_state', state('new')]]);
      const result = await readNativeSnapshot('session', { ...mock, previous: before, preserve: ['old'], remap: { from: 'old', to: 'new' } });
      expect(result.commits).toHaveLength(200); expect(result.cursor).toBe('more');
      expect(mock.steps).toHaveLength(0); expect(walks(mock)).toBe(1);
    });
    it('without the confirmed remap the same refresh walks on looking for the old tip', async () => {
      const mock = scripted([
        ['repository_snapshot', snap('new')], ['repository_history', page([commit('new', ['base']), ...chain('x', 199)], 'more')],
        ['repository_history', page([commit('base')], null)], ['repository_state', state('new')],
      ]);
      const result = await readNativeSnapshot('session', { ...mock, previous: before, preserve: ['old'] });
      expect(result.cursor).toBeNull(); expect(walks(mock)).toBe(2);
    });
    it('ignores a remap whose target is not the refreshed HEAD, so a moved HEAD cannot force a full walk for it', async () => {
      const mock = scripted([
        ['repository_snapshot', snap('hooked')], ['repository_history', page([commit('hooked', ['base']), ...chain('x', 199)], 'more')],
        ['repository_history', page([commit('base')], null)], ['repository_state', state('hooked')],
      ]);
      await readNativeSnapshot('session', { ...mock, previous: before, preserve: ['old'], remap: { from: 'old', to: 'new' } });
      // `old` was kept (it was in the previous history) and could not be found; `new` was never searched for.
      expect(walks(mock)).toBe(2);
    });
    it('drops automatic candidates that were not in the previous history before remapping, so an inspector-only orphan never causes a scan', async () => {
      const mock = scripted([['repository_snapshot', snap('new')], ['repository_history', page([commit('new'), ...chain('x', 199)], 'more')], ['repository_state', state('new')]]);
      const result = await readNativeSnapshot('session', { ...mock, previous: { ...before, state: state('older') }, preserve: ['orphan', 'ghost', WORKING_ID], remap: { from: 'ghost', to: 'new' } });
      expect(result.cursor).toBe('more'); expect(walks(mock)).toBe(1);
    });
  });
  it('reuses the pinned walk on unchanged polls with a single IPC call', async () => {
    const mock = scripted([['repository_snapshot', snap()]]);
    const result = await readNativeSnapshot('session', { ...mock, previous });
    expect(result.commits).toBe(previous.commits); expect(result.generation).toBe('old-walk');
    expect(result.operation).toBe(operation);
    expect(mock.steps).toHaveLength(0); expect(mock.calls).toHaveBeenCalledTimes(1);
  });
  it('walks history for a bare repository without a working-tree status', async () => {
    const mock = scripted([['repository_snapshot', snap('a', true)], ['repository_history', page([commit('a')])], ['repository_state', state('a', true)]]);
    const result = await readNativeSnapshot('session', mock);
    expect(result.status.entries).toEqual([]); expect(mock.steps).toHaveLength(0);
  });
  it('rejects malformed ordering before it reaches graph layout', async () => {
    const mock = scripted([['repository_snapshot', snap()], ['repository_history', page([commit('a'), commit('b', ['a'])])], ['repository_state', state()]]);
    await expect(readNativeSnapshot('session', mock)).rejects.toThrow('inconsistent ancestry');
  });
  it('bounds retries while refs keep moving', async () => {
    const mock = scripted(Array.from({ length: 3 }, (): [string, unknown][] => [['repository_snapshot', snap('a')], ['repository_history', page([commit('a')])], ['repository_state', state('b')]]).flat());
    await expect(readNativeSnapshot('session', mock)).rejects.toThrow('kept changing');
    expect(mock.calls).toHaveBeenCalledTimes(9);
  });
  it('stops a superseded asynchronous read before issuing another IPC request', async () => {
    let resolve!: (value: unknown) => void;
    let current = true;
    const invoke = vi.fn(() => new Promise<unknown>(done => { resolve = done; }));
    const result = readNativeSnapshot('session', { invoke: invoke as typeof native, current: () => current });
    current = false; resolve(snap());
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
