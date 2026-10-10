// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { laneX, layoutHistory } from '../graph/layout';
import { BUILTIN_THEMES } from '../model/themes';
import { DEFAULT_HISTORY_COLUMNS } from '../model/settings';
import { groupRefs, groupRefsByCommit, HistoryGraph, sortRefs } from './HistoryGraph';
import { WORKING_ID } from '../model/native';

const preferences = vi.hoisted(() => ({ graphAuthorAvatars: false, authorAvatarMode: 'initials' as 'initials' | 'gravatar', graphOnly: false }));
const avatarUrl = vi.hoisted(() => vi.fn(async () => 'https://gravatar.com/avatar/test?s=64&d=404'));
vi.mock('../model/gravatar', () => ({ gravatarUrl: avatarUrl, gravatarImageFailed: () => false, markGravatarImageFailed: vi.fn() }));
afterEach(() => { preferences.graphAuthorAvatars = false; preferences.authorAvatarMode = 'initials'; preferences.graphOnly = false; avatarUrl.mockClear(); });
vi.mock('../model/settings', async importOriginal => {
  const original = await importOriginal<typeof import('../model/settings')>();
  return { ...original, useSettings: () => ({ settings: { ...preferences, historyColumns: preferences.graphOnly ? DEFAULT_HISTORY_COLUMNS.map(column => ({ ...column, visible: column.id === 'graph' })) : DEFAULT_HISTORY_COLUMNS }, updateSettings: vi.fn() }) };
});

it('switches graph nodes between dots, initials and Gravatar while preserving working-tree and merge markers', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const originalObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} } as typeof ResizeObserver;
  const arc = vi.fn(), roundRect = vi.fn();
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(new Proxy({}, { get: (_, key) => key === 'arc' ? arc : key === 'roundRect' ? roundRect : () => {} }) as CanvasRenderingContext2D);
  const host = document.createElement('div'), root = createRoot(host);
  const commits = [
    { id: WORKING_ID, parents: ['merge'], subject: 'Working tree', body: '', author: 'Me', email: '', timestamp: 4, branch: 'main', files: [] },
    { id: 'merge', parents: ['a', 'b'], subject: 'Merge', body: '', author: 'Ada Lovelace', email: 'ada@example.com', timestamp: 3, branch: 'main', files: [] },
    { id: 'a', parents: [], subject: 'A', body: '', author: 'Ada Lovelace', email: 'ada@example.com', timestamp: 2, branch: 'main', files: [] },
    { id: 'b', parents: [], subject: 'B', body: '', author: 'Grace Hopper', email: 'grace@example.com', timestamp: 1, branch: 'topic', files: [] },
  ];
  const layout = { ...layoutHistory(commits), laneCount: 40 };
  const render = (pending = false) => act(async () => root.render(<HistoryGraph commits={commits} layout={pending ? layoutHistory([]) : layout} refs={[]} selectedId="merge" head="merge" loaded={commits.length} matches={new Set(['merge'])} onSelect={() => {}} onLoadMore={() => {}} onOpenDetails={() => {}} theme={BUILTIN_THEMES[0]} />));
  preferences.graphOnly = true;
  try {
    await render();
    expect(host.querySelector('.graph-avatar-node')).toBeNull();
    expect(arc).toHaveBeenCalled();
    preferences.graphAuthorAvatars = true;
    arc.mockClear(); roundRect.mockClear();
    await render();
    expect(host.querySelectorAll('.graph-avatar-node')).toHaveLength(3);
    expect(host.querySelector(`[id$="-commit-${WORKING_ID}"]`)).not.toBeNull();
    expect(host.querySelector(`[id$="-commit-${WORKING_ID}"] .graph-avatar-node`)).toBeNull();
    expect(host.querySelector('[id$="-commit-merge"] .graph-avatar-node.merge')?.textContent).toBe('AL');
    expect(host.querySelector('[id$="-commit-b"].dimmed .graph-avatar-node')?.textContent).toBe('GH');
    expect(arc).not.toHaveBeenCalled();
    expect(roundRect).toHaveBeenCalled();
    expect(avatarUrl).not.toHaveBeenCalled();
    const pan = host.querySelector('.graph-hscroll') as HTMLDivElement;
    await act(async () => { pan.scrollLeft = 18; pan.dispatchEvent(new Event('scroll', { bubbles: true })); });
    expect((host.querySelector('[id$="-commit-b"] .graph-avatar-node') as HTMLElement).style.left).toBe(`${laneX(0) + layout.nodes[3].lane * 30 - 18}px`);
    preferences.authorAvatarMode = 'gravatar';
    await render();
    expect(host.querySelectorAll('.graph-avatar-node img')).toHaveLength(3);
    await act(async () => { host.querySelector('[id$="-commit-b"] img')!.dispatchEvent(new Event('error')); });
    expect(host.querySelector('[id$="-commit-b"] img')).toBeNull();
    expect(host.querySelector('[id$="-commit-b"] .graph-avatar-node')?.textContent).toBe('GH');
    await render(true);
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(4);
    expect(host.querySelector('.graph-avatar-node')).toBeNull();
    preferences.graphAuthorAvatars = false;
    arc.mockClear();
    await render();
    expect(host.querySelector('.graph-avatar-node')).toBeNull();
    expect(arc).toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    canvas.mockRestore(); globalThis.ResizeObserver = originalObserver;
  }
});

