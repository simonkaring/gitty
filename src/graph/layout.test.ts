import { describe, expect, it } from 'vitest';
import { createDemoHistory } from '../model/demo';
import { indexEdges, layoutHistory, visibleEdges } from './layout';

describe('history topology and lane reservations', () => {
  const history = createDemoHistory();
  const layout = layoutHistory(history.commits);
  it('has deterministic unique IDs, valid parents, merges and an octopus merge', () => {
    expect(createDemoHistory()).toEqual(history);
    expect(new Set(history.commits.map(c => c.id)).size).toBe(history.commits.length);
    const rows = new Map(history.commits.map((c, row) => [c.id, row]));
    history.commits.forEach((c, row) => {
      expect(c.id).toMatch(/^[a-f0-9]{40}$/);
      c.parents.forEach(p => expect(rows.get(p)).toBeGreaterThan(row));
    });
    expect(history.commits.some(c => c.parents.length === 3)).toBe(true);
    expect(history.commits.filter(c => c.parents.length === 0)).toHaveLength(1);
    history.refs.forEach(ref => expect(rows.has(ref.commitId)).toBe(true));
  });
  it('represents every parent relation with correct endpoints', () => {
    expect(layout.edges).toHaveLength(history.commits.reduce((n, c) => n + c.parents.length, 0));
    layout.edges.forEach(edge => {
      expect(layout.nodes[edge.fromRow].id).toBe(edge.from);
      expect(layout.nodes[edge.toRow].id).toBe(edge.to);
      expect(edge.fromRow).toBeLessThan(edge.toRow);
      expect(edge.track).toBeGreaterThanOrEqual(0);
    });
  });
  it('never routes a reserved track through an unrelated commit', () => {
    for (const edge of layout.edges) {
      for (let row = edge.fromRow + 1; row < edge.toRow; row++) {
        expect(layout.nodes[row].lane, `${edge.from} → ${edge.to} at row ${row}`).not.toBe(edge.track);
      }
    }
    expect(layout.laneCount).toBeLessThanOrEqual(8);
  });
  it('keeps nodes and existing edge tracks stable when older history is appended', () => {
    for (const size of [1, 17, 240, 481]) {
      const prefix = layoutHistory(history.commits.slice(0, size));
      expect(prefix.nodes).toEqual(layout.nodes.slice(0, size));
      expect(prefix.edges.map(({ toRow: _r, toLane: _l, ...e }) => e))
        .toEqual(layout.edges.filter(e => e.fromRow < size).map(({ toRow: _r, toLane: _l, ...e }) => e));
    }
  });
  it('handles roots, missing parents, convergence, disconnected and invalid histories', () => {
    expect(layoutHistory([]).nodes).toEqual([]);
    const small = layoutHistory([
      { id: 'a', parents: ['c', 'b'] }, { id: 'b', parents: ['c'] },
      { id: 'other', parents: [] }, { id: 'c', parents: ['missing'] },
    ]);
    expect(small.edges.at(-1)?.toRow).toBe(4);
    expect(() => layoutHistory([{ id: 'a', parents: ['a'] }])).toThrow();
    expect(() => layoutHistory([{ id: 'a', parents: [] }, { id: 'a', parents: [] }])).toThrow();
    expect(() => layoutHistory([{ id: 'a', parents: [] }, { id: 'b', parents: ['a'] }])).toThrow();
  });
  it('includes long edges crossing the viewport with neither endpoint visible', () => {
    const edge = { from: 'a', to: 'z', fromRow: 0, toRow: 100, fromLane: 0, toLane: 0, track: 0 };
    expect(visibleEdges([edge], 40, 60)).toEqual([edge]);
    expect(visibleEdges([edge], 101, 120)).toEqual([]);
  });
  it('indexed clipping matches the complete scan across merge and unloaded boundaries', () => {
    for (const size of [0, 1, 240, history.commits.length]) {
      const { edges } = layoutHistory(history.commits.slice(0, size));
      const visible = indexEdges(edges);
      for (let row = -10; row <= size + 30; row += 17) {
        expect(visible(row, row + 25)).toEqual(visibleEdges(edges, row, row + 25));
      }
    }
  });
});
