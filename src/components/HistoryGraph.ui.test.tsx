// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { layoutHistory } from '../graph/layout';
import { BUILTIN_THEMES } from '../model/themes';
import { DEFAULT_HISTORY_COLUMNS } from '../model/settings';
import { HistoryGraph, sortRefs } from './HistoryGraph';

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
