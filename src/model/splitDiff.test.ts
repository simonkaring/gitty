import { expect, it } from 'vitest';
import type { DiffLine } from './repository';
import { splitDiffRows } from './splitDiff';

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
