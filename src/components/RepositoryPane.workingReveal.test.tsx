// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BUILTIN_THEMES } from '../model/themes';
import { WORKING_ID } from '../model/native';
import { RepositoryPane } from './RepositoryPane';
import { ToastProvider } from './ui';

// Real pane, real HistoryGraph and layout; only the Tauri boundary is scripted.
// Covers the ordering that matters for the new row: refresh anchors the scrolled
// list to its top commit, then the graph reveals the working-changes row once.
const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  entries: [] as { path: string; oldPath: null; indexStatus: string; worktreeStatus: string; conflicted: boolean; untracked: boolean }[],
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../model/settings', async importOriginal => ({ ...await importOriginal<typeof import('../model/settings')>(), useSettings: () => ({ theme: BUILTIN_THEMES[0], settings: { diffView: 'unified', commitProfiles: [], repositoryCommitProfiles: {} }, updateSettings: vi.fn(), openSettings: vi.fn() }) }));
vi.mock('./RepositoryToolbar', () => ({ RepositoryToolbar: () => null }));
vi.mock('./NativeInspector', () => ({ NativeInspector: () => null }));

const none = { kind: 'none', label: '', current: null, incoming: null, step: null, total: null, conflicts: [], canContinue: false, canSkip: false, fingerprint: 'none' };
const entry = (path: string) => ({ path, oldPath: null, indexStatus: '.', worktreeStatus: 'M', conflicted: false, untracked: false });
const commits = Array.from({ length: 60 }, (_, index) => ({ id: `c${index}`, parents: index === 59 ? [] : [`c${index + 1}`], subject: `Commit ${index}`, author: 'Ada', email: 'ada@example.com', timestamp: 1000 - index }));
const state = () => ({ session: { handle: 'real-1', location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'c0', headRef: 'refs/heads/main' }, refs: [], remotes: [], fingerprint: 'state-1' });
const status = () => ({ entries: mocks.entries.map(item => ({ ...item })), head: 'c0', headRef: 'refs/heads/main', fingerprint: `status-${mocks.entries.length}` });

beforeEach(() => {
  mocks.entries = [];
  mocks.invoke.mockImplementation(async command => {
    switch (command) {
      case 'repository_open': case 'repository_state': return state();
      case 'repository_snapshot': return { state: state(), status: status(), operation: none };
      case 'repository_status': return status();
      case 'repository_history': return { commits, cursor: null, generation: 'walk', shallow: false };
      default: return undefined;
    }
  });
});
afterEach(() => { vi.clearAllMocks(); });

it('reveals a newly surfaced working-changes row but keeps the position on later working-tree refreshes', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const originalObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} } as typeof ResizeObserver;
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(new Proxy({}, { get: () => () => {} }) as CanvasRenderingContext2D);
  const host = document.createElement('div'); document.body.append(host);
  const toasts = document.createElement('div'); document.body.append(toasts);
  const root: Root = createRoot(host);
  const props = { tabId: 't', location: { kind: 'native', path: '/repo' } as const, active: true, sidebarOpen: false, inspectorOpen: false, inspectorWidth: 400, sidebarWidth: 240, setInspectorWidth() {}, setSidebarWidth() {}, setInspectorOpen() {}, onIdentity() {}, onBusyChange() {}, onMeta() {} };
  const scrollTo = async (top: number) => {
    const scroller = host.querySelector('.history-scroll') as HTMLElement;
    scroller.scrollTop = top;
    await act(async () => { scroller.dispatchEvent(new Event('scroll', { bubbles: true })); });
  };
  const refresh = async () => { await act(async () => { window.dispatchEvent(new Event('focus')); await new Promise(resolve => setTimeout(resolve, 100)); }); };
  try {
    await act(async () => { root.render(<ToastProvider value={toasts}><RepositoryPane {...props} /></ToastProvider>); });
    await vi.waitFor(() => expect(host.querySelectorAll('.commit-row').length).toBeGreaterThan(1));
    await scrollTo(500);
    expect((host.querySelector('.history-scroll') as HTMLElement).scrollTop).toBe(500);

    mocks.entries = [entry('edited.txt')];
    await refresh();
    expect(host.querySelector(`[id$="-commit-${WORKING_ID}"]`)).not.toBeNull();
    expect((host.querySelector('.history-scroll') as HTMLElement).scrollTop).toBe(0);

    // A later status refresh (still the same working row) must not jump the reader back.
    await scrollTo(500);
    mocks.entries = [entry('edited.txt'), entry('second.txt')];
    await refresh();
    expect((host.querySelector('.history-scroll') as HTMLElement).scrollTop).toBe(500);
    await scrollTo(0);
    expect(host.querySelector(`[id$="-commit-${WORKING_ID}"] .subject`)?.textContent).toContain('2 paths');
  } finally {
    await act(async () => { root.unmount(); });
    host.remove(); toasts.remove();
    canvas.mockRestore(); globalThis.ResizeObserver = originalObserver;
  }
});