it('renders pending history without drawing nodes the layout worker has not returned', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const originalObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} } as typeof ResizeObserver;
  const ctx = new Proxy({}, { get: () => () => {} }) as CanvasRenderingContext2D;
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<HistoryGraph commits={[{ id: 'a', parents: [], subject: 'Pending commit', body: '', author: 'Test', email: '', timestamp: 1, branch: 'main', files: [] }]} layout={layoutHistory([])} refs={[]} selectedId="a" head="a" loaded={1} matches={null} onSelect={() => {}} onLoadMore={() => {}} onOpenDetails={() => {}} theme={BUILTIN_THEMES[0]} />); });
    expect(host.querySelector('[role="option"]')?.textContent).toContain('Pending commit');
    expect(canvas).toHaveBeenCalled();
  } finally {
    await act(async () => { root.unmount(); });
    canvas.mockRestore();
    globalThis.ResizeObserver = originalObserver;
  }
});

it('sortRefs orders current branch, local, remote, tags', () => {
  {
    const r = (name: string, kind: 'local' | 'remote' | 'tag') => ({ name, kind, commitId: 'a', fullName: `refs/${kind}/${name}` });
    const sorted = sortRefs([r('v1', 'tag'), r('origin/x', 'remote'), r('x', 'local'), r('main', 'local')], 'refs/local/main');
    expect(sorted.map(ref => ref.name)).toEqual(['main', 'x', 'origin/x', 'v1']);
  }
});

it('groupRefs merges a local branch with its same-named remote ref', () => {
  const r = (name: string, kind: 'local' | 'remote' | 'tag') => ({ name, kind, commitId: 'a' });
  const groups = groupRefs([r('origin/x', 'remote'), r('x', 'local'), r('origin/y', 'remote'), r('v1', 'tag')]);
  expect(groups.map(g => [g.ref.name, g.remote?.name])).toEqual([['x', 'origin/x'], ['origin/y', undefined], ['v1', undefined]]);
});
it('groupRefsByCommit groups badges per commit and drops remote */HEAD aliases', () => {
  const r = (name: string, kind: 'local' | 'remote' | 'tag', commitId: string) => ({ name, kind, commitId });
  const refs = [r('main', 'local', 'a'), r('origin/main', 'remote', 'a'), r('origin/HEAD', 'remote', 'a'), r('v1', 'tag', 'b'), r('upstream/HEAD', 'remote', 'c'), r('HEAD', 'local', 'c')];
  const grouped = groupRefsByCommit(refs);
  expect([...grouped.keys()]).toEqual(['a', 'b', 'c']);
  expect(grouped.get('a')?.map(ref => ref.name)).toEqual(['main', 'origin/main']);
  expect(grouped.get('b')?.map(ref => ref.name)).toEqual(['v1']);
  // Only remote-kind refs are aliases; a local ref that merely ends in /HEAD is kept.
  expect(r('feature/HEAD', 'local', 'd')).toEqual(groupRefsByCommit([r('feature/HEAD', 'local', 'd')]).get('d')?.[0]);
  expect(grouped.get('missing')).toBeUndefined();
  expect(groupRefsByCommit([]).size).toBe(0);
});

