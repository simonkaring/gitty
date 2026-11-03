// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { commitGraphCommand, commitGraphDismissed, dismissCommitGraph, suggestCommitGraph } from './commitGraph';
import { demoInvoke, demoLocation } from './demoBackend';
import { readNativeSnapshot } from './native';
import type { RepositoryState } from './repository';

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } });
});
it('suggests only a missing graph after a slow first page, unless dismissed', () => {
  expect(suggestCommitGraph('missing', 299, false)).toBe(false);
  expect(suggestCommitGraph('missing', 300, false)).toBe(true);
  expect(suggestCommitGraph('present', 900, false)).toBe(false);
  expect(suggestCommitGraph('disabled', 900, false)).toBe(false);
  expect(suggestCommitGraph(null, 900, false)).toBe(false);
  expect(suggestCommitGraph('missing', 900, true)).toBe(false);
});
it('persists dismissal per canonical repository, not per session', () => {
  dismissCommitGraph('native:/one');
  expect(commitGraphDismissed('native:/one')).toBe(true);
  expect(commitGraphDismissed('native:/two')).toBe(false);
});
it('offers the palette command independently of suggestion eligibility', () => {
  const run = vi.fn();
  const command = commitGraphCommand(run, false);
  expect(command.label).toBe('Speed up history');
  expect(command.disabled).toBe(false);
  command.run();
  expect(run).toHaveBeenCalledOnce();
  expect(commitGraphCommand(run, true).disabled).toBe(true);
});
it('simulates status and the explicit write in the browser demo', async () => {
  await demoInvoke('repository_open', { location: demoLocation('little-api') });
  const args = { handle: 'demo:little-api' };
  expect(await demoInvoke('repository_commit_graph_status', args)).toBe('missing');
  expect(await demoInvoke('repository_write_commit_graph', args)).toEqual({ output: '' });
  expect(await demoInvoke('repository_commit_graph_status', args)).toBe('present');
});
it('reports first-page IPC duration without counting snapshot reads', async () => {
  const observe = vi.fn();
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const state = { session: { head: null, headRef: null }, fingerprint: 'refs' };
  const invoke = vi.fn(async (command: string) => {
    if (command === 'repository_snapshot') { now += 2000; return { state, status: { head: null, headRef: null }, operation: {} }; }
    if (command === 'repository_history') { now += 350; return { commits: [], cursor: null, generation: 'g' }; }
    return state;
  }) as unknown as typeof import('./native').native;
  try {
    await readNativeSnapshot('real', { invoke, onFirstHistoryPage: observe });
    expect(observe).toHaveBeenCalledExactlyOnceWith(350);
  } finally { vi.restoreAllMocks(); }
});
it('forced history reload retains the previously loaded count despite unchanged refs', async () => {
  const state = { session: { head: null, headRef: null }, fingerprint: 'refs' } as unknown as RepositoryState;
  const commits = Array.from({ length: 401 }, (_, index) => ({ id: `c${index}`, parents: [], subject: 'Commit', author: 'Ada', email: 'a@example.com', timestamp: 1 }));
  let page = 0;
  const invoke = vi.fn(async (command: string) => {
    if (command === 'repository_snapshot') return { state, status: { head: null, headRef: null }, operation: {} };
    if (command === 'repository_history') {
      const start = page++ * 200;
      return { commits: commits.slice(start, start + 200), cursor: page < 3 ? `page${page}` : null, generation: 'new' };
    }
    return state;
  }) as unknown as typeof import('./native').native;
  const snapshot = await readNativeSnapshot('real', { invoke, forceHistory: true, previous: { state, commits, cursor: 'old', generation: 'old' } });
  expect(page).toBe(3);
  expect(snapshot.commits).toHaveLength(401);
  expect(snapshot.generation).toBe('new');
});
