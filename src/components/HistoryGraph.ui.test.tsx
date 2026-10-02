// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { layoutHistory } from '../graph/layout';
import { BUILTIN_THEMES } from '../model/themes';
import { DEFAULT_HISTORY_COLUMNS } from '../model/settings';
import { groupRefs, HistoryGraph, sortRefs } from './HistoryGraph';
import { WORKING_ID } from '../model/native';

vi.mock('../model/settings', async importOriginal => {
  const original = await importOriginal<typeof import('../model/settings')>();
  return { ...original, useSettings: () => ({ settings: { historyColumns: DEFAULT_HISTORY_COLUMNS }, updateSettings: vi.fn() }) };
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