it('only reallocates the graph canvas backing store when its pixel size changes', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const originalObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} } as typeof ResizeObserver;
  const clearRect = vi.fn();
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(new Proxy({}, { get: (_, key) => key === 'clearRect' ? clearRect : () => {} }) as CanvasRenderingContext2D);
  const widthAssignments = vi.fn(), heightAssignments = vi.fn();
  const originalWidth = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width')!, originalHeight = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height')!;
  Object.defineProperty(HTMLCanvasElement.prototype, 'width', { configurable: true, get: originalWidth.get, set(value) { widthAssignments(value); originalWidth.set!.call(this, value); } });
  Object.defineProperty(HTMLCanvasElement.prototype, 'height', { configurable: true, get: originalHeight.get, set(value) { heightAssignments(value); originalHeight.set!.call(this, value); } });
  const host = document.createElement('div'), root = createRoot(host);
  const commits = [{ id: 'a', parents: [], subject: 'A', body: '', author: 'Ada', email: '', timestamp: 1, branch: 'main', files: [] }];
  const render = (matches: Set<string> | null) => act(async () => root.render(<HistoryGraph commits={commits} layout={layoutHistory(commits)} refs={[]} selectedId="a" head="a" loaded={1} matches={matches} onSelect={() => {}} onLoadMore={() => {}} onOpenDetails={() => {}} theme={BUILTIN_THEMES[0]} />));
  try {
    await render(null);
    const widthWrites = widthAssignments.mock.calls.length, heightWrites = heightAssignments.mock.calls.length;
    expect(clearRect).toHaveBeenCalled();
    // A different matches set redraws the canvas (a fresh draw effect run) without touching its size.
    clearRect.mockClear();
    await render(new Set(['a']));
    expect(clearRect).toHaveBeenCalled();
    expect(widthAssignments).toHaveBeenCalledTimes(widthWrites);
    expect(heightAssignments).toHaveBeenCalledTimes(heightWrites);
  } finally {
    await act(async () => root.unmount());
    Object.defineProperty(HTMLCanvasElement.prototype, 'width', originalWidth); Object.defineProperty(HTMLCanvasElement.prototype, 'height', originalHeight);
    getContext.mockRestore(); globalThis.ResizeObserver = originalObserver;
  }
});

