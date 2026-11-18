import { describe, expect, it } from 'vitest';
import { assignBranchColors, branchName, CURRENT_COLOR, stashBranches } from './branchColor';
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

  it('names the branch that owns each row, so hover highlights follow branches rather than shared colors', () => {
    const { owned } = assignBranchColors(commits, refs, 'working');
    expect(owned.slice(0, 5)).toEqual(['main', 'main', 'main', 'feat/git', 'feat/git']);
    expect(owned[5]).toBeNull();
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

  it('paints the checked-out branch with the accent slot without shifting other branches', () => {
    const base = assignBranchColors(commits, refs, 'working');
    const onFeature = assignBranchColors(commits, refs, 'working', 'feat/git');
    expect(onFeature.branches.get('feat/git')).toBe(CURRENT_COLOR);
    expect(onFeature.branches.get('main')).toBe(base.branches.get('main'));
    for (const row of [3, 4]) expect(onFeature.rows[row]).toBe(CURRENT_COLOR);
    expect(onFeature.rows[2]).toBe(base.rows[2]);
    expect(assignBranchColors(commits, refs, 'working', 'gone').rows).toEqual(base.rows);
  });
});

describe('stash colors', () => {
  const stash = { id: 'stash', parents: ['main-tip'], subject: 'On feat/git: feat/git - stash - 1/1/2026' };
  const graph = [stash, ...commits.filter(commit => commit.id !== 'working').map(commit => ({ ...commit, subject: commit.id }))];
  const withStash = [...refs, ref('stash', 'stash', 'stash')];

  it('takes the colour of the branch the stash was made on', () => {
    const owners = stashBranches(graph, withStash);
    expect([...owners]).toEqual([[0, 'feat/git']]);
    const colors = assignBranchColors(graph, withStash, undefined, 'main', owners);
    const featureRow = graph.findIndex(commit => commit.id === 'feature-tip');
    expect(colors.rows[0]).toBe(colors.branches.get('feat/git'));
    expect(colors.rows[0]).toBe(colors.rows[featureRow]);
  });
  it('does not take branch ownership of newer history', () => {
    const colors = assignBranchColors(graph, withStash, undefined, 'main', stashBranches(graph, withStash));
    expect(colors.owned[0]).toBe('feat/git');
    expect(colors.owned[graph.findIndex(commit => commit.id === 'merge')]).toBe('main');
  });
  it('ignores stash messages without a branch', () => {
    expect(stashBranches([{ id: 's', parents: [], subject: 'custom' }], [ref('stash', 's', 'stash')]).size).toBe(0);
    expect(stashBranches([{ id: 'stash', parents: [], subject: 'On feat/git: x' }], refs).size).toBe(0);
  });
});
