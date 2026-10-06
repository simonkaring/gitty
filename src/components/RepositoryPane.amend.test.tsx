// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client';
import { forwardRef, useImperativeHandle } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BUILTIN_THEMES } from '../model/themes';
import { RepositoryPane } from './RepositoryPane';
import { ToastProvider } from './ui';

// The pane runs against its real model code (native.ts, workflow.ts) with only the Tauri boundary scripted.
const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  graph: { scrollTo: vi.fn(), focus: vi.fn(), anchor: vi.fn((): { id: string; offset: number } | null => null), restore: vi.fn() },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../model/settings', async importOriginal => ({ ...await importOriginal<typeof import('../model/settings')>(), useSettings: () => ({ theme: BUILTIN_THEMES[0], settings: { diffView: 'unified' } }) }));
vi.mock('../graph/useGraphLayout', () => ({ useGraphLayout: (commits: unknown[]) => ({ layout: { nodes: [], edges: [], laneCount: 0, edgeMaxTo: new Int32Array() }, count: commits.length }) }));
vi.mock('./RepositoryToolbar', () => ({ RepositoryToolbar: () => null }));
vi.mock('./HistoryGraph', () => ({
  HistoryGraph: forwardRef<unknown, { commits: { id: string }[]; selectedId: string; onSelect: (id: string) => void }>((props, ref) => {
    useImperativeHandle(ref, () => mocks.graph);
    return <div data-testid="graph" data-selected={props.selectedId} data-loaded={props.commits.length}>
      {props.commits.slice(0, 6).map(commit => <button key={commit.id} data-commit={commit.id} onClick={() => props.onSelect(commit.id)}>{commit.id}</button>)}
    </div>;
  }),
}));

const TOTAL = 450;
const PAGE = 200;
type Fake = { head: string; ids: string[]; failSnapshot: boolean; amend: () => Promise<unknown> };
let repo: Fake = { head: '', ids: [], failSnapshot: false, amend: async () => undefined };
const none = { kind: 'none', label: '', current: null, incoming: null, step: null, total: null, conflicts: [], canContinue: false, canSkip: false, fingerprint: 'none' };
const setHead = (head: string) => { repo.ids = [head, ...Array.from({ length: TOTAL - 1 }, (_, i) => `k${i + 1}`)]; repo.head = head; };
const commit = (index: number) => ({ id: repo.ids[index], parents: index + 1 < repo.ids.length ? [repo.ids[index + 1]] : [], subject: `Subject ${repo.ids[index]}`, author: 'Ada', email: 'ada@example.com', timestamp: 100 - index });
const state = () => ({ session: { handle: 'real', location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: repo.head, headRef: 'refs/heads/main' }, refs: [], remotes: [], fingerprint: `fp-${repo.head}` });
const status = () => ({ entries: [], head: repo.head, headRef: 'refs/heads/main', fingerprint: 'status-1' });
const calls = (name: string) => mocks.invoke.mock.calls.filter(([command]) => command === name);
const history = () => calls('repository_history').length;

beforeEach(() => {
  setHead('h1'); repo.failSnapshot = false;
  repo.amend = async () => { setHead('h2'); return { oid: 'h2' }; };
  mocks.graph.anchor.mockReturnValue(null);
  mocks.invoke.mockImplementation(async (command, args = {}) => {
    switch (command) {
      case 'repository_open': return state();
      case 'repository_snapshot': if (repo.failSnapshot) throw { code: 'git', message: 'Snapshot unavailable' }; return { state: state(), status: status(), operation: none };
      case 'repository_state': return state();
      case 'repository_status': return status();
      case 'repository_history': {
        const start = args.cursor ? Number(String(args.cursor).split(':')[1]) : 0;
        const end = Math.min(start + PAGE, repo.ids.length);
        return { commits: Array.from({ length: end - start }, (_, i) => commit(start + i)), cursor: end < repo.ids.length ? `${repo.head}:${end}` : null, generation: `walk-${repo.head}`, shallow: false };
      }
      case 'repository_commit': {
        const index = repo.ids.indexOf(String(args.oid));
        const found = index >= 0 ? commit(index) : { ...commit(0), id: String(args.oid) };
        return { ...found, body: `Subject ${found.id}\n\nBody`, canEditMessage: found.id === repo.head, editDisabledReason: found.id === repo.head ? null : 'Only HEAD.' };
      }
      case 'repository_diff_files': return [];
      case 'repository_amend_commit': return repo.amend();
      default: return undefined;
    }
  });
});
afterEach(() => { vi.clearAllMocks(); });