it.each(['refs/heads/topic', 'refs/remotes/origin/feature/topic'])('branch pill %s selects its tip and switches on double-click', async fullName => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const originalObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} } as typeof ResizeObserver;
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(new Proxy({}, { get: () => () => {} }) as CanvasRenderingContext2D);
  const host = document.createElement('div'); const root = createRoot(host);
  const commits = [{ id: 'tip', parents: [], subject: 'Tip', body: '', author: 'A', email: '', timestamp: 1, branch: 'topic', files: [] }];
  const onSelect = vi.fn(); const onActions = vi.fn(); const onContextActions = vi.fn(); const onSwitchBranch = vi.fn();
  try {
    await act(async () => { root.render(<HistoryGraph commits={commits} layout={layoutHistory(commits)} refs={[{ name: 'topic', fullName, kind: fullName.startsWith('refs/heads/') ? 'local' : 'remote', commitId: 'tip' }]} selectedId="tip" head="tip" headRef="refs/heads/main" loaded={1} matches={null} onSelect={onSelect} onActions={onActions} onContextActions={onContextActions} onSwitchBranch={onSwitchBranch} onLoadMore={() => {}} onOpenDetails={() => {}} theme={BUILTIN_THEMES[0]} />); });
    const pill = host.querySelector('.ref-pill') as HTMLElement;
    await act(async () => { pill.click(); });
    await act(async () => { pill.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await act(async () => { pill.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })); });
    expect(onSelect.mock.calls).toEqual([['tip'], ['tip'], ['tip']]);
    expect(onActions).not.toHaveBeenCalled();
    await act(async () => { pill.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 1, clientY: 2 })); });
    await act(async () => { pill.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true })); });
    expect(onContextActions).toHaveBeenCalledTimes(2);
    await act(async () => { pill.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(onSwitchBranch).toHaveBeenCalledWith(fullName);
  } finally {
    await act(async () => { root.unmount(); });
    canvas.mockRestore(); globalThis.ResizeObserver = originalObserver;
  }
});
it('renders graph nodes without selection halo, HEAD glow, or HEAD center dot', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const originalObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} } as typeof ResizeObserver;

  const drawnArcs: { x: number; y: number; radius: number }[] = [];
  let roundRectCalls = 0;
  const ctx = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    bezierCurveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    arc: vi.fn((x: number, y: number, radius: number) => {
      drawnArcs.push({ x, y, radius });
    }),
    roundRect: vi.fn(() => {
      roundRectCalls++;
    }),
  } as unknown as CanvasRenderingContext2D;

  const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
  const host = document.createElement('div');
  const root = createRoot(host);

  const commits = [
    { id: WORKING_ID, parents: ['head-1'], subject: 'Working tree', body: '', author: 'Me', email: '', timestamp: 4, branch: 'main', files: [] },
    { id: 'head-1', parents: ['merge-1'], subject: 'HEAD commit', body: '', author: 'Me', email: '', timestamp: 3, branch: 'main', files: [] },
    { id: 'merge-1', parents: ['c-1', 'c-2'], subject: 'Merge commit', body: '', author: 'Me', email: '', timestamp: 2, branch: 'main', files: [] },
    { id: 'c-1', parents: [], subject: 'Root commit', body: '', author: 'Me', email: '', timestamp: 1, branch: 'main', files: [] },
  ];
  const layout = layoutHistory(commits);

  try {
    let selected = 'head-1';
    await act(async () => {
      root.render(
        <HistoryGraph
          commits={commits}
          layout={layout}
          refs={[{ name: 'main', kind: 'local', commitId: 'head-1', fullName: 'refs/heads/main' }]}
          selectedId={selected}
          head="head-1"
          loaded={commits.length}
          matches={null}
          onSelect={id => { selected = id; }}
          onLoadMore={() => {}}
          onOpenDetails={() => {}}
          theme={BUILTIN_THEMES[0]}
        />
      );
    });

    expect(canvas).toHaveBeenCalled();
    // No .graph-head-pulse element rendered
    expect(host.querySelector('.graph-head-pulse')).toBeNull();
    // No halo (radius 11) or HEAD center dot (radius 2)
    expect(drawnArcs.some(a => a.radius === 11)).toBe(false);
    expect(drawnArcs.some(a => a.radius === 2)).toBe(false);
    // Standard node radii: 5 for normal commits and 5.5 for merge commits
    expect(drawnArcs.some(a => a.radius === 5)).toBe(true);
    expect(drawnArcs.some(a => a.radius === 5.5)).toBe(true);
    // Working tree drawn as roundRect
    expect(roundRectCalls).toBeGreaterThan(0);

    // Verify option selection updates and decorations remain absent
    drawnArcs.length = 0;
    await act(async () => {
      root.render(
        <HistoryGraph
          commits={commits}
          layout={layout}
          refs={[{ name: 'main', kind: 'local', commitId: 'head-1', fullName: 'refs/heads/main' }]}
          selectedId="c-1"
          head="head-1"
          loaded={commits.length}
          matches={null}
          onSelect={id => { selected = id; }}
          onLoadMore={() => {}}
          onOpenDetails={() => {}}
          theme={BUILTIN_THEMES[0]}
        />
      );
    });
    expect(host.querySelector('.graph-head-pulse')).toBeNull();
    expect(drawnArcs.some(a => a.radius === 11)).toBe(false);
    expect(drawnArcs.some(a => a.radius === 2)).toBe(false);
  } finally {
    await act(async () => { root.unmount(); });
    canvas.mockRestore();
    globalThis.ResizeObserver = originalObserver;
  }
});

