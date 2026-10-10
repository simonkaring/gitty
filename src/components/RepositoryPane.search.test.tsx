// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BUILTIN_THEMES } from '../model/themes';
import { RepositoryPane } from './RepositoryPane';
import { ToastProvider } from './ui';

// Real pane and model code; only the Tauri boundary is scripted. Covers the search lifecycle: a newer query cancels the
// in-flight one (whose `cancelled` rejection is silent), and search re-runs only when history, not status, changes.
const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  graph: { scrollTo: vi.fn(), focus: vi.fn(), anchor: vi.fn(() => null), restore: vi.fn() },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../model/settings', async importOriginal => ({ ...await importOriginal<typeof import('../model/settings')>(), useSettings: () => ({ theme: BUILTIN_THEMES[0], settings: { diffView: 'unified', commitProfiles: [], repositoryCommitProfiles: {} }, updateSettings: vi.fn(), openSettings: vi.fn() }) }));
vi.mock('../graph/useGraphLayout', () => ({ useGraphLayout: (commits: unknown[]) => ({ layout: { nodes: [], edges: [], laneCount: 0, edgeMaxTo: new Int32Array() }, count: commits.length }) }));
vi.mock('./RepositoryToolbar', () => ({ RepositoryToolbar: () => null }));
vi.mock('./NativeInspector', () => ({ NativeInspector: () => null }));
vi.mock('./HistoryGraph', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return { HistoryGraph: forwardRef((_props: unknown, ref) => { useImperativeHandle(ref, () => mocks.graph); return <div data-testid="graph" />; }) };
});

const none = { kind: 'none', label: '', current: null, incoming: null, step: null, total: null, conflicts: [], canContinue: false, canSkip: false, fingerprint: 'none' };
const repo = { stateFingerprint: 'state-1', statusFingerprint: 'status-1' };
const state = () => ({ session: { handle: 'real-1', location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'h1', headRef: 'refs/heads/main' }, refs: [], remotes: [], fingerprint: repo.stateFingerprint });
const status = () => ({ entries: [], head: 'h1', headRef: 'refs/heads/main', fingerprint: repo.statusFingerprint });
const commit = { id: 'h1', parents: [], subject: 'Subject h1', author: 'Ada', email: 'ada@example.com', timestamp: 100 };
type Deferred = { query: { text: string }; resolve: (value: unknown) => void; reject: (reason: unknown) => void };
let searches: Deferred[] = [];

beforeEach(() => {
  repo.stateFingerprint = 'state-1'; repo.statusFingerprint = 'status-1'; searches = [];
  mocks.invoke.mockImplementation((command, args = {}) => {
    switch (command) {
      case 'repository_open': case 'repository_state': return Promise.resolve(state());
      case 'repository_snapshot': return Promise.resolve({ state: state(), status: status(), operation: none });
      case 'repository_status': return Promise.resolve(status());
      case 'repository_history': return Promise.resolve({ commits: [commit], cursor: null, generation: 'walk', shallow: false });
      case 'repository_search': return new Promise((resolve, reject) => { searches.push({ query: args.query as { text: string }, resolve, reject }); });
      default: return Promise.resolve(undefined);
    }
  });
});
afterEach(() => { vi.clearAllMocks(); });

const calls = (name: string) => mocks.invoke.mock.calls.filter(([command]) => command === name);
const props = { tabId: 't', location: { kind: 'native', path: '/repo' } as const, active: true, sidebarOpen: false, inspectorOpen: false, inspectorWidth: 400, sidebarWidth: 240, setInspectorWidth() {}, setSidebarWidth() {}, setInspectorOpen() {}, onIdentity() {}, onBusyChange() {}, onMeta() {} };
async function mount() {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); document.body.append(host);
  const toasts = document.createElement('div'); document.body.append(toasts);
  const root: Root = createRoot(host);
  const render = (active: boolean) => root.render(<ToastProvider value={toasts}><RepositoryPane {...props} active={active} /></ToastProvider>);
  await act(async () => { render(true); });
  await vi.waitFor(() => expect(host.querySelector('input[aria-label="Search full history"]')).not.toBeNull());
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Search full history"]')!;
  const type = (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const focus = () => act(async () => { window.dispatchEvent(new Event('focus')); });
  const settle = (ms = 400) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
  const resolveWith = (item: Deferred, ids: string[]) => act(async () => { item.resolve({ commits: ids.map(id => ({ ...commit, id })), truncated: false }); });
  const reject = (item: Deferred, error: unknown) => act(async () => { item.reject(error); });
  const header = () => host.querySelector('.search-results-header small')?.textContent;
  return { host, type, focus, settle, resolveWith, reject, header, setActive: (value: boolean) => act(async () => { render(value); }), cleanup: async () => { await act(async () => { root.unmount(); }); host.remove(); toasts.remove(); } };
}

