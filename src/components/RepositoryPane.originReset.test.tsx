// @vitest-environment jsdom
import { createRoot } from 'react-dom/client';
import { forwardRef, useImperativeHandle } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { RepositoryPane } from './RepositoryPane';
import { BUILTIN_THEMES } from '../model/themes';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../model/settings', async original => ({ ...await original<typeof import('../model/settings')>(), useSettings: () => ({ theme: BUILTIN_THEMES[0], settings: { diffView: 'unified' } }) }));
vi.mock('../graph/useGraphLayout', () => ({ useGraphLayout: () => ({ layout: { nodes: [], edges: [], laneCount: 0 }, count: 2 }) }));
vi.mock('./RepositoryToolbar', () => ({ RepositoryToolbar: () => null }));
vi.mock('./NativeInspector', () => ({ NativeInspector: () => null }));
vi.mock('./HistoryGraph', () => ({ HistoryGraph: forwardRef<unknown, { onSwitchBranch: (ref: string) => void }>((props, ref) => {
  useImperativeHandle(ref, () => ({ anchor: () => null, restore() {}, focus() {}, scrollTo() {} }));
  return <button data-testid="graph-origin" onDoubleClick={() => props.onSwitchBranch('refs/remotes/origin/main')}>origin/main</button>;
}) }));

let originTip = 'origin'; let dirty = false;
const state = () => ({ session: { handle: 'real', location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'local', headRef: 'refs/heads/main' }, refs: [
  { name: 'main', fullName: 'refs/heads/main', kind: 'local', commitId: 'local' },
  { name: 'origin/main', fullName: 'refs/remotes/origin/main', kind: 'remote', commitId: originTip },
], remotes: ['origin'], fingerprint: 'refs' });
const operation = { kind: 'none', label: '', current: null, incoming: null, step: null, total: null, conflicts: [], canContinue: false, canSkip: false, fingerprint: 'reviewed' };
const status = () => ({ head: 'local', headRef: 'refs/heads/main', fingerprint: 'status', entries: dirty ? [{ path: 'file', oldPath: null, indexStatus: '.', worktreeStatus: 'M', untracked: false, conflicted: false }] : [] });
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  originTip = 'origin'; dirty = false; mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === 'repository_open' || command === 'repository_state') return state();
    if (command === 'repository_snapshot') return { state: state(), status: status(), operation };
    if (command === 'repository_operation_state') return operation;
    if (command === 'repository_branch_relation') return [1, 0];
    if (command === 'repository_history') return { commits: ['local', 'origin'].map(id => ({ id, parents: [], subject: id, author: 'Ada', email: 'ada@example.com', timestamp: 1 })), cursor: null, generation: 'g', shallow: false };
    if (command === 'repository_commit') return { id: 'local', parents: [], subject: 'local', body: '', author: 'Ada', email: 'ada@example.com', timestamp: 1 };
    if (command === 'repository_diff_files') return [];
    if (command === 'repository_remote_action') return { output: '' };
    return undefined;
  });
});
it.each(['graph', 'sidebar'])('double-clicking current origin from %s reviews reset without writing', async route => {
  for (const scenario of ['different tip', 'same tip dirty', 'same tip clean']) {
    originTip = scenario === 'different tip' ? 'origin' : 'local'; dirty = scenario === 'same tip dirty';
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    root.render(<RepositoryPane tabId="t" location={{ kind: 'native', path: '/repo' }} active sidebarOpen inspectorOpen={false} inspectorWidth={400} sidebarWidth={240} setInspectorWidth={() => {}} setSidebarWidth={() => {}} setInspectorOpen={() => {}} onIdentity={() => {}} onBusyChange={() => {}} onMeta={() => {}} />);
    try {
      const selector = route === 'graph' ? '[data-testid="graph-origin"]' : '.ref-item[title="refs/remotes/origin/main"]';
      await vi.waitFor(() => expect(host.querySelector(selector)).not.toBeNull());
      host.querySelector(selector)!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      if (scenario === 'same tip clean') expect(host.querySelector('dialog')).toBeNull();
      else await vi.waitFor(() => expect(host.textContent).toContain('Reset main to origin/main?'));
      expect(mocks.invoke.mock.calls.filter(([command]) => command === 'repository_run_operation')).toHaveLength(0);
    } finally { root.unmount(); host.remove(); }
  }
});
