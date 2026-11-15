import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Commit } from './types';
import { demoInvoke } from './demoBackend';
import type { CommitSummary, DiffSpec, RepositorySnapshot, RepositoryState, RepositoryStatus, StatusEntry } from './repository';
import type { OperationState } from './operations';
import type { CloneProgress } from './clone';

import { recordCommandEnd, recordCommandStart } from './activity';
import { isCancelledSearch } from './searchFlow';

let demoMode = false;
const realBackendTest = import.meta.env.DEV && import.meta.env.VITE_GITTY_TEST_MODE === '1';
const desktopHost = () => isTauri();
/** Events and cloning exist on the desktop and the real-backend test host, not in the browser demo. */
export const hostLive = () => realBackendTest || !demoMode;
let testSession: Promise<{ token: string; fixtureId: string; location: import('./repository').RepositoryLocation; cloneParent: string }> | undefined;
let testToken: string | undefined;
let testFixtureId: string | undefined;
const testEventHandlers = new Map<string, Set<(payload: unknown) => void>>();
const testHandles = new Set<string>();
let testEventAbort: AbortController | undefined;
let testEventTask: Promise<void> | undefined;
let testEventReady: Promise<void> | undefined;
/** While on, handle-less calls (open, recents, pickers) go to the in-memory demo backend. */
export function setDemoMode(on: boolean) { demoMode = on; }
export const isRealBackendTest = () => realBackendTest;
export function initializeTestHost() {
  if (!realBackendTest) return Promise.reject(new Error('Real-backend test host is not enabled.'));
  testSession ??= fetch('/__gitty_test/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }).then(async response => {
    const value = await response.json();
    if (!response.ok) throw new Error(value.error?.message ?? 'Test host initialization failed.');
    testToken = value.token;
    testFixtureId = value.fixtureId;
    return value;
  });
  return testSession;
}
function deliverTestEvent(kind: string, data: unknown) {
  const deliver = (name: string, payload: unknown) => {
    for (const handler of testEventHandlers.get(name) ?? []) handler(payload);
  };
  if (kind === 'repository_changed' && data && typeof data === 'object' &&
    'handle' in data && testHandles.has(String(data.handle))) deliver(kind, data);
  else if (kind === 'git_command' || kind === 'repository_clone') deliver(kind, data);
  else if (kind === 'events_dropped') {
    deliver(kind, data);
    for (const handle of testHandles) deliver('repository_changed', { handle });
  }
}
function startTestEventStream(): Promise<void> {
  if (testEventTask) return testEventAbort?.signal.aborted
    ? testEventTask.then(() => startTestEventStream())
    : testEventReady!;
  if (!testFixtureId || !testToken) return Promise.reject(new Error('Test fixture is not initialized.'));
  const controller = testEventAbort = new AbortController();
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let readySettled = false;
  testEventReady = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  testEventTask = (async () => {
    while (!controller.signal.aborted) {
      try {
        const response = await fetch(`/__gitty_test/events?fixtureId=${encodeURIComponent(testFixtureId!)}`, {
          headers: { authorization: `Bearer ${testToken}` }, signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error(`Event stream failed (${response.status})`);
        if (!readySettled) { readySettled = true; resolveReady(); }
        // The backend queue may contain changes from before subscribe/watch, or
        // while disconnected. Reload once on every connection to catch them.
        deliverTestEvent('events_dropped', { count: 1 });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 4 * 1024 * 1024) {
            buffer = '';
            deliverTestEvent('events_dropped', { count: 1 });
          }
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            try {
              const frame = JSON.parse(line);
              if (frame.version === 1 && Number.isSafeInteger(frame.eventId) &&
                typeof frame.event?.kind === 'string') deliverTestEvent(frame.event.kind, frame.event.data);
            } catch { deliverTestEvent('events_dropped', { count: 1 }); }
          }
        }
      } catch (error) {
        if (!readySettled) {
          readySettled = true;
          rejectReady(error instanceof Error ? error : new Error(String(error)));
        }
      }
      if (!controller.signal.aborted) await new Promise(resolve => setTimeout(resolve, 500));
    }
  })().finally(() => {
    if (testEventAbort === controller) {
      testEventAbort = undefined;
      testEventTask = undefined;
      testEventReady = undefined;
    }
  });
  const ready = testEventReady!;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    ready,
    new Promise<void>((_, reject) => { timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Test event stream did not become ready.'));
    }, 5000); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}
