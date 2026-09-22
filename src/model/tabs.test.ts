import { describe, expect, it } from 'vitest';
import { findDuplicateTab, loadPersistedTabs, locationKey, locationLabel, sameLocation, savePersistedTabs, sessionKey, tabsReducer, TABS_STORAGE_KEY, type TabRecord, type TabsState, type TabStorage } from './tabs';
import type { RepositoryLocation } from './repository';

function memoryStorage(initial: Record<string, string> = {}): TabStorage {
  const store = { ...initial };
  return { getItem: key => (key in store ? store[key] : null), setItem: (key, value) => { store[key] = value; } };
}

describe('raw location identity', () => {
  it('treats identical native paths as the same location', () => {
    const a: RepositoryLocation = { kind: 'native', path: '/repo' };
    const b: RepositoryLocation = { kind: 'native', path: '/repo' };
    expect(sameLocation(a, b)).toBe(true);
    expect(locationKey(a)).toBe(locationKey(b));
  });
  it('distinguishes WSL distributions from native paths at the same path', () => {
    const native: RepositoryLocation = { kind: 'native', path: '/repo' };
    const wsl: RepositoryLocation = { kind: 'wsl', distribution: 'Ubuntu', path: '/repo' };
    expect(sameLocation(native, wsl)).toBe(false);
  });
  it('distinguishes two different WSL distributions at the same path', () => {
    const a: RepositoryLocation = { kind: 'wsl', distribution: 'Ubuntu', path: '/repo' };
    const b: RepositoryLocation = { kind: 'wsl', distribution: 'Debian', path: '/repo' };
    expect(sameLocation(a, b)).toBe(false);
  });
});

describe('resolved session identity (post repository_open dedup)', () => {
  it('keys native and WSL sessions distinctly even at the same resolved root', () => {
    const nativeKey = sessionKey({ kind: 'native', path: '/anything' }, { root: '/repo', commonDir: '/repo/.git' });
    const wslKey = sessionKey({ kind: 'wsl', distribution: 'Ubuntu', path: '/anything' }, { root: '/repo', commonDir: '/repo/.git' });
    expect(nativeKey).not.toBe(wslKey);
  });
  it('merges two different raw paths that resolve to the same worktree root', () => {
    const first = sessionKey({ kind: 'native', path: '/repo/./sub/..' }, { root: '/repo', commonDir: '/repo/.git' });
    const second = sessionKey({ kind: 'native', path: '/repo' }, { root: '/repo', commonDir: '/repo/.git' });
    expect(first).toBe(second);
  });
  it('keeps two linked worktrees of the same repository as distinct identities', () => {
    const main = sessionKey({ kind: 'native', path: '/repo' }, { root: '/repo', commonDir: '/repo/.git' });
    const linked = sessionKey({ kind: 'native', path: '/repo-feature' }, { root: '/repo-feature', commonDir: '/repo/.git' });
    expect(main).not.toBe(linked);
  });
});

describe('duplicate tab detection', () => {
  it('finds a pre-existing tab with the same canonical key, excluding itself', () => {
    const tabs = [{ id: 'a', key: 'k1' }, { id: 'b', key: null }, { id: 'c', key: 'k2' }];
    expect(findDuplicateTab(tabs, 'b', 'k1')?.id).toBe('a');
    expect(findDuplicateTab(tabs, 'a', 'k1')).toBeUndefined();
    expect(findDuplicateTab(tabs, 'b', 'k3')).toBeUndefined();
  });
});