const props = { tabId: 't', location: { kind: 'native', path: '/repo' } as const, active: true, sidebarOpen: false, inspectorOpen: true, inspectorWidth: 400, sidebarWidth: 240, setInspectorWidth() {}, setSidebarWidth() {}, setInspectorOpen() {}, onIdentity() {}, onBusyChange() {}, onMeta() {} };
async function mount() {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  const host = document.createElement('div');
  document.body.append(host);
  const toasts = document.createElement('div');
  document.body.append(toasts);
  const root: Root = createRoot(host);
  root.render(<ToastProvider value={toasts}><RepositoryPane {...props} /></ToastProvider>);
  const q = <T extends Element>(selector: string) => host.querySelector<T>(selector);
  const selected = () => q('[data-testid="graph"]')?.getAttribute('data-selected');
  await vi.waitFor(() => expect(q('h2.editable-commit-heading')?.textContent).toBe('Subject h1'));
  const type = (el: HTMLInputElement, value: string) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const api = {
    host, toasts, q, selected,
    click: (id: string) => q<HTMLButtonElement>(`[data-commit="${id}"]`)!.click(),
    /** Opens the inline editor on HEAD, changes the subject and presses Save. */
    async save(subject = 'Reworded') {
      q<HTMLElement>('h2.editable-commit-heading')!.click();
      await vi.waitFor(() => expect(q('form.commit-message-editor')).not.toBeNull());
      type(q<HTMLInputElement>('.commit-message-editor input')!, subject);
      await vi.waitFor(() => expect(q<HTMLButtonElement>('.commit-message-editor button[type="submit"]')!.disabled).toBe(false));
      q<HTMLFormElement>('form.commit-message-editor')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    },
    cleanup: async () => { root.unmount(); host.remove(); toasts.remove(); },
  };
  await vi.waitFor(() => expect(selected()).toBe('h1'));
  mocks.invoke.mockClear();
  return api;
}

it('follows an amended HEAD in one page: remaps the walk and scroll anchor, then selects and reveals the new commit', async () => {
  const t = await mount();
  try {
    mocks.graph.anchor.mockReturnValue({ id: 'h1', offset: 12 });
    await t.save();
    await vi.waitFor(() => expect(t.selected()).toBe('h2'));
    // The amend request carried the flags and expectations the plan requires, exactly once.
    expect(calls('repository_amend_commit')).toEqual([['repository_amend_commit', { handle: 'real', message: 'Reworded\n\nBody', expectedHead: 'h1', expectedHeadRef: 'refs/heads/main', expectedStatusFingerprint: 'status-1', messageOnly: true, requireUnpushed: true }]]);
    // 450 commits exist but the unreachable old tip was never searched for.
    expect(history()).toBe(1);
    expect(t.q('[data-testid="graph"]')?.getAttribute('data-loaded')).toBe(String(PAGE));
    expect(t.q('[data-commit="h2"]')).not.toBeNull();
    expect(t.q('[data-commit="h1"]')).toBeNull();
    // The anchor captured on the old tip is restored on the new one, offset intact.
    expect(mocks.graph.restore).toHaveBeenCalledWith({ id: 'h2', offset: 12 });
    expect(mocks.graph.scrollTo).toHaveBeenCalledWith(0);
    await vi.waitFor(() => expect(t.q('h2.editable-commit-heading')?.textContent).toBe('Subject h2'));
    expect(t.q('form.commit-message-editor')).toBeNull();
  } finally { await t.cleanup(); }
});

