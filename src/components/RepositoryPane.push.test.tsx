// @vitest-environment jsdom
import { createRoot } from 'react-dom/client';
import { forwardRef, useImperativeHandle } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { RepositoryPane } from './RepositoryPane';
import { BUILTIN_THEMES } from '../model/themes';
import { ToastProvider } from './ui';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../model/settings', async original => ({ ...await original<typeof import('../model/settings')>(), useSettings: () => ({ theme: BUILTIN_THEMES[0], settings: { diffView: 'unified' } }) }));
vi.mock('../graph/useGraphLayout', () => ({ useGraphLayout: () => ({ layout: { nodes: [], edges: [], laneCount: 0 }, count: 2 }) }));
vi.mock('./RepositoryToolbar', () => ({ RepositoryToolbar: () => null }));
vi.mock('./NativeInspector', () => ({ NativeInspector: () => null }));
vi.mock('./HistoryGraph', () => ({ HistoryGraph: forwardRef<unknown, object>((_, ref) => {
  useImperativeHandle(ref, () => ({ anchor: () => null, restore() {}, focus() {}, scrollTo() {} }));
  return null;
}) }));

const state = { session: { handle: 'real', location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'main-tip', headRef: 'refs/heads/main' }, refs: [
  { name: 'main', fullName: 'refs/heads/main', kind: 'local', commitId: 'main-tip' },
  { name: 'topic', fullName: 'refs/heads/topic', kind: 'local', commitId: 'topic-tip' },
  { name: 'origin/topic', fullName: 'refs/remotes/origin/topic', kind: 'remote', commitId: 'origin-topic' },
], remotes: ['origin'], fingerprint: 'refs' };
const operation = { kind: 'none', label: '', current: null, incoming: null, step: null, total: null, conflicts: [], canContinue: false, canSkip: false, fingerprint: 'reviewed' };
const status = { head: 'main-tip', headRef: 'refs/heads/main', fingerprint: 'status', entries: [] };

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === 'repository_open' || command === 'repository_state') return state;
    if (command === 'repository_snapshot') return { state, status, operation };
    if (command === 'repository_operation_state') return operation;
    if (command === 'repository_branch_relation') return [1, 0];
    if (command === 'repository_sync_info') {
      const branch = typeof args.branch === 'string' ? args.branch : 'main';
      return { branch, upstream: `origin/${branch}`, ahead: branch === 'topic' ? 2 : 0, behind: 0, remotes: ['origin'] };
    }
    if (command === 'repository_history') return { commits: ['main-tip', 'topic-tip', 'origin-topic'].map(id => ({ id, parents: [], subject: id, author: 'Ada', email: 'ada@example.com', timestamp: 1 })), cursor: null, generation: 'g', shallow: false };
    if (command === 'repository_commit') return { id: 'main-tip', parents: [], subject: 'main', body: '', author: 'Ada', email: 'ada@example.com', timestamp: 1 };
    if (command === 'repository_diff_files') return [];
    if (command === 'repository_worktrees') return [];
    if (command === 'repository_remote_action') return { output: '' };
    return undefined;
  });
});

it.each([
  { branch: 'topic', eligible: true },
  { branch: 'topic', eligible: false },
  { branch: 'main', eligible: true },
])('pushes only the reviewed $branch source when eligibility remains $eligible', async ({ branch, eligible }) => {
  if (!eligible) {
    const invoke = mocks.invoke.getMockImplementation()!;
    let reads = 0;
    mocks.invoke.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === 'repository_sync_info' && args.branch === branch && ++reads > 1) {
        return Promise.resolve({ branch, upstream: `origin/${branch}`, ahead: 0, behind: 0, remotes: ['origin'] });
      }
      return invoke(command, args);
    });
  }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const toasts = document.createElement('div'); document.body.append(toasts);
  root.render(<ToastProvider value={toasts}><RepositoryPane tabId="t" location={{ kind: 'native', path: '/repo' }} active sidebarOpen inspectorOpen={false} inspectorWidth={400} sidebarWidth={240} setInspectorWidth={() => {}} setSidebarWidth={() => {}} setInspectorOpen={() => {}} onIdentity={() => {}} onBusyChange={() => {}} onMeta={() => {}} /></ToastProvider>);
  try {
    await vi.waitFor(() => expect(host.querySelector(`button[title="refs/heads/${branch}"]`)).not.toBeNull());
    host.querySelector(`button[title="refs/heads/${branch}"]`)!.closest('.ref-action-row')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
    const push = await vi.waitFor(() => {
      const button = [...host.querySelectorAll('button')].find(item => item.textContent === (branch === 'main' ? 'Push / Publish…' : `Push ${branch} to origin`));
      expect(button).toBeDefined();
      return button!;
    });
    push.click();
    if (!eligible) {
      await vi.waitFor(() => expect(document.body.textContent).toContain('Branch changed. Open its menu again before pushing.'));
      expect(mocks.invoke.mock.calls.some(([command, args]) => command === 'repository_remote_action' && (args as { action?: { kind?: string } }).action?.kind === 'push')).toBe(false);
      return;
    }
    const call = await vi.waitFor(() => {
      const found = mocks.invoke.mock.calls.find(([command, args]) => command === 'repository_remote_action' && (args as { action?: { kind?: string } }).action?.kind === 'push');
      expect(found).toBeDefined();
      return found!;
    });
    expect(call?.[1]).toEqual({ handle: 'real', action: branch === 'main' ? { kind: 'push', source: 'main' } : { kind: 'push', remote: 'origin', branch, source: branch } });
  } finally { root.unmount(); host.remove(); toasts.remove(); }
});
