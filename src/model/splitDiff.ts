import type { DiffHunk, DiffLine } from './repository';

export interface SplitDiffLine { line: DiffLine; index: number }
export interface SplitDiffRow { before?: SplitDiffLine; after?: SplitDiffLine; meta?: SplitDiffLine }

/** Pair change blocks by position for display only. Original indices are retained
 * because Git hunk/line operations address the original, unpaired diff. */
export function splitDiffRows(lines: DiffLine[]): SplitDiffRow[] {
  const rows: SplitDiffRow[] = [];
  let removed: SplitDiffLine[] = [];
  let added: SplitDiffLine[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) rows.push({ before: removed[i], after: added[i] });
    removed = []; added = [];
  };
  lines.forEach((line, index) => {
    const item = { line, index };
    if (line.kind === 'remove') removed.push(item);
    else if (line.kind === 'add') added.push(item);
    else {
      flush();
      rows.push(line.kind === 'meta' ? { meta: item } : { before: item, after: item });
    }
  });
  flush();
  return rows;
}

/** One rendered diff row. Hunk headers are rows too, so virtualization keeps their actions reachable.
 * Line rows keep the original `SplitDiffLine.index`; selection never addresses row positions. */
export type DiffRow =
  | { kind: 'hunk'; hunkIndex: number }
  | { kind: 'line'; hunkIndex: number; item: SplitDiffLine }
  | { kind: 'split'; hunkIndex: number; row: SplitDiffRow };

/** Flatten every hunk into one row list for the unified or split layout. */
export function diffRows(hunks: DiffHunk[], split: boolean): DiffRow[] {
  const rows: DiffRow[] = [];
  hunks.forEach((hunk, hunkIndex) => {
    rows.push({ kind: 'hunk', hunkIndex });
    if (split) for (const row of splitDiffRows(hunk.lines)) rows.push({ kind: 'split', hunkIndex, row });
    else hunk.lines.forEach((line, index) => rows.push({ kind: 'line', hunkIndex, item: { line, index } }));
  });
  return rows;
}

/** Prefix sums: `offsets[i]` is the top of row `i`; `offsets[count]` is the total height. */
export function rowOffsets(count: number, heightOf: (index: number) => number): Float64Array {
  const offsets = new Float64Array(count + 1);
  for (let i = 0; i < count; i++) offsets[i + 1] = offsets[i] + heightOf(i);
  return offsets;
}

/** The row containing vertical position `y`, clamped to existing rows (0 when there are none). */
export function rowAt(offsets: Float64Array, y: number): number {
  const count = offsets.length - 1;
  if (count <= 0) return 0;
  let low = 0, high = count - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (offsets[mid] <= y) low = mid; else high = mid - 1;
  }
  return low;
}

/** Rows to render for a viewport, padded by `overscan` and snapped to `step` so small scrolls reuse the window. */
export function visibleRows(offsets: Float64Array, top: number, height: number, overscan: number, step: number): { start: number; end: number } {
  const count = offsets.length - 1;
  if (count <= 0) return { start: 0, end: 0 };
  const first = rowAt(offsets, Math.max(0, top));
  const last = rowAt(offsets, Math.max(0, top + height));
  return { start: Math.max(0, Math.floor((first - overscan) / step) * step), end: Math.min(count, Math.ceil((last + 1 + overscan) / step) * step) };
}
