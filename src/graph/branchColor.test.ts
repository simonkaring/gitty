import { describe, expect, it } from 'vitest';
import { assignBranchColors, branchName } from './branchColor';
import type { GitRef } from '../model/types';

const ref = (name: string, commitId: string, kind: GitRef['kind'] = 'local'): GitRef => ({ name, commitId, kind });
const commits = [
  { id: 'working', parents: ['merge'] },
  { id: 'merge', parents: ['main-tip', 'feature-tip', 'deleted-tip'] },
  { id: 'main-tip', parents: ['base'] },
  { id: 'feature-tip', parents: ['feature-old'] },
  { id: 'feature-old', parents: ['base'] },
  { id: 'deleted-tip', parents: ['deleted-old'] },
  { id: 'deleted-old', parents: ['base'] },
  { id: 'base', parents: ['root'] },
  { id: 'root', parents: [] },
];
const refs = [ref('main', 'merge'), ref('feat/git', 'feature-tip'), ref('origin/feat/git', 'feature-tip', 'remote')];

describe('branch colors', () => {
  it('normalizes remote branches and ignores tags and remote HEAD', () => {
    expect(branchName(ref('origin/feat/git', 'x', 'remote'))).toBe('feat/git');
    expect(branchName(ref('feat/git', 'x'))).toBe('feat/git');
    expect(branchName(ref('origin/HEAD', 'x', 'remote'))).toBeNull();
    expect(branchName(ref('v1', 'x', 'tag'))).toBeNull();
  });

  it('keeps trunk, side chains, and working changes consistent independent of ref order', () => {
    const { rows, branches } = assignBranchColors(commits, refs, 'working');
    expect(assignBranchColors(commits, [...refs].reverse(), 'working').rows).toEqual(rows);
    expect(branches.size).toBe(2);
    expect(branches.get('main')).not.toBe(branches.get('feat/git'));
    for (const row of [0, 1, 2, 7, 8]) expect(rows[row]).toBe(branches.get('main'));
    for (const row of [3, 4]) expect(rows[row]).toBe(branches.get('feat/git'));
    expect(rows[5]).toBe(rows[6]);
    expect(assignBranchColors(commits.slice(0, 7), refs, 'working').rows).toEqual(rows.slice(0, 7));
  });

  it('assigns eight distinct slots and reuses valid slots beyond the palette', () => {
    const refs = Array.from({ length: 9 }, (_, i) => ref(`branch-${i}`, `${i}`));
    const first = assignBranchColors([], refs.slice(0, 8)).branches;
    expect(new Set(first.values()).size).toBe(8);
    const all = assignBranchColors([], refs).branches;
    expect([...all.values()].every(index => index >= 0 && index < 8)).toBe(true);
    expect(assignBranchColors([], [...refs].reverse()).branches).toEqual(all);
  });

  it('honors an own nonstandard trunk ref but does not repaint main for a release ref', () => {
    const chain = [{ id: 'feature', parents: ['base'] }, { id: 'base', parents: ['root'] }, { id: 'root', parents: [] }];
    const develop = assignBranchColors(chain, [ref('feat', 'feature'), ref('develop', 'base')]);
    expect(develop.rows[1]).toBe(develop.branches.get('develop'));
    const main = assignBranchColors(chain, [ref('main', 'feature'), ref('release', 'base')]);
    expect(main.rows[1]).toBe(main.branches.get('main'));
  });
});
