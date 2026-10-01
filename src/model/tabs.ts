import type { RepositoryLocation } from './repository';

/** Repository tab persistence and canonical identity.
 * A tab is created from a raw `RepositoryLocation` (what the user picked).
 * Two raw locations that are textually identical are deduplicated immediately
 * (`sameLocation`), before any IPC call. Two tabs whose *resolved* sessions
 * turn out to be the same underlying worktree (same origin, root and common
 * dir) are deduplicated after `repository_open` resolves, using `sessionKey`.
 * `commonDir` is included so distinct linked worktrees of the same repository
 * (which share a common dir but have different roots) are never merged,
 * while two paths that resolve to the very same worktree root always are. */

export interface TabStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }

export interface PersistedTabRecord { id: string; location: RepositoryLocation }
export interface PersistedTabsState { tabs: PersistedTabRecord[]; activeId: string | null }

export const TABS_STORAGE_KEY = 'gitty:native-tabs:v1';

function isRepositoryLocation(value: unknown): value is RepositoryLocation {
  if (!value || typeof value !== 'object') return false;
  const location = value as Record<string, unknown>;
  if (typeof location.path !== 'string') return false;
  if (location.kind === 'native') return true;
  if (location.kind === 'wsl') return typeof location.distribution === 'string';
  return false;
}

/** Identity of the raw, user-supplied location (before opening). Used to avoid
 * creating an obviously-duplicate tab without waiting on an IPC round trip. */
export function locationKey(location: RepositoryLocation): string {
  return location.kind === 'wsl' ? `wsl:${location.distribution}:${location.path}` : `native:${location.path}`;
}
export function sameLocation(a: RepositoryLocation, b: RepositoryLocation): boolean {
  return locationKey(a) === locationKey(b);
}

/** Canonical identity of a *resolved* session: distinguishes native from WSL
 * (and between WSL distributions), and ties worktrees of the same repository
 * together only when both the worktree root and the common (shared) git dir
 * match. Two different linked worktrees of one repository have different
 * roots and are therefore kept as separate tabs. */
export function sessionKey(location: RepositoryLocation, session: { root: string; commonDir: string }): string {
  const origin = location.kind === 'wsl' ? `wsl:${location.distribution}` : 'native';
  return `${origin}|${session.root}|${session.commonDir}`;
}

export function locationLabel(location: RepositoryLocation): string {
  const segments = location.path.split(/[\\/]/).filter(Boolean);
  const base = segments.at(-1) ?? location.path;
  return location.kind === 'wsl' ? `${base} (WSL: ${location.distribution})` : base;
}

export function createTabId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Malformed or unavailable storage must never prevent opening repositories;
 * callers get an empty tab list and start fresh. */
export function loadPersistedTabs(storage: TabStorage): PersistedTabsState {
  try {
    const raw = storage.getItem(TABS_STORAGE_KEY);
    if (!raw) return { tabs: [], activeId: null };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { tabs?: unknown }).tabs)) return { tabs: [], activeId: null };
    const rawTabs = (parsed as { tabs: unknown[] }).tabs;
    const tabs = rawTabs
      .filter((entry): entry is PersistedTabRecord => !!entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string' && isRepositoryLocation((entry as { location?: unknown }).location))
      .map(entry => ({ id: entry.id, location: entry.location }));
    const rawActiveId = (parsed as { activeId?: unknown }).activeId;
    const activeId = typeof rawActiveId === 'string' && tabs.some(tab => tab.id === rawActiveId) ? rawActiveId : (tabs.at(-1)?.id ?? null);
    return { tabs, activeId };
  } catch { return { tabs: [], activeId: null }; }
}

/** Best-effort persistence: an unavailable store must not break tab switching
 * for the current session, only cross-reload restoration. */
export function savePersistedTabs(storage: TabStorage, state: PersistedTabsState): boolean {
  try { storage.setItem(TABS_STORAGE_KEY, JSON.stringify(state)); return true; }
  catch { return false; }
}

export interface KeyedTab { id: string; key: string | null }
/** After a session resolves, find another already-open tab with the same
 * canonical identity. The newer tab (the just-opened one) is the duplicate:
 * the caller drops it and switches focus to the pre-existing tab instead. */
export function findDuplicateTab<T extends KeyedTab>(tabs: T[], tabId: string, key: string): T | undefined {
  return tabs.find(tab => tab.id !== tabId && tab.key === key);
}

/** A single repository tab. `branch`/`dirty` are display-only, reported by
 * the pane after each refresh; `key` is the canonical session identity (null
 * until the first `repository_open` resolves); `busy` guards closing a tab
 * mid-write. A null `location` is a start tab (the new-tab page), which is
 * never persisted and is replaced in place by the repository opened from it. */