it('gives every mounted history graph unique ids so hidden tabs sharing commits do not collide', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const originalObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} } as typeof ResizeObserver;
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(new Proxy({}, { get: () => () => {} }) as CanvasRenderingContext2D);
  const commits = [{ id: 'shared', parents: [], subject: 'Shared', body: '', author: 'A', email: '', timestamp: 1, branch: 'main', files: [] }];
  const hosts = [document.createElement('div'), document.createElement('div')];
  const roots = hosts.map(host => { document.body.append(host); return createRoot(host); });
  try {
    await act(async () => { roots.forEach(root => root.render(<HistoryGraph commits={commits} layout={layoutHistory(commits)} refs={[]} selectedId="shared" head="shared" loaded={1} matches={null} onSelect={() => {}} onLoadMore={() => {}} onOpenDetails={() => {}} theme={BUILTIN_THEMES[0]} />)); });
    const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
    expect(ids.length).toBeGreaterThanOrEqual(4);
    expect(new Set(ids).size).toBe(ids.length);
    for (const host of hosts) {
      const listbox = host.querySelector('[role="listbox"]')!;
      const option = host.querySelector('[role="option"]')!;
      expect(listbox.getAttribute('aria-activedescendant')).toBe(option.id);
      expect(host.contains(document.getElementById(listbox.getAttribute('aria-activedescendant')!))).toBe(true);
      expect(host.contains(document.getElementById(listbox.getAttribute('aria-describedby')!))).toBe(true);
    }
  } finally {
    await act(async () => { roots.forEach(root => root.unmount()); });
    hosts.forEach(host => host.remove());
    canvas.mockRestore(); globalThis.ResizeObserver = originalObserver;
  }
});

async function mountRovingGraph() {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const originalObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} } as typeof ResizeObserver;
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(new Proxy({}, { get: () => () => {} }) as CanvasRenderingContext2D);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const commits = [
    { id: 'tip', parents: ['base'], subject: 'Tip', body: '', author: 'A', email: '', timestamp: 2, branch: 'main', files: [] },
    { id: 'base', parents: [], subject: 'Base', body: '', author: 'A', email: '', timestamp: 1, branch: 'main', files: [] },
  ];
  const refs = [{ name: 'main', fullName: 'refs/heads/main', kind: 'local' as const, commitId: 'tip' }, { name: 'dev', fullName: 'refs/heads/dev', kind: 'local' as const, commitId: 'tip' }, { name: 'v1', fullName: 'refs/tags/v1', kind: 'tag' as const, commitId: 'tip' }];
  const handlers = { onSelect: vi.fn(), onActions: vi.fn(), onContextActions: vi.fn(), onTogglePick: vi.fn(), onOpenDetails: vi.fn() };
  const render = (selectedId = 'tip') => act(async () => root.render(<HistoryGraph commits={commits} layout={layoutHistory(commits)} refs={refs} selectedId={selectedId} head="tip" headRef="refs/heads/main" loaded={commits.length} matches={null} onLoadMore={() => {}} theme={BUILTIN_THEMES[0]} pickOrder={[]} {...handlers} />));
  await render();
  const listbox = host.querySelector('[role="listbox"]') as HTMLElement;
  const key = (init: KeyboardEventInit) => act(async () => { listbox.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); });
  const activeId = () => listbox.getAttribute('aria-activedescendant');
  const cleanup = async () => { await act(async () => root.unmount()); host.remove(); canvas.mockRestore(); globalThis.ResizeObserver = originalObserver; };
  return { host, listbox, key, activeId, handlers, render, cleanup };
}

it('keeps the history listbox the only tab stop: no element inside an option is focusable by Tab', async () => {
  const { host, cleanup } = await mountRovingGraph();
  try {
    const listbox = host.querySelector('[role="listbox"]') as HTMLElement;
    expect(listbox.tabIndex).toBe(0);
    const inner = [...host.querySelectorAll('[role="option"] *')] as HTMLElement[];
    expect(inner.some(element => element.matches('.ref-pill, .ref-more, .graph-pick, .graph-action-button'))).toBe(true);
    expect(inner.filter(element => element.tabIndex >= 0)).toEqual([]);
    // Controls stay clickable and labelled.
    expect(host.querySelector('.graph-pick')?.getAttribute('aria-label')).toMatch(/^Cherry-pick/);
    expect(host.querySelector('.graph-action-button')?.getAttribute('aria-label')).toMatch(/^Actions for/);
    expect(host.querySelector('.ref-pill')?.getAttribute('aria-label')).toMatch(/^Select tip of/);
  } finally { await cleanup(); }
});