describe('tab persistence', () => {
  it('round-trips tabs and the active id through storage', () => {
    const storage = memoryStorage();
    const state = { tabs: [{ id: 't1', location: { kind: 'native', path: '/repo' } as RepositoryLocation }], activeId: 't1' };
    expect(savePersistedTabs(storage, state)).toBe(true);
    expect(loadPersistedTabs(storage)).toEqual(state);
  });
  it('returns an empty state when nothing is stored', () => {
    expect(loadPersistedTabs(memoryStorage())).toEqual({ tabs: [], activeId: null });
  });
  it('discards malformed JSON without throwing', () => {
    expect(loadPersistedTabs(memoryStorage({ [TABS_STORAGE_KEY]: '{not json' }))).toEqual({ tabs: [], activeId: null });
  });
  it('drops entries with an unrecognized location shape', () => {
    const raw = JSON.stringify({ tabs: [{ id: 't1', location: { kind: 'native', path: '/ok' } }, { id: 't2', location: { kind: 'ftp', path: '/bad' } }, { id: 't3' }], activeId: 't2' });
    const result = loadPersistedTabs(memoryStorage({ [TABS_STORAGE_KEY]: raw }));
    expect(result.tabs).toEqual([{ id: 't1', location: { kind: 'native', path: '/ok' } }]);
  });
  it('falls back to the last tab when the stored active id no longer exists', () => {
    const raw = JSON.stringify({ tabs: [{ id: 't1', location: { kind: 'native', path: '/a' } }, { id: 't2', location: { kind: 'native', path: '/b' } }], activeId: 'missing' });
    expect(loadPersistedTabs(memoryStorage({ [TABS_STORAGE_KEY]: raw })).activeId).toBe('t2');
  });
  it('survives a storage that throws on write', () => {
    const storage: TabStorage = { getItem: () => null, setItem: () => { throw new Error('quota exceeded'); } };
    expect(savePersistedTabs(storage, { tabs: [], activeId: null })).toBe(false);
  });
});

describe('location labels', () => {
  it('uses the final path segment as the label', () => {
    expect(locationLabel({ kind: 'native', path: '/Users/dev/gitty' })).toBe('gitty');
  });
  it('marks WSL locations with their distribution', () => {
    expect(locationLabel({ kind: 'wsl', distribution: 'Ubuntu', path: '/home/dev/gitty' })).toBe('gitty (WSL: Ubuntu)');
  });
  it('falls back to the full path when there is no segment to extract', () => {
    expect(locationLabel({ kind: 'native', path: '/' })).toBe('/');
  });
});