export interface TabRecord {
  id: string;
  location: RepositoryLocation | null;
  title: string;
  key: string | null;
  busy: boolean;
  branch: string | null;
  dirty: boolean;
}
export interface TabsState { tabs: TabRecord[]; activeId: string | null; notice: string | null }
export type TabsAction =
  | { type: 'restore'; tabs: TabRecord[]; activeId: string | null }
  | { type: 'open'; location: RepositoryLocation; fromTabId?: string }
  | { type: 'start' }
  | { type: 'identity'; tabId: string; key: string | null; title: string | null }
  | { type: 'busy'; tabId: string; busy: boolean }
  | { type: 'meta'; tabId: string; branch: string | null; dirty: boolean }
  | { type: 'close'; tabId: string }
  | { type: 'select'; tabId: string }
  | { type: 'noticeShown' };

export const START_TITLE = 'New tab';
function newTab(location: RepositoryLocation | null): TabRecord {
  return { id: createTabId(), location, title: location ? locationLabel(location) : START_TITLE, key: null, busy: false, branch: null, dirty: false };
}

/** Pure state transition for the tab strip. Deliberately has no side effects
 * (no `notify`/`setActiveId` calls buried inside a `setTabs` updater): under
 * React StrictMode, updater/reducer functions can be invoked twice per
 * dispatch to surface exactly this kind of impurity, and a side effect
 * embedded in one of those extra calls (e.g. selecting a freshly-generated,
 * never-stored tab id) desyncs `tabs` from `activeId`, leaving the real tab
 * permanently hidden. Any user-visible message goes through `notice` instead,
 * which the caller flushes via `notify` in a `useEffect` and then clears with
 * `noticeShown` — never from inside the reducer or an updater callback. */
export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case 'restore':
      return { tabs: action.tabs, activeId: action.activeId, notice: null };
    case 'open': {
      // Opening from a start tab replaces that tab, like a browser's new-tab page.
      const start = state.tabs.find(tab => tab.id === action.fromTabId && !tab.location);
      const existing = state.tabs.find(tab => tab.location && sameLocation(tab.location, action.location));
      if (existing && !start) return existing.id === state.activeId ? state : { ...state, activeId: existing.id };
      if (existing) return { ...state, tabs: state.tabs.filter(tab => tab !== start), activeId: existing.id };
      const tab = newTab(action.location);
      return { ...state, tabs: start ? state.tabs.map(value => value === start ? tab : value) : [...state.tabs, tab], activeId: tab.id };
    }
    case 'start': {
      const existing = state.tabs.find(tab => !tab.location);
      if (existing) return existing.id === state.activeId ? state : { ...state, activeId: existing.id };
      const tab = newTab(null);
      return { ...state, tabs: [...state.tabs, tab], activeId: tab.id };
    }
    case 'identity': {
      const tab = state.tabs.find(value => value.id === action.tabId);
      if (!tab) return state;
      if (action.key) {
        const duplicate = findDuplicateTab(state.tabs, action.tabId, action.key);
        if (duplicate) {
          return {
            tabs: state.tabs.filter(value => value.id !== action.tabId),
            activeId: state.activeId === action.tabId ? duplicate.id : state.activeId,
            notice: `${action.title ?? duplicate.title} is already open in the “${duplicate.title}” tab.`,
          };
        }
      }
      if (tab.key === action.key && (action.title === null || tab.title === action.title)) return state;
      return { ...state, tabs: state.tabs.map(value => value.id === action.tabId ? { ...value, key: action.key, title: action.title ?? value.title } : value) };
    }
    case 'busy': {
      const tab = state.tabs.find(value => value.id === action.tabId);
      if (!tab || tab.busy === action.busy) return state;
      return { ...state, tabs: state.tabs.map(value => value.id === action.tabId ? { ...value, busy: action.busy } : value) };
    }
    case 'meta': {
      const tab = state.tabs.find(value => value.id === action.tabId);
      if (!tab || (tab.branch === action.branch && tab.dirty === action.dirty)) return state;
      return { ...state, tabs: state.tabs.map(value => value.id === action.tabId ? { ...value, branch: action.branch, dirty: action.dirty } : value) };
    }
    case 'close': {
      const tab = state.tabs.find(value => value.id === action.tabId);
      if (!tab) return state;
      if (tab.busy) return { ...state, notice: 'Cannot close this tab while an operation is running in it. Switch away instead.' };
      const index = state.tabs.findIndex(value => value.id === action.tabId);
      const tabs = state.tabs.filter(value => value.id !== action.tabId);
      const activeId = state.activeId !== action.tabId ? state.activeId : tabs.length ? (tabs[index] ?? tabs[index - 1])?.id ?? tabs[0].id : null;
      return { ...state, tabs, activeId };
    }
    case 'select':
      return state.activeId === action.tabId ? state : { ...state, activeId: action.tabId };
    case 'noticeShown':
      return state.notice === null ? state : { ...state, notice: null };
    default:
      return state;
  }
}