it('moves an active control through the selected row with ArrowRight/ArrowLeft and activates it with Enter/Space', async () => {
  const { host, listbox, key, activeId, handlers, cleanup } = await mountRovingGraph();
  try {
    const rowId = host.querySelector('[id$="-commit-tip"]')!.id;
    expect(activeId()).toBe(rowId);
    const controls = [...host.querySelectorAll('#' + CSS.escape(rowId) + ' [data-row-control]')] as HTMLElement[];
    expect(controls.map(control => control.className.split(' ')[0])).toEqual(['ref-pill', 'ref-pill', 'ref-pill', 'graph-pick', 'icon-button']);
    expect(controls.map(control => control.id)).toEqual([0, 1, 2, 3, 4].map(n => `${rowId}-ctl-${n}`));

    await key({ key: 'ArrowRight' });
    expect(activeId()).toBe(`${rowId}-ctl-0`);
    expect(controls[0].classList.contains('row-control-active')).toBe(true);
    expect(document.activeElement === listbox || document.activeElement === document.body).toBe(true);
    await key({ key: 'Enter' });
    expect(handlers.onSelect).toHaveBeenCalledWith('tip');
    expect(handlers.onOpenDetails).not.toHaveBeenCalled();

    await key({ key: 'ArrowRight' }); await key({ key: 'ArrowRight' }); await key({ key: 'ArrowRight' });
    expect(activeId()).toBe(`${rowId}-ctl-3`);
    expect(controls.filter(control => control.classList.contains('row-control-active'))).toEqual([controls[3]]);
    await key({ key: ' ' });
    expect(handlers.onTogglePick).toHaveBeenCalledWith('tip');

    await key({ key: 'ArrowRight' });
    expect(activeId()).toBe(`${rowId}-ctl-4`);
    await key({ key: 'Enter' });
    expect(handlers.onActions).toHaveBeenCalledWith({ oid: 'tip' });

    // Wraps back to the row, and ArrowLeft goes the other way.
    await key({ key: 'ArrowRight' });
    expect(activeId()).toBe(rowId);
    await key({ key: 'ArrowLeft' });
    expect(activeId()).toBe(`${rowId}-ctl-4`);
    await key({ key: 'Enter' });
    expect(handlers.onActions).toHaveBeenCalledTimes(2);
  } finally { await cleanup(); }
});

it('opens the branch menu for an active ref pill via Shift+F10 and resets the active control on Escape or vertical movement', async () => {
  const { host, key, activeId, handlers, render, cleanup } = await mountRovingGraph();
  try {
    const rowId = host.querySelector('[id$="-commit-tip"]')!.id;
    await key({ key: 'ArrowRight' }); await key({ key: 'ArrowRight' });
    expect(activeId()).toBe(`${rowId}-ctl-1`);
    await key({ key: 'F10', shiftKey: true });
    expect(handlers.onContextActions).toHaveBeenCalledTimes(1);
    expect(handlers.onContextActions.mock.calls[0].slice(0, 1)).toEqual([{ oid: 'tip', ref: 'refs/heads/dev' }]);
    expect(handlers.onContextActions.mock.calls[0][3]).toBe(host.querySelector(`#${CSS.escape(rowId)}-ctl-1`));

    await key({ key: 'Escape' });
    expect(activeId()).toBe(rowId);
    expect(host.querySelector('.row-control-active')).toBeNull();
    // Without an active control, Shift+F10 still opens the commit menu.
    await key({ key: 'F10', shiftKey: true });
    expect(handlers.onContextActions).toHaveBeenLastCalledWith({ oid: 'tip' }, expect.any(Number), expect.any(Number), expect.anything());

    await key({ key: 'ArrowRight' });
    expect(activeId()).toBe(`${rowId}-ctl-0`);
    await key({ key: 'ArrowDown' });
    expect(handlers.onSelect).toHaveBeenLastCalledWith('base');
    expect(activeId()).toBe(rowId);
    // Selection changing (e.g. by mouse) also drops the active control.
    await key({ key: 'ArrowRight' });
    await render('base');
    expect(host.querySelector('.row-control-active')).toBeNull();
    expect(activeId()).toBe(host.querySelector('[id$="-commit-base"]')!.id);
  } finally { await cleanup(); }
});
