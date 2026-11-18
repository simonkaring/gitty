// @vitest-environment jsdom
import { createRoot } from 'react-dom/client';
import { act, forwardRef, useImperativeHandle } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BUILTIN_THEMES } from '../model/themes';
import { RepositoryPane } from './RepositoryPane';
import { ToastProvider } from './ui';

// The graph receives commits from the pane, so the stash record's index parent
// must be dropped there: history never contains it, and laying it out would draw
// a branch to nowhere.
const mocks = vi.hoisted(() => ({ invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(), seen: [] as { id: string; parents: string[] }[] }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../model/settings', async importOriginal => ({ ...await importOriginal<typeof import('../model/settings')>(), useSettings: () => ({ theme: BUILTIN_THEMES[0], settings: { diffView: 'unified', commitProfiles: [], repositoryCommitProfiles: {} }, updateSettings: vi.fn(), openSettings: vi.fn() }) }));
vi.mock('../graph/useGraphLayout', () => ({ useGraphLayout: (commits: unknown[]) => ({ layout: { nodes: [], edges: [], laneCount: 0, edgeMaxTo: new Int32Array() }, count: commits.length }) }));
vi.mock('./RepositoryToolbar', () => ({ RepositoryToolbar: () => null }));
vi.mock('./NativeInspector', () => ({ NativeInspector: () => null }));
vi.mock('./HistoryGraph', () => ({
  HistoryGraph: forwardRef<unknown, { commits: { id: string; parents: string[] }[] }>((props, ref) => {
    useImperativeHandle(ref, () => ({ scrollTo: vi.fn(), anchor: () => null, restore: vi.fn() }));
    mocks.seen = props.commits;
    return null;
  }),
}));

const none = { kind: 'none', label: '', current: null, incoming: null, step: null, total: null, conflicts: [], canContinue: false, canSkip: false, fingerprint: 'none' };
const session = { handle: 'real-1', location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'base', headRef: 'refs/heads/main' };
const state = () => ({ session, refs: [{ name: 'main', fullName: 'refs/heads/main', commitId: 'base', kind: 'local' }, { name: 'stash', fullName: 'refs/stash', commitId: 'stash', kind: 'stash' }], remotes: [], fingerprint: 'state-1' });
const status = () => ({ entries: [], head: 'base', headRef: 'refs/heads/main', fingerprint: 'status-1' });
const commits = [
  { id: 'stash', parents: ['base', 'index'], subject: 'On main: Gitty: 1/1/2026', author: 'Ada', email: 'ada@example.com', timestamp: 300 },
  { id: 'base', parents: [], subject: 'Base', author: 'Ada', email: 'ada@example.com', timestamp: 100 },
];

beforeEach(() => {
  mocks.invoke.mockImplementation(async command => {
    switch (command) {
      case 'repository_open': case 'repository_state': return state();
      case 'repository_snapshot': return { state: state(), status: status(), operation: none, history: { commits, cursor: null, generation: 'walk', shallow: false } };
      case 'repository_status': return status();
      default: return undefined;
    }
  });
});
afterEach(() => { vi.clearAllMocks(); });

it('draws the stash branching from its base commit, not from its index commit', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); document.body.append(host);
  const toasts = document.createElement('div'); document.body.append(toasts);
  const root = createRoot(host);
  const props = { tabId: 't', location: { kind: 'native', path: '/repo' } as const, active: true, sidebarOpen: false, inspectorOpen: false, inspectorWidth: 400, sidebarWidth: 240, setInspectorWidth() {}, setSidebarWidth() {}, setInspectorOpen() {}, onIdentity() {}, onBusyChange() {}, onMeta() {} };
  try {
    await act(async () => { root.render(<ToastProvider value={toasts}><RepositoryPane {...props} /></ToastProvider>); });
    await vi.waitFor(() => expect(mocks.seen.map(commit => commit.id)).toContain('stash'));
    expect(mocks.seen.find(commit => commit.id === 'stash')!.parents).toEqual(['base']);
  } finally { await act(async () => { root.unmount(); }); host.remove(); toasts.remove(); }
});