export const isDemoHandle = (handle: unknown) => typeof handle === 'string' && handle.startsWith('demo:');
async function testInvoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!testToken) await initializeTestHost();
  const response = await fetch('/__gitty_test/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${testToken}` },
    body: JSON.stringify({ command, args: { ...args, fixtureId: testFixtureId } }),
  });
  const value = await response.json();
  if (value.error) throw Object.assign(new Error(value.error.message), { code: value.error.code });
  if (!response.ok) throw Object.assign(new Error('Test backend request failed.'), { code: 'testBridge' });
  if (command === 'repository_open' && value.result?.session?.handle) testHandles.add(value.result.session.handle);
  if (command === 'repository_close' && typeof args.handle === 'string') testHandles.delete(args.handle);
  return value.result as T;
}
const dispatch = <T,>(command: string, args: Record<string, unknown> = {}): Promise<T> =>
  ('handle' in args ? isDemoHandle(args.handle) : demoMode)
    ? demoInvoke(command, args) as Promise<T>
    : realBackendTest ? testInvoke<T>(command, args) : invoke<T>(command, args);
export function subscribeNative<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  if (realBackendTest) {
    const listener = handler as (payload: unknown) => void;
    const handlers = testEventHandlers.get(event) ?? new Set();
    handlers.add(listener);
    testEventHandlers.set(event, handlers);
    const unsubscribe = () => {
      handlers.delete(listener);
      if (!handlers.size) testEventHandlers.delete(event);
      if (![...testEventHandlers.values()].some(value => value.size)) {
        testEventAbort?.abort();
      }
    };
    return initializeTestHost().then(startTestEventStream).then(() => unsubscribe, error => {
      unsubscribe();
      throw error;
    });
  }
  if (!hostLive()) return Promise.resolve(() => {});
  return listen<T>(event, event => handler(event.payload));
}
export async function openCloneProgress(operationId: string, handler: (value: CloneProgress) => void) {
  if (realBackendTest) {
    const stop = await subscribeNative<{ operationId: string } & CloneProgress>('repository_clone', value => {
      if (value.operationId === operationId) handler(value);
    });
    return { channel: undefined, stop };
  }
  if (hostLive()) {
    const channel = new Channel<CloneProgress>();
    channel.onmessage = handler;
    return { channel, stop() {} };
  }
  return { channel: undefined, stop() {} };
}
/** Session calls route by handle, so a pane closing after a mode switch still reaches the backend that owns it. */
export const native = async <T,>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
  const activityId = recordCommandStart(command, args);
  const start = performance.now();
  try {
    const result = await dispatch<T>(command, args);
    recordCommandEnd(activityId, 'success', performance.now() - start);
    return result;
  } catch (error) {
    // A superseded search is routine, not a failure worth logging.
    if (command === 'repository_search' && isCancelledSearch(error)) recordCommandEnd(activityId, 'success', performance.now() - start);
    else recordCommandEnd(activityId, 'error', performance.now() - start, errorMessage(error));
    throw error;
  }
};
export function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) return String(error.message);
  return String(error);
}
export function graphCommit(commit: CommitSummary): Commit { return { ...commit, body: '', branch: '', files: [] }; }
export const WORKING_ID = 'gitty:working-tree';
export type WorkingGroup = Extract<DiffSpec['kind'], 'staged' | 'unstaged' | 'untracked' | 'conflict'>;
export function statusGroups(entries: StatusEntry[]): Record<WorkingGroup, StatusEntry[]> {
  const groups: Record<WorkingGroup, StatusEntry[]> = { staged: [], unstaged: [], untracked: [], conflict: [] };
  for (const entry of entries) {
    if (entry.conflicted) groups.conflict.push(entry);
    else if (entry.untracked) groups.untracked.push(entry);
    else {
      if (entry.indexStatus && ![' ', '.', '?'].includes(entry.indexStatus)) groups.staged.push(entry);
      if (entry.worktreeStatus && ![' ', '.', '?'].includes(entry.worktreeStatus)) groups.unstaged.push(entry);
    }
  }
  return groups;
}
export function appendUnique(current: CommitSummary[], next: CommitSummary[]) {
  const ids = new Set(current.map(commit => commit.id));
  return [...current, ...next.filter(commit => !ids.has(commit.id))];
}

export interface NativeSnapshot {
  state: RepositoryState;
  status: RepositoryStatus;
  operation: OperationState;
  commits: CommitSummary[];
  cursor: string | null;
  generation: string;
}

