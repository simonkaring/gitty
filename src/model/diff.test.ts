import { expect, it } from 'vitest';
import { diffLines } from './diff';

it('reconstructs both sides of a diff including repeated, added, and deleted lines', () => {
  for (const [before, after] of [
    [['a', 'b', 'a', 'c'], ['a', 'a', 'd', 'c']],
    [[], ['new']], [['deleted'], []], [[], []], [['same'], ['same']],
  ]) {
    const lines = diffLines(before, after);
    expect(lines.filter(l => l.kind !== 'add').map(l => l.text)).toEqual(before);
    expect(lines.filter(l => l.kind !== 'remove').map(l => l.text)).toEqual(after);
    expect(lines.filter(l => l.oldLine !== undefined).map(l => l.oldLine)).toEqual(before.map((_, i) => i + 1));
    expect(lines.filter(l => l.newLine !== undefined).map(l => l.newLine)).toEqual(after.map((_, i) => i + 1));
  }
});
