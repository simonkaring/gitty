import { describe, expect, it } from 'vitest';
import { AUTO_FETCH_INTERVAL, autoFetchDue, describeFetchStatus, isFetchingAction, relativeTime } from './autoFetch';

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
