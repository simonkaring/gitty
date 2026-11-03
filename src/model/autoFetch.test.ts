import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTO_FETCH_INTERVAL, SSH_REFRESH_INTERVAL, WATCHED_REFRESH_INTERVAL, createChangeRefresher, watchSupported, autoFetchDue, backgroundFetchAllowed, describeFetchStatus, isFetchingAction, relativeTime, routineRefreshInterval } from './autoFetch';

describe('auto-fetch scheduling', () => {
  it('fetches immediately on first check, then once per interval', () => {
    expect(autoFetchDue(null, 1000)).toBe(true);
    expect(autoFetchDue(1000, 1000 + AUTO_FETCH_INTERVAL - 1)).toBe(false);
    expect(autoFetchDue(1000, 1000 + AUTO_FETCH_INTERVAL)).toBe(true);
  });
  it('counts explicit fetch and pull, not push or stash', () => {
    expect(isFetchingAction({ kind: 'fetch' })).toBe(true);
    expect(isFetchingAction({ kind: 'pull', pullMode: 'ffOnly' })).toBe(true);
    expect(isFetchingAction({ kind: 'backgroundFetch' })).toBe(true);
    expect(isFetchingAction({ kind: 'push' })).toBe(false);
    expect(isFetchingAction({ kind: 'save' })).toBe(false);
    expect(isFetchingAction(undefined)).toBe(false);
  });
  it('describes status with relative time', () => {
    const now = 10 * 60 * 1000;
    expect(relativeTime(now - 5000, now)).toBe('just now');
    expect(relativeTime(now - 3 * 60 * 1000, now)).toBe('3 min ago');
    expect(relativeTime(now - 2 * 60 * 60 * 1000, now)).toBe('2 h ago');
    expect(describeFetchStatus({ kind: 'idle' }, now)).toBe('');
    expect(describeFetchStatus({ kind: 'fetching', since: now }, now)).toBe('Fetching…');
    expect(describeFetchStatus({ kind: 'fetched', at: now - 120000 }, now)).toBe('Fetched 2 min ago');
    expect(describeFetchStatus({ kind: 'failed', at: now, message: 'auth' }, now)).toBe('Fetch failed just now');
  });
});

describe('SSH cadence', () => {
  it('polls a remote host less often than a local repository', () => {
    expect(routineRefreshInterval('native')).toBe(5000);
    expect(routineRefreshInterval('wsl')).toBe(5000);
    expect(routineRefreshInterval('ssh')).toBe(SSH_REFRESH_INTERVAL);
    expect(SSH_REFRESH_INTERVAL).toBeGreaterThan(5000);
  });
  it('does not background-fetch a remote host on a timer', () => {
    expect(backgroundFetchAllowed('native')).toBe(true);
    expect(backgroundFetchAllowed('wsl')).toBe(true);
    expect(backgroundFetchAllowed('ssh')).toBe(false);
  });
});

describe('watched refresh policy', () => {
  it('keeps the five-second poll unless a native watcher is active', () => {
    expect(routineRefreshInterval('native', false)).toBe(5000);
    expect(routineRefreshInterval('native', true)).toBe(WATCHED_REFRESH_INTERVAL);
    expect(WATCHED_REFRESH_INTERVAL).toBeGreaterThanOrEqual(30000);
    expect(routineRefreshInterval('ssh', false)).toBe(SSH_REFRESH_INTERVAL);
    expect(watchSupported('native')).toBe(true);
    expect(watchSupported('wsl')).toBe(false);
    expect(watchSupported('ssh')).toBe(false);
  });
});

describe('change events', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  function setup() {
    const flags = { visible: true, busy: false };
    let finish: () => void = () => {};
    const run = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const refresher = createChangeRefresher({ visible: () => flags.visible, busy: () => flags.busy, run });
    return { flags, run, refresher, finish: async () => { finish(); await vi.advanceTimersByTimeAsync(0); } };
  }
  it('refreshes once per event and coalesces events during a refresh', async () => {
    const { run, refresher, finish } = setup();
    refresher.request();
    expect(run).toHaveBeenCalledTimes(1);
    refresher.request(); refresher.request();
    expect(run).toHaveBeenCalledTimes(1);
    await finish();
    expect(run).toHaveBeenCalledTimes(2);
    await finish();
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('retries after a read or write in flight instead of dropping the event', async () => {
    const { flags, run, refresher } = setup();
    flags.busy = true;
    refresher.request();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).not.toHaveBeenCalled();
    flags.busy = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('waits for a hidden tab or window to become visible', async () => {
    const { flags, run, refresher } = setup();
    flags.visible = false;
    refresher.request();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).not.toHaveBeenCalled();
    flags.visible = true;
    refresher.flush();
    expect(run).toHaveBeenCalledTimes(1);
    refresher.flush();
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('stops after disposal', async () => {
    const { flags, run, refresher } = setup();
    flags.busy = true;
    refresher.request();
    refresher.dispose();
    flags.busy = false;
    await vi.advanceTimersByTimeAsync(1000);
    refresher.request();
    expect(run).not.toHaveBeenCalled();
  });
});
