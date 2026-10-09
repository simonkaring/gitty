import type { DiffLine } from './repository';

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
