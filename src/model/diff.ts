export interface DiffLine { kind: 'context' | 'add' | 'remove'; text: string; oldLine?: number; newLine?: number }

/** Small LCS diff for synthetic text fixtures. Native diffs will come from Git. */
export function diffLines(before: string[], after: string[]): DiffLine[] {
  const lengths = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));
  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--)
      lengths[i][j] = before[i] === after[j] ? 1 + lengths[i + 1][j + 1] : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
  const result: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      result.push({ kind: 'context', text: before[i], oldLine: ++i, newLine: ++j });
    } else if (i < before.length && (j === after.length || lengths[i + 1][j] >= lengths[i][j + 1])) {
      result.push({ kind: 'remove', text: before[i], oldLine: ++i });
    } else result.push({ kind: 'add', text: after[j], newLine: ++j });
  }
  return result;
}
