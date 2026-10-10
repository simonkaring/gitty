import { expect, it } from 'vitest';
import type { DiffLine } from './repository';
import { diffRows, rowAt, rowOffsets, splitDiffRows, visibleRows } from './splitDiff';

const line = (kind: DiffLine['kind'], content: string, oldLine: number | null = null, newLine: number | null = null): DiffLine => ({ kind, content, oldLine, newLine });

it('aligns replacement blocks and unequal change counts without losing original indices', () => {
  const lines = [line('context', 'context', 1, 1), line('remove', 'old A', 2), line('remove', 'old B', 3), line('add', 'new A', null, 2), line('context', 'tail', 4, 3), line('add', 'extra', null, 4)];
  const rows = splitDiffRows(lines);
  expect(rows.map(row => [row.before?.index, row.after?.index])).toEqual([[0, 0], [1, 3], [2, undefined], [4, 4], [undefined, 5]]);
  expect(rows[1].before?.line.content).toBe('old A');
  expect(rows[1].after?.line.content).toBe('new A');
});

it('keeps no-newline metadata at its original boundary instead of folding it into code', () => {
  const lines = [line('remove', 'old', 1), line('meta', '\\ No newline at end of file'), line('add', 'new', null, 1), line('meta', '\\ No newline at end of file')];
  expect(splitDiffRows(lines).map(row => [row.before?.index, row.after?.index, row.meta?.index])).toEqual([[0, undefined, undefined], [undefined, undefined, 1], [undefined, 2, undefined], [undefined, undefined, 3]]);
  expect(splitDiffRows([])).toEqual([]);
});

it('flattens hunks into header and line rows that keep original line indices in both layouts', () => {
  const hunks = [
    { header: '@@ a @@', lines: [line('context', 'c', 1, 1), line('remove', 'old', 2), line('add', 'new', null, 2)] },
    { header: '@@ b @@', lines: [line('add', 'tail', null, 9), line('meta', '\\ No newline at end of file')] },
  ];
  const unified = diffRows(hunks, false);
  expect(unified.map(row => row.kind === 'line' ? [row.hunkIndex, row.item.index] : row.kind)).toEqual(['hunk', [0, 0], [0, 1], [0, 2], 'hunk', [1, 0], [1, 1]]);
  const split = diffRows(hunks, true);
  expect(split.map(row => row.kind === 'split' ? [row.hunkIndex, row.row.before?.index, row.row.after?.index, row.row.meta?.index] : row.kind)).toEqual(['hunk', [0, 0, 0, undefined], [0, 1, 2, undefined], 'hunk', [1, undefined, 0, undefined], [1, undefined, undefined, 1]]);
  expect(diffRows([], true)).toEqual([]);
});

it('locates rows by offset and pads the visible window with snapped overscan', () => {
  const offsets = rowOffsets(5, index => index === 0 ? 30 : 10);
  expect([...offsets]).toEqual([0, 30, 40, 50, 60, 70]);
  expect([rowAt(offsets, -5), rowAt(offsets, 0), rowAt(offsets, 29.9), rowAt(offsets, 30), rowAt(offsets, 69), rowAt(offsets, 500)]).toEqual([0, 0, 0, 1, 4, 4]);
  expect(rowAt(rowOffsets(0, () => 10), 50)).toBe(0);
  const many = rowOffsets(1000, () => 20);
  expect(visibleRows(many, 10_000, 600, 30, 10)).toEqual({ start: 470, end: 570 });
  expect(visibleRows(many, 0, 600, 30, 10)).toEqual({ start: 0, end: 70 });
  expect(visibleRows(many, 19_990, 600, 30, 10)).toEqual({ start: 960, end: 1000 });
  expect(visibleRows(rowOffsets(0, () => 20), 0, 600, 30, 10)).toEqual({ start: 0, end: 0 });
});
