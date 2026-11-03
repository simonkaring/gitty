// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BUILTIN_THEMES } from '../model/themes';
import { WATCHED_REFRESH_INTERVAL } from '../model/autoFetch';
import { RepositoryPane } from './RepositoryPane';
import { ToastProvider } from './ui';

// Real pane and refresh policy; only the Tauri boundary (commands and the
// `repository_changed` event) and heavy children are scripted.
const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  watch: { active: true } as { active: boolean; reason?: string },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, callback: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, callback);
    return () => mocks.listeners.delete(name);
  },
}));
vi.mock('../model/settings', async importOriginal => ({ ...await importOriginal<typeof import('../model/settings')>(), useSettings: () => ({ theme: BUILTIN_THEMES[0], settings: { diffView: 'unified', commitProfiles: [], repositoryCommitProfiles: {} }, updateSettings: vi.fn(), openSettings: vi.fn() }) }));
vi.mock('../graph/useGraphLayout', () => ({ useGraphLayout: (commits: unknown[]) => ({ layout: { nodes: [], edges: [], laneCount: 0, edgeMaxTo: new Int32Array() }, count: commits.length }) }));
vi.mock('./RepositoryToolbar', () => ({ RepositoryToolbar: () => null }));
vi.mock('./NativeInspector', () => ({ NativeInspector: () => null }));
vi.mock('./HistoryGraph', () => ({ HistoryGraph: () => null }));

const none = { kind: 'none', label: '', current: null, incoming: null, step: null, total: null, conflicts: [], canContinue: false, canSkip: false, fingerprint: 'none' };
const state = () => ({ session: { handle: 'real-1', location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'h1', headRef: 'refs/heads/main' }, refs: [], remotes: [], fingerprint: 'state-1' });
const status = () => ({ entries: [], head: 'h1', headRef: 'refs/heads/main', fingerprint: 'status-1' });
const commit = { id: 'h1', parents: [], subject: 'Subject h1', author: 'Ada', email: 'ada@example.com', timestamp: 100 };
const snapshots = () => mocks.invoke.mock.calls.filter(([command]) => command === 'repository_snapshot').length;
const changed = (handle: string) => act(async () => { mocks.listeners.get('repository_changed')?.({ payload: { handle } }); await vi.advanceTimersByTimeAsync(0); });

let host: HTMLDivElement, toasts: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.invoke.mockImplementation(async command => {
    switch (command) {
      case 'repository_open': case 'repository_state': return state();
      case 'repository_snapshot': return { state: state(), status: status(), operation: none, history: { commits: [commit], cursor: null, generation: 'walk', shallow: false } };
      case 'repository_watch': return mocks.watch;
      default: return undefined;
    }
  });
  host = document.createElement('div'); document.body.append(host);
  toasts = document.createElement('div'); document.body.append(toasts);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove(); toasts.remove();
  mocks.listeners.clear();
  vi.clearAllMocks();
  vi.useRealTimers();
});

async function mount() {
  const props = { tabId: 't', location: { kind: 'native', path: '/repo' } as const, active: true, sidebarOpen: false, inspectorOpen: false, inspectorWidth: 400, sidebarWidth: 240, setInspectorWidth() {}, setSidebarWidth() {}, setInspectorOpen() {}, onIdentity() {}, onBusyChange() {}, onMeta() {} };
  await act(async () => { root.render(<ToastProvider value={toasts}><RepositoryPane {...props} /></ToastProvider>); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('repository_watch', { handle: 'real-1' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  return async (active: boolean) => {
    await act(async () => { root.render(<ToastProvider value={toasts}><RepositoryPane {...props} active={active} /></ToastProvider>); });
  };
}

it('refreshes on change events and polls only as a safety net while watching', async () => {
  mocks.watch = { active: true };
  await mount();
  // The opening read plus one catch-up read once the watch is active.
  await vi.waitFor(() => expect(snapshots()).toBe(2));
  const opened = snapshots();
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(snapshots()).toBe(opened);
  await changed('other-session');
  expect(snapshots()).toBe(opened);
  await changed('real-1');
  expect(snapshots()).toBe(opened + 1);
  await act(async () => { await vi.advanceTimersByTimeAsync(WATCHED_REFRESH_INTERVAL + 5000); });
  expect(snapshots()).toBe(opened + 2);
});

it('keeps the five-second poll when the watcher is unavailable', async () => {
  mocks.watch = { active: false, reason: 'unavailable' };
  await mount();
  const opened = snapshots();
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(snapshots()).toBeGreaterThanOrEqual(opened + 3);
});

it('consumes inactive-tab events with activation instead of refreshing again on visibility', async () => {
  mocks.watch = { active: true };
  const activate = await mount();
  const opened = snapshots();
  await activate(false);
  await changed('real-1');
  expect(snapshots()).toBe(opened);
  await activate(true);
  expect(snapshots()).toBe(opened + 1);
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(1000); });
  expect(snapshots()).toBe(opened + 1);
  await changed('real-1');
  expect(snapshots()).toBe(opened + 2);
});
