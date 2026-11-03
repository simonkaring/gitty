// @vitest-environment jsdom
import { createRoot } from 'react-dom/client';
import { forwardRef, useImperativeHandle } from 'react';
import { expect, it, vi } from 'vitest';
import { RepositoryPane } from './RepositoryPane';
import { BUILTIN_THEMES } from '../model/themes';
import { ToastProvider } from './ui';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../model/settings', async original => ({ ...await original<typeof import('../model/settings')>(), useSettings: () => ({ theme: BUILTIN_THEMES[0], settings: { diffView: 'unified' } }) }));
vi.mock('../graph/useGraphLayout', () => ({ useGraphLayout: () => ({ layout: { nodes: [], edges: [], laneCount: 0 }, count: 1 }) }));
vi.mock('./RepositoryToolbar', () => ({ RepositoryToolbar: () => null }));
vi.mock('./NativeInspector', () => ({ NativeInspector: () => null }));
vi.mock('./NativeSidebar', () => ({ NativeSidebar: () => null }));
vi.mock('./HistoryGraph', () => ({ HistoryGraph: forwardRef<unknown, object>((_, ref) => {
  useImperativeHandle(ref, () => ({ anchor: () => null, restore() {}, focus() {}, scrollTo() {} }));
  return null;
}) }));

it('runs the palette write once, shows progress, and reloads history even when refs are unchanged', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  const state = { session: { handle: 'commitgraph-real', location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'tip', headRef: 'refs/heads/main' }, refs: [], remotes: [], fingerprint: 'unchanged' };
  const status = { head: 'tip', headRef: 'refs/heads/main', fingerprint: 'status', entries: [] };
  const operation = { kind: 'none', label: '', current: null, incoming: null, step: null, total: null, conflicts: [], canContinue: false, canSkip: false, fingerprint: 'none' };
  let finish!: (value: { output: string }) => void;
  const write = new Promise<{ output: string }>(resolve => { finish = resolve; });
  let graphPresent = false;
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === 'repository_open' || command === 'repository_state') return state;
    if (command === 'repository_snapshot') return { state, status, operation };
    if (command === 'repository_history') return { commits: [{ id: 'tip', parents: [], subject: 'Tip', author: 'Ada', email: 'ada@example.com', timestamp: 1 }], cursor: null, generation: 'g', shallow: false };
    if (command === 'repository_worktrees') return [];
    if (command === 'repository_commit_graph_status') return graphPresent ? 'present' : 'missing';
    if (command === 'repository_write_commit_graph') { const result = await write; graphPresent = true; return result; }
    return undefined;
  });
  const host = document.createElement('div'); document.body.append(host);
  const toasts = document.createElement('div'); document.body.append(toasts);
  const root = createRoot(host);
  const location = { kind: 'native' as const, path: '/repo' };
  const busy = vi.fn();
  const render = (paletteOpen: boolean) => root.render(<ToastProvider value={toasts}><RepositoryPane tabId="t" location={location} active sidebarOpen inspectorOpen={false} inspectorWidth={400} sidebarWidth={240} setInspectorWidth={() => {}} setSidebarWidth={() => {}} setInspectorOpen={() => {}} onIdentity={() => {}} onBusyChange={busy} onMeta={() => {}} paletteOpen={paletteOpen} onClosePalette={() => render(false)} /></ToastProvider>);
  try {
    render(true);
    const command = await vi.waitFor(() => {
      const button = host.querySelector<HTMLElement>('#palette-speed-up-history');
      expect(button).not.toBeNull(); return button!;
    }, { timeout: 5000 });
    command.click();
    await vi.waitFor(() => expect(toasts.textContent).toContain('Speeding up history'), { timeout: 5000 });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'repository_write_commit_graph')).toHaveLength(1);
    expect(busy).not.toHaveBeenCalledWith('t', true);
    finish({ output: '' });
    await vi.waitFor(() => expect(toasts.textContent).toContain('History accelerated'), { timeout: 5000 });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'repository_history')).toHaveLength(2);
    await vi.waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === 'repository_commit_graph_status')).toHaveLength(2));
  } finally { root.unmount(); host.remove(); toasts.remove(); }
});