describe('tabsReducer', () => {
  const empty: TabsState = { tabs: [], activeId: null, notice: null };
  const record = (over: Partial<TabRecord> & { id: string }): TabRecord => ({ location: { kind: 'native', path: `/${over.id}` }, title: over.id, key: null, busy: false, branch: null, dirty: false, ...over });

  it('opens a new tab and activates it', () => {
    const next = tabsReducer(empty, { type: 'open', location: { kind: 'native', path: '/repo' } });
    expect(next.tabs).toHaveLength(1);
    expect(next.activeId).toBe(next.tabs[0].id);
    expect(next.tabs[0].title).toBe('repo');
  });

  it('reuses an existing tab for an identical raw location instead of opening a duplicate', () => {
    const opened = tabsReducer(empty, { type: 'open', location: { kind: 'native', path: '/repo' } });
    const reopened = tabsReducer({ ...opened, activeId: null }, { type: 'open', location: { kind: 'native', path: '/repo' } });
    expect(reopened.tabs).toHaveLength(1);
    expect(reopened.activeId).toBe(opened.tabs[0].id);
  });

  it('is referentially stable (no-op) when reopening the already-active tab', () => {
    const opened = tabsReducer(empty, { type: 'open', location: { kind: 'native', path: '/repo' } });
    const again = tabsReducer(opened, { type: 'open', location: { kind: 'native', path: '/repo' } });
    expect(again).toBe(opened);
  });

  it('never desyncs tabs from activeId even if the reducer runs twice for one dispatch (StrictMode)', () => {
    // The exact bug this reducer replaces: calling setActiveId with a freshly
    // generated id from inside a setTabs updater meant a double-invoked
    // updater (React StrictMode) could commit a *different* random id than
    // the one that ended up in the committed tabs array, leaving the only
    // tab permanently unmatched (and therefore permanently `hidden`).
    const first = tabsReducer(empty, { type: 'open', location: { kind: 'native', path: '/repo' } });
    const second = tabsReducer(empty, { type: 'open', location: { kind: 'native', path: '/repo' } });
    // Simulates React using only the *second* invocation's result.
    expect(second.tabs.some(tab => tab.id === second.activeId)).toBe(true);
    expect(first.activeId).not.toBe(second.activeId); // different ids are fine in isolation...
    expect(second.tabs.map(t => t.id)).not.toContain(first.activeId); // ...as long as they never mix.
  });

  it('deduplicates after identity resolves, focuses the pre-existing tab, and raises a notice (not a direct call)', () => {
    const state: TabsState = { tabs: [record({ id: 'a', key: 'canon', title: 'first' }), record({ id: 'b', key: null, title: 'second' })], activeId: 'b', notice: null };
    const next = tabsReducer(state, { type: 'identity', tabId: 'b', key: 'canon', title: 'second' });
    expect(next.tabs.map(t => t.id)).toEqual(['a']);
    expect(next.activeId).toBe('a');
    expect(next.notice).toMatch(/already open/);
  });

  it('leaves activeId alone when the duplicate tab being dropped was not the active one', () => {
    const state: TabsState = { tabs: [record({ id: 'a', key: 'canon' }), record({ id: 'b', key: null }), record({ id: 'c', key: null })], activeId: 'c', notice: null };
    const next = tabsReducer(state, { type: 'identity', tabId: 'b', key: 'canon', title: null });
    expect(next.activeId).toBe('c');
    expect(next.tabs.map(t => t.id)).toEqual(['a', 'c']);
  });

  it('is a no-op when identity is unchanged', () => {
    const state: TabsState = { tabs: [record({ id: 'a', key: 'canon', title: 'Repo' })], activeId: 'a', notice: null };
    expect(tabsReducer(state, { type: 'identity', tabId: 'a', key: 'canon', title: 'Repo' })).toBe(state);
  });

  it('refuses to close a busy tab and raises a notice instead of throwing', () => {
    const state: TabsState = { tabs: [record({ id: 'a', busy: true })], activeId: 'a', notice: null };
    const next = tabsReducer(state, { type: 'close', tabId: 'a' });
    expect(next.tabs).toHaveLength(1);
    expect(next.notice).toMatch(/busy|running/);
  });

  it('closing the active tab focuses its right neighbor, falling back to the left, then to none', () => {
    const state: TabsState = { tabs: [record({ id: 'a' }), record({ id: 'b' }), record({ id: 'c' })], activeId: 'b', notice: null };
    const closedMiddle = tabsReducer(state, { type: 'close', tabId: 'b' });
    expect(closedMiddle.activeId).toBe('c');
    const closedLast = tabsReducer({ ...state, activeId: 'c' }, { type: 'close', tabId: 'c' });
    expect(closedLast.activeId).toBe('b');
    const onlyOne: TabsState = { tabs: [record({ id: 'a' })], activeId: 'a', notice: null };
    expect(tabsReducer(onlyOne, { type: 'close', tabId: 'a' }).activeId).toBeNull();
  });

  it('closing an inactive tab does not change activeId', () => {
    const state: TabsState = { tabs: [record({ id: 'a' }), record({ id: 'b' })], activeId: 'a', notice: null };
    const next = tabsReducer(state, { type: 'close', tabId: 'b' });
    expect(next.activeId).toBe('a');
    expect(next.tabs.map(t => t.id)).toEqual(['a']);
  });

  it('updates busy and meta (branch/dirty) without touching unrelated tabs', () => {
    const state: TabsState = { tabs: [record({ id: 'a' }), record({ id: 'b' })], activeId: 'a', notice: null };
    const busy = tabsReducer(state, { type: 'busy', tabId: 'a', busy: true });
    expect(busy.tabs.find(t => t.id === 'a')?.busy).toBe(true);
    expect(busy.tabs.find(t => t.id === 'b')).toEqual(state.tabs[1]);
    const meta = tabsReducer(state, { type: 'meta', tabId: 'b', branch: 'main', dirty: true });
    expect(meta.tabs.find(t => t.id === 'b')).toMatchObject({ branch: 'main', dirty: true });
  });

  it('select is a no-op for the already-active tab', () => {
    const state: TabsState = { tabs: [record({ id: 'a' })], activeId: 'a', notice: null };
    expect(tabsReducer(state, { type: 'select', tabId: 'a' })).toBe(state);
  });

  it('clears the notice only via noticeShown', () => {
    const state: TabsState = { tabs: [], activeId: null, notice: 'hello' };
    expect(tabsReducer(state, { type: 'noticeShown' }).notice).toBeNull();
  });
});