it('does not take the selection back after the user navigated away, even if they came back to the same commit', async () => {
  for (const route of [['k3'], ['k3', 'h1']]) {
    const t = await mount();
    try {
      let finish!: () => void;
      repo.amend = () => new Promise(resolve => { finish = () => { setHead('h2'); resolve({ oid: 'h2' }); }; });
      await t.save();
      await vi.waitFor(() => expect(calls('repository_amend_commit')).toHaveLength(1));
      for (const id of route) t.click(id);
      await vi.waitFor(() => expect(t.selected()).toBe(route.at(-1)));
      mocks.graph.scrollTo.mockClear();
      finish();
      await vi.waitFor(() => expect(t.q('[data-commit="h2"]')).not.toBeNull());
      await vi.waitFor(() => expect(t.q('form.commit-message-editor')).toBeNull());
      // The refreshed history shows the new tip, but the user's own selection is left alone and not scrolled.
      expect(t.selected()).toBe(route.at(-1));
      expect(mocks.graph.scrollTo).not.toHaveBeenCalled();
    } finally { await t.cleanup(); mocks.invoke.mockClear(); mocks.graph.scrollTo.mockClear(); setHead('h1'); }
  }
});

it('leaves an explicit comparison untouched when HEAD is amended', async () => {
  const t = await mount();
  try {
    [...t.host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Set as compare base')!.click();
    await vi.waitFor(() => expect(t.host.textContent).toContain('Base: h1 → Target: not selected'));
    await t.save();
    await vi.waitFor(() => expect(t.selected()).toBe('h2'));
    expect(t.host.textContent).toContain('Base: h1 → Target: not selected');
  } finally { await t.cleanup(); }
});

it('does not follow, remap or reveal when the refresh after an amend fails', async () => {
  const t = await mount();
  try {
    repo.amend = async () => { setHead('h2'); repo.failSnapshot = true; return { oid: 'h2' }; };
    await t.save();
    await vi.waitFor(() => expect(t.host.textContent).toContain('Further writes are blocked until a successful refresh'));
    expect(t.selected()).toBe('h1');
    expect(mocks.graph.scrollTo).not.toHaveBeenCalled();
    expect(t.toasts.textContent).toContain('Snapshot unavailable');
  } finally { await t.cleanup(); }
});

it('does not remap or follow a write that reported no new commit, and reconciles by looking for the old tip', async () => {
  const t = await mount();
  try {
    repo.amend = async () => { setHead('h2'); throw { code: 'mutationUnverified', message: 'Git reported a failure but HEAD moved to h2. Refresh and check the status before retrying.' }; };
    await t.save();
    await vi.waitFor(() => expect(t.q('.commit-message-editor [role="alert"]')?.textContent).toContain('HEAD moved to h2'));
    // Without a confirmed oid nothing is guessed: the old tip is searched for across the whole history.
    expect(history()).toBe(Math.ceil(TOTAL / PAGE));
    expect(t.selected()).toBe('h1');
    expect(calls('repository_amend_commit')).toHaveLength(1);
  } finally { await t.cleanup(); }
});

it('stops searching for an inspector-only orphan on later refreshes', async () => {
  const t = await mount();
  try {
    // The user keeps looking at the old tip while the amend lands, so it becomes an orphan.
    let finish!: () => void;
    repo.amend = () => new Promise(resolve => { finish = () => { setHead('h2'); resolve({ oid: 'h2' }); }; });
    await t.save();
    await vi.waitFor(() => expect(calls('repository_amend_commit')).toHaveLength(1));
    t.click('k2'); t.click('h1');
    finish();
    await vi.waitFor(() => expect(t.q('[data-commit="h2"]')).not.toBeNull());
    expect(t.selected()).toBe('h1');
    expect(t.toasts.textContent).toContain('Its inspector remains open by object ID');

    // A later refresh with a moved HEAD: the orphan was not in the loaded history, so it is not searched for.
    mocks.invoke.mockClear();
    setHead('h3');
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(t.q('[data-commit="h3"]')).not.toBeNull());
    expect(history()).toBe(1);
    expect(t.selected()).toBe('h1');
  } finally { await t.cleanup(); }
});