it('cancels the in-flight search when the query changes and ignores its cancelled rejection', async () => {
  const t = await mount();
  try {
    await t.type('a');
    await vi.waitFor(() => expect(searches).toHaveLength(1));
    expect(calls('repository_cancel_search')).toHaveLength(0);
    await t.type('ab');
    expect(calls('repository_cancel_search')).toEqual([['repository_cancel_search', { handle: 'real-1' }]]);
    // The backend rejects the superseded request; it must not surface as an error for the newer query.
    await t.reject(searches[0], { code: 'cancelled', message: 'Search cancelled.' });
    await vi.waitFor(() => expect(searches).toHaveLength(2));
    expect(searches[1].query.text).toBe('ab');
    expect(t.header()).toBe('Searching…');
    expect(t.host.querySelector('[role="alert"]')).toBeNull();
    await t.resolveWith(searches[1], ['h1']);
    await vi.waitFor(() => expect(t.header()).toBe('1 matching commits'));
  } finally { await t.cleanup(); }
});

it('does not cancel when no search is in flight and cancels on unmount when one is', async () => {
  const t = await mount();
  try {
    await t.type('a');
    await t.type('ab');
    await t.settle();
    expect(calls('repository_cancel_search')).toHaveLength(0);
    expect(searches.map(item => item.query.text)).toEqual(['ab']);
  } finally { await t.cleanup(); }
  expect(calls('repository_cancel_search')).toEqual([['repository_cancel_search', { handle: 'real-1' }]]);
});

it('still reports a real search failure', async () => {
  const t = await mount();
  try {
    await t.type('a');
    await vi.waitFor(() => expect(searches).toHaveLength(1));
    await t.reject(searches[0], { code: 'git_failed', message: 'git exploded' });
    await vi.waitFor(() => expect(t.header()).toBe('Search failed'));
  } finally { await t.cleanup(); }
});

it('re-runs search when history changes but not for a working-tree-only refresh', async () => {
  const t = await mount();
  try {
    await t.type('a');
    await vi.waitFor(() => expect(searches).toHaveLength(1));
    await t.resolveWith(searches[0], ['h1']);
    await vi.waitFor(() => expect(t.header()).toBe('1 matching commits'));
    // Status fingerprint moves, state fingerprint does not.
    repo.statusFingerprint = 'status-2';
    const statusReads = calls('repository_snapshot').length;
    await t.focus();
    await vi.waitFor(() => expect(calls('repository_snapshot').length).toBeGreaterThan(statusReads));
    await t.settle();
    expect(searches).toHaveLength(1);
    // Refs/HEAD move.
    repo.stateFingerprint = 'state-2';
    await t.focus();
    await vi.waitFor(() => expect(searches).toHaveLength(2));
    expect(searches[1].query.text).toBe('a');
  } finally { await t.cleanup(); }
});

it('starts nothing for a hidden tab and runs the pending filter when it becomes active', async () => {
  const t = await mount();
  try {
    await t.setActive(false);
    await t.type('a');
    await t.settle();
    expect(searches).toHaveLength(0);
    await t.setActive(true);
    await vi.waitFor(() => expect(searches).toHaveLength(1));
    await t.resolveWith(searches[0], ['h1']);
    await vi.waitFor(() => expect(t.header()).toBe('1 matching commits'));
    // A finished search is not repeated when the tab is revisited.
    await t.setActive(false); await t.setActive(true); await t.settle();
    expect(searches).toHaveLength(1);
  } finally { await t.cleanup(); }
});
