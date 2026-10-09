import { describe, expect, it } from 'vitest';
import { defaultRemote, describeRemoteAction, describeStashAction, needsPublish, remoteSuccessMessage, sortStashes, stashSuccessMessage, syncSummary } from './remote';

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

describe('success notifications', () => {
  const pushOutput = 'To https://github.com/simonkaring/gitty.git\n \trefs/heads/feat/branch-actions:refs/heads/feat/branch-actions\t5c3d0d8..a77d0d8\nDone';
  const unchangedPush = 'To https://github.com/simonkaring/gitty.git\n=\trefs/heads/main:refs/heads/main\t[up to date]\nDone';

  it('summarizes push reports without URLs, refspecs, or object IDs', () => {
    expect(remoteSuccessMessage({ kind: 'push' }, pushOutput, 'feat/branch-actions')).toBe('Pushed feat/branch-actions.');
    expect(remoteSuccessMessage({ kind: 'push', remote: 'origin', branch: 'feat/branch-actions' }, pushOutput)).toBe('Pushed feat/branch-actions to origin.');
    expect(remoteSuccessMessage({ kind: 'push' }, '')).toBe('Pushed changes.');
  });

  it('distinguishes a no-op push from publishing an existing remote branch', () => {
    expect(remoteSuccessMessage({ kind: 'push' }, unchangedPush)).toBe('Already up to date. Nothing to push.');
    expect(remoteSuccessMessage({ kind: 'push', remote: 'origin', branch: 'main', setUpstream: true }, unchangedPush)).toBe('Published main to origin.');
  });

  it('summarizes fetch and pull for explicit and configured targets', () => {
    expect(remoteSuccessMessage({ kind: 'fetch' }, 'terminal output')).toBe('Fetched remote updates.');
    expect(remoteSuccessMessage({ kind: 'fetch', remote: 'team/origin' }, '')).toBe('Fetched updates from team/origin.');
    expect(remoteSuccessMessage({ kind: 'pull' }, 'Updating 5c3d0d8..a77d0d8\nFast-forward')).toBe('Pulled updates.');
    expect(remoteSuccessMessage({ kind: 'pull', remote: 'origin', branch: 'main' }, '')).toBe('Pulled updates from origin/main.');
    expect(remoteSuccessMessage({ kind: 'pull' }, 'From example.com\nAlready up to date.\n')).toBe('Already up to date. Nothing to pull.');
    expect(remoteSuccessMessage({ kind: 'pull', pullMode: 'rebase' }, 'Current branch feat/branch-actions is up to date.')).toBe('Already up to date. Nothing to pull.');
  });

  it('explains stash results and whether the saved stash is retained', () => {
    expect(stashSuccessMessage({ kind: 'save' }, 'Saved working directory and index state WIP on main: abc123')).toBe('Saved working changes to a stash.');
    expect(stashSuccessMessage({ kind: 'save' }, 'No local changes to save\n')).toBe('No changes to stash.');
    expect(stashSuccessMessage({ kind: 'apply', oid: 'x' }, 'On branch main\nChanges not staged for commit:')).toBe('Applied stash. The saved stash is still available.');
    expect(stashSuccessMessage({ kind: 'pop', oid: 'x' }, 'Dropped refs/stash@{0} (abc123)')).toBe('Applied stash and removed it from saved stashes.');
    expect(stashSuccessMessage({ kind: 'drop', oid: 'x' }, 'Dropped refs/stash@{0} (abc123)')).toBe('Deleted saved stash.');
  });
});
