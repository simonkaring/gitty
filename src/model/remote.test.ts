import { describe, expect, it } from 'vitest';
import { defaultRemote, describeRemoteAction, describeStashAction, needsPublish, sortStashes, syncSummary } from './remote';

describe('sync summary', () => {
  it('is empty without sync info', () => { expect(syncSummary(null)).toBe(''); });
  it('flags detached HEAD', () => { expect(syncSummary({ branch: null, upstream: null, ahead: null, behind: null, remotes: [] })).toBe('Detached HEAD'); });
  it('flags a branch with no upstream', () => { expect(syncSummary({ branch: 'main', upstream: null, ahead: null, behind: null, remotes: [] })).toBe('main · no upstream'); });
  it('shows up to date when ahead/behind are both zero', () => { expect(syncSummary({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, remotes: ['origin'] })).toBe('main → origin/main · up to date'); });
  it('shows ahead and behind counts', () => { expect(syncSummary({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, remotes: ['origin'] })).toBe('main → origin/main (↑2 ↓1)'); });
  it('shows only ahead when nothing is behind', () => { expect(syncSummary({ branch: 'main', upstream: 'origin/main', ahead: 3, behind: 0, remotes: ['origin'] })).toBe('main → origin/main (↑3)'); });
  it('does not claim unknown counts are up to date', () => {
    for (const [ahead, behind] of [[null, null], [0, null], [null, 0]]) {
      expect(syncSummary({ branch: 'main', upstream: 'team/origin/main', ahead, behind, remotes: ['team/origin'] })).toBe('main → team/origin/main · counts unavailable');
    }
  });
});

describe('publish requirement', () => {
  it('requires publish only for a branch without an upstream', () => {
    expect(needsPublish(null)).toBe(false);
    expect(needsPublish({ branch: null, upstream: null, ahead: null, behind: null, remotes: [] })).toBe(false);
    expect(needsPublish({ branch: 'main', upstream: null, ahead: null, behind: null, remotes: [] })).toBe(true);
    expect(needsPublish({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, remotes: [] })).toBe(false);
  });
});

describe('default remote selection', () => {
  it('prefers an explicit preferred remote when it exists', () => { expect(defaultRemote(['origin', 'upstream'], 'upstream')).toBe('upstream'); });
  it('ignores a preferred remote that is not in the list', () => { expect(defaultRemote(['origin', 'upstream'], 'ghost')).toBe('origin'); });
  it('falls back to origin', () => { expect(defaultRemote(['fork', 'origin'])).toBe('origin'); });
  it('falls back to the first remote when there is no origin', () => { expect(defaultRemote(['fork', 'upstream'])).toBe('fork'); });
  it('returns an empty string with no remotes', () => { expect(defaultRemote([])).toBe(''); });
});

describe('stash ordering', () => {
  it('sorts by the numeric stash index regardless of input order', () => {
    const entries = [{ oid: 'b', selector: 'stash@{2}', message: 'two' }, { oid: 'a', selector: 'stash@{0}', message: 'zero' }, { oid: 'c', selector: 'stash@{1}', message: 'one' }];
    expect(sortStashes(entries).map(e => e.oid)).toEqual(['a', 'c', 'b']);
  });
  it('does not mutate the input array', () => {
    const entries = [{ oid: 'b', selector: 'stash@{1}', message: '' }, { oid: 'a', selector: 'stash@{0}', message: '' }];
    const copy = [...entries];
    sortStashes(entries);
    expect(entries).toEqual(copy);
  });
});

describe('action descriptions', () => {
  it('describes fetch, pull modes, and push', () => {
    expect(describeRemoteAction({ kind: 'fetch' })).toBe('Fetch');
    expect(describeRemoteAction({ kind: 'fetch', remote: 'origin' })).toBe('Fetch origin');
    expect(describeRemoteAction({ kind: 'pull', pullMode: 'rebase' })).toBe('Pull (rebase)');
    expect(describeRemoteAction({ kind: 'pull' })).toBe('Pull (fast-forward only)');
    expect(describeRemoteAction({ kind: 'push', remote: 'origin', branch: 'main' })).toBe('Push origin/main');
    expect(describeRemoteAction({ kind: 'push' })).toBe('Push');
  });
  it('describes stash actions', () => {
    expect(describeStashAction({ kind: 'save' })).toBe('Stash changes');
    expect(describeStashAction({ kind: 'apply', oid: 'x' })).toBe('Apply stash');
    expect(describeStashAction({ kind: 'pop', oid: 'x' })).toBe('Pop stash');
    expect(describeStashAction({ kind: 'drop', oid: 'x' })).toBe('Drop stash');
  });
});
