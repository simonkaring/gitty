// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client';
import { act, forwardRef, useImperativeHandle } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BUILTIN_THEMES } from '../model/themes';
import { RepositoryPane } from './RepositoryPane';
import { ToastProvider } from './ui';

// Real pane, real model code; only the Tauri boundary is scripted. This covers where disclosure state lives:
// in the pane, per repository session, across working -> commit -> working inspector switches.
const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  graph: { scrollTo: vi.fn(), focus: vi.fn(), anchor: vi.fn(() => null), restore: vi.fn() },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../model/settings', async importOriginal => ({ ...await importOriginal<typeof import('../model/settings')>(), useSettings: () => ({ theme: BUILTIN_THEMES[0], settings: { diffView: 'unified', commitProfiles: [], repositoryCommitProfiles: {} }, updateSettings: vi.fn(), openSettings: vi.fn() }) }));
vi.mock('../graph/useGraphLayout', () => ({ useGraphLayout: (commits: unknown[]) => ({ layout: { nodes: [], edges: [], laneCount: 0, edgeMaxTo: new Int32Array() }, count: commits.length }) }));
vi.mock('./RepositoryToolbar', () => ({ RepositoryToolbar: () => null }));
vi.mock('./HistoryGraph', () => ({
  HistoryGraph: forwardRef<unknown, { commits: { id: string }[]; selectedId: string; onSelect: (id: string) => void }>((props, ref) => {
    useImperativeHandle(ref, () => mocks.graph);
    return <div data-testid="graph">{props.commits.slice(0, 4).map(commit => <button key={commit.id} data-commit={commit.id} onClick={() => props.onSelect(commit.id)}>{commit.id}</button>)}</div>;
  }),
}));

const none = { kind: 'none', label: '', current: null, incoming: null, step: null, total: null, conflicts: [], canContinue: false, canSkip: false, fingerprint: 'none' };
let handle = 'real-1';
const entries = [
  { path: 'edited.txt', oldPath: null, indexStatus: '.', worktreeStatus: 'M', conflicted: false, untracked: false },
  { path: 'staged.txt', oldPath: null, indexStatus: 'M', worktreeStatus: '.', conflicted: false, untracked: false },
];
const state = () => ({ session: { handle, location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'h1', headRef: 'refs/heads/main' }, refs: [], remotes: [], fingerprint: 'fp' });
const status = () => ({ entries, head: 'h1', headRef: 'refs/heads/main', fingerprint: 'status-1' });
const commit = { id: 'h1', parents: [], subject: 'Subject h1', author: 'Ada', email: 'ada@example.com', timestamp: 100 };

beforeEach(() => {
  handle = 'real-1';
  mocks.invoke.mockImplementation(async command => {
    switch (command) {
      case 'repository_open': case 'repository_state': return state();
      case 'repository_snapshot': return { state: state(), status: status(), operation: none };
      case 'repository_status': return status();
      case 'repository_history': return { commits: [commit], cursor: null, generation: 'walk', shallow: false };
      case 'repository_commit': return { ...commit, body: 'Subject h1\n\nBody', canEditMessage: true, editDisabledReason: null };
      case 'repository_diff_files': return [];
      default: return undefined;
    }
  });
});
afterEach(() => { vi.clearAllMocks(); });

const props = { tabId: 't', location: { kind: 'native', path: '/repo' } as const, active: true, sidebarOpen: false, inspectorOpen: true, inspectorWidth: 400, sidebarWidth: 240, setInspectorWidth() {}, setSidebarWidth() {}, setInspectorOpen() {}, onIdentity() {}, onBusyChange() {}, onMeta() {} };
async function mount() {
  const render = (location: typeof props.location | { kind: 'native'; path: string } = props.location) => root.render(<ToastProvider value={toasts}><RepositoryPane {...props} location={location} /></ToastProvider>);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); document.body.append(host);
  const toasts = document.createElement('div'); document.body.append(toasts);
  const root: Root = createRoot(host);
  await act(async () => { render(); });
  const q = <T extends Element>(selector: string) => host.querySelector<T>(selector);
  const click = (node: Element | null) => act(async () => { (node as HTMLElement).click(); });
  const showWorking = async () => { await vi.waitFor(() => expect(q('[data-commit="gitty:working-tree"]')).not.toBeNull()); await click(q('[data-commit="gitty:working-tree"]')); await vi.waitFor(() => expect(q('.working-inspector')).not.toBeNull()); };
  const unstaged = () => q<HTMLButtonElement>('.working-category.unstaged h2 > button')!;
  const composer = () => q<HTMLButtonElement>('.composer-toggle')!;
  return { host, q, click, reopen: (path: string) => act(async () => { render({ kind: 'native', path }); }), showWorking, unstaged, composer, cleanup: async () => { await act(async () => { root.unmount(); }); host.remove(); toasts.remove(); } };
}

it('keeps folded groups and a collapsed composer when the inspector switches to a commit and back', async () => {
  const t = await mount();
  try {
    await t.showWorking();
    expect(t.unstaged().getAttribute('aria-expanded')).toBe('true');
    expect(t.composer().getAttribute('aria-expanded')).toBe('true');
    await t.click(t.unstaged());
    await t.click(t.composer());
    await t.click(t.q('details.composer-identity > summary'));
    await t.click(t.q('[data-commit="h1"]'));
    await vi.waitFor(() => expect(t.q('.native-inspector')).not.toBeNull());
    expect(t.q('.working-inspector')).toBeNull();
    await t.showWorking();
    expect(t.unstaged().getAttribute('aria-expanded')).toBe('false');
    expect(t.q('.working-category.staged h2 > button')!.getAttribute('aria-expanded')).toBe('true');
    expect(t.composer().getAttribute('aria-label')).toBe('Expand commit composer');
    expect(t.q<HTMLDetailsElement>('details.composer-identity')!.open).toBe(true);
  } finally { await t.cleanup(); }
});

it('starts from the defaults again when the repository session changes', async () => {
  const t = await mount();
  try {
    await t.showWorking();
    await t.click(t.unstaged());
    await t.click(t.composer());
    handle = 'real-2';
    await t.reopen('/other');
    await t.showWorking();
    expect(t.unstaged().getAttribute('aria-expanded')).toBe('true');
    expect(t.composer().getAttribute('aria-label')).toBe('Collapse commit composer');
  } finally { await t.cleanup(); }
});