/** Reject malformed/mixed walks at the IPC boundary, before calling the graph layout. */
export function validateHistory(commits: CommitSummary[]) {
  const seen = new Set<string>();
  for (const commit of commits) {
    if (seen.has(commit.id) || commit.parents.some(id => id === commit.id || seen.has(id))) {
      throw new Error('Repository returned inconsistent ancestry. Refresh to retry.');
    }
    seen.add(commit.id);
  }
}

/** One `repository_snapshot` reads state/status/operation and target-bounded history.
 * The backend pins history to the starting state's tips, rechecks state after paging,
 * and retries before publication. Unchanged state reuses the previous opaque generation. */
export async function readNativeSnapshot(handle: string, options: {
  previous?: Pick<NativeSnapshot, 'state' | 'commits' | 'cursor' | 'generation'>;
   /** Restart history, seeking known anchors up to max(400, deepest anchor index + 400). */
  forceHistory?: boolean;
  /** Automatic keep-visible candidates (selection, scroll anchor). With `previous`, only IDs that were
   * actually in the previous history are kept: an ID outside it, such as an inspector-only orphan, can never
   * be found by walking and would otherwise make every refresh read the entire history. */
  preserve?: string[];
  /** Target OIDs deleted or left unverified by the immediately preceding branch deletion. */
  excludeKeepVisible?: string[];
  /** A confirmed rewrite of the tip, `from` -> `to` (an amend). Applied to `preserve` after the filter above
   * so the old ID, which is in `previous`, is followed to the new commit instead of being searched for. Honored
   * only while the refreshed HEAD is `to`, so a hook that moved HEAD again cannot cause a full-history walk. */
  remap?: { from: string; to: string };
  current?: () => boolean;
  invoke?: typeof native;
  /** Time to produce the first history page of a fresh walk, excluding snapshot reads. */
  onFirstHistoryPage?: (millis: number) => void;
} = {}): Promise<NativeSnapshot> {
  const invoke = options.invoke ?? native;
  const check = () => { if (options.current && !options.current()) throw new Error('Repository request superseded.'); };
  const call = async <T,>(command: string, args: Record<string, unknown> = {}) => {
    check(); const result = await invoke<T>(command, { handle, ...args }); check(); return result;
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const known = options.previous && new Map(options.previous.commits.map((commit, index) => [commit.id, index]));
    const excluded = new Set(options.excludeKeepVisible ?? []);
    const preserve = (options.preserve ?? []).filter(id => id && id !== WORKING_ID && (!known || known.has(id)) && !excluded.has(id));
    const preserveLimit = Math.max(400, ...preserve.map(id => (known?.get(id) ?? 0) + 400));
    const { state: before, status, operation, history } = await call<RepositorySnapshot>('repository_snapshot', {
      history: { fingerprint: options.forceHistory ? undefined : options.previous?.state.fingerprint, previousHead: options.previous?.state.session.head, preserve, preserveLimit, remap: options.remap },
    });
    if (status.head !== before.session.head || status.headRef !== before.session.headRef) continue;
    if (options.previous && !options.forceHistory && before.fingerprint === options.previous.state.fingerprint) {
      // Reused history was validated when it arrived and cannot have changed since.
      return { state: before, status, operation, commits: options.previous.commits, cursor: options.previous.cursor, generation: options.previous.generation };
    }
    if (history) {
      validateHistory(history.commits);
      if (history.firstPageMillis !== undefined) options.onFirstHistoryPage?.(history.firstPageMillis);
      return { state: before, status, operation, commits: history.commits, cursor: history.cursor, generation: history.generation };
    }
    throw new Error('Repository omitted changed history. Refresh to retry.');
  }
  throw new Error('Repository kept changing during refresh. Showing the last consistent snapshot; retry when changes settle.');
}

export function inspectorSpec(selected: string, group: WorkingGroup, base: string, target: string, parent?: string): DiffSpec {
  if (selected === WORKING_ID) return { kind: group };
  if (base && target) return { kind: 'compare', base, target };
  return { kind: 'commit', oid: selected, ...(parent ? { parent } : {}) };
}

export function handleWindowDrag(event: React.MouseEvent<HTMLElement>) {
  if (event.button !== 0) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest('button, input, select, textarea, a, [role="tab"]')) return;
  void native('app_start_dragging').catch(() => {});
}

export const isDesktopHost = desktopHost;
