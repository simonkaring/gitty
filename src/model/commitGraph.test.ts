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
it('reports backend first-page duration without counting snapshot IPC time', async () => {
  const observe = vi.fn();
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const state = { session: { head: null, headRef: null }, fingerprint: 'refs' };
  const invoke = vi.fn(async (command: string) => {
    if (command === 'repository_snapshot') { now += 2350; return { state, status: { head: null, headRef: null }, operation: {}, history: { commits: [], cursor: null, generation: 'g', firstPageMillis: 350 } }; }
    return state;
  }) as unknown as typeof import('./native').native;
  try {
    await readNativeSnapshot('real', { invoke, onFirstHistoryPage: observe });
    expect(observe).toHaveBeenCalledExactlyOnceWith(350);
  } finally { vi.restoreAllMocks(); }
});
it('forced history reload walks fresh history despite unchanged refs', async () => {
  const state = { session: { head: null, headRef: null }, fingerprint: 'refs' } as unknown as RepositoryState;
  const commits = Array.from({ length: 401 }, (_, index) => ({ id: `c${index}`, parents: [], subject: 'Commit', author: 'Ada', email: 'a@example.com', timestamp: 1 }));
  const requests: unknown[] = [];
  const invoke = vi.fn(async (command: string, args?: { history?: unknown }) => {
    if (command === 'repository_snapshot') {
      requests.push(args?.history);
      return { state, status: { head: null, headRef: null }, operation: {}, history: { commits: commits.slice(0, 400), cursor: 'next', generation: 'new', shallow: false, firstPageMillis: 12 } };
    }
    return state;
  }) as unknown as typeof import('./native').native;
  const observe = vi.fn();
  const snapshot = await readNativeSnapshot('real', { invoke, forceHistory: true, onFirstHistoryPage: observe, previous: { state, commits, cursor: 'old', generation: 'old' } });
  // No fingerprint: the backend may not reuse the unchanged generation.
  expect(requests).toEqual([expect.objectContaining({ fingerprint: undefined })]);
  expect(snapshot.commits).toHaveLength(400);
  expect(snapshot.generation).toBe('new');
  expect(observe).toHaveBeenCalledExactlyOnceWith(12);
});
