// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client';
import { act, forwardRef, useImperativeHandle } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BUILTIN_THEMES } from '../model/themes';
import { WORKING_ID } from '../model/native';
import { RepositoryPane } from './RepositoryPane';
import { ToastProvider } from './ui';

// Real pane and model code; only the Tauri boundary and the graph surface are
// scripted. Covers revealing the synthetic working-changes row at the top of a
// scrolled graph instead of merely selecting it off-screen.
const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  graph: { scrollTo: vi.fn(), focus: vi.fn(), anchor: vi.fn(() => null), restore: vi.fn() },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../model/settings', async importOriginal => ({ ...await importOriginal<typeof import('../model/settings')>(), useSettings: () => ({ theme: BUILTIN_THEMES[0], settings: { diffView: 'unified', commitProfiles: [], repositoryCommitProfiles: {} }, updateSettings: vi.fn(), openSettings: vi.fn() }) }));
vi.mock('../graph/useGraphLayout', () => ({ useGraphLayout: (commits: unknown[]) => ({ layout: { nodes: [], edges: [], laneCount: 0, edgeMaxTo: new Int32Array() }, count: commits.length }) }));
vi.mock('./RepositoryToolbar', () => ({ RepositoryToolbar: () => null }));
vi.mock('./NativeInspector', () => ({ NativeInspector: () => null }));
vi.mock('./HistoryGraph', () => ({
  HistoryGraph: forwardRef<unknown, { commits: { id: string }[]; onSelect: (id: string) => void }>((props, ref) => {
    useImperativeHandle(ref, () => mocks.graph);
    return <div data-testid="graph">{props.commits.map(commit => <button key={commit.id} data-commit={commit.id} onClick={() => props.onSelect(commit.id)}>{commit.id}</button>)}</div>;
  }),
}));

const none = { kind: 'none', label: '', current: null, incoming: null, step: null, total: null, conflicts: [], canContinue: false, canSkip: false, fingerprint: 'none' };
const entries = [{ path: 'edited.txt', oldPath: null, indexStatus: '.', worktreeStatus: 'M', conflicted: false, untracked: false }];
const state = () => ({ session: { handle: 'real-1', location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'h1', headRef: 'refs/heads/main' }, refs: [], remotes: [], fingerprint: 'state-1' });
const status = () => ({ entries, head: 'h1', headRef: 'refs/heads/main', fingerprint: 'status-1' });
const commit = { id: 'h1', parents: [], subject: 'Subject h1', author: 'Ada', email: 'ada@example.com', timestamp: 100 };

beforeEach(() => {
  mocks.invoke.mockImplementation(async command => {
    switch (command) {
      case 'repository_open': case 'repository_state': return state();
      case 'repository_snapshot': return { state: state(), status: status(), operation: none };
      case 'repository_status': return status();
      case 'repository_history': return { commits: [commit], cursor: null, generation: 'walk', shallow: false };
      default: return undefined;
    }
  });
});
afterEach(() => { vi.clearAllMocks(); });

it('scrolls the graph to the working-changes row when it is revealed', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); document.body.append(host);
  const toasts = document.createElement('div'); document.body.append(toasts);
  const root: Root = createRoot(host);
  const props = { tabId: 't', location: { kind: 'native', path: '/repo' } as const, active: true, sidebarOpen: false, inspectorOpen: false, inspectorWidth: 400, sidebarWidth: 240, setInspectorWidth() {}, setSidebarWidth() {}, setInspectorOpen() {}, onIdentity() {}, onBusyChange() {}, onMeta() {} };
  try {
    await act(async () => { root.render(<ToastProvider value={toasts}><RepositoryPane {...props} /></ToastProvider>); });
    await vi.waitFor(() => expect(host.querySelector(`[data-commit="${WORKING_ID}"]`)).not.toBeNull());
    expect(mocks.graph.scrollTo).not.toHaveBeenCalled();
    await act(async () => { (host.querySelector(`[data-commit="${WORKING_ID}"]`) as HTMLButtonElement).click(); });
    expect(mocks.graph.scrollTo).toHaveBeenCalledExactlyOnceWith(0);
  } finally {
    await act(async () => { root.unmount(); });
    host.remove(); toasts.remove();
  }
});
