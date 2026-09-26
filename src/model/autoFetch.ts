/** Background fetch runs only for the focused tab: at most once per interval,
 * checked when a repository opens, when its tab or the window regains focus,
 * and on a short timer while it stays focused. */
export const AUTO_FETCH_INTERVAL = 5 * 60 * 1000;
export const AUTO_FETCH_CHECK = 30 * 1000;

export type FetchStatus =
  | { kind: 'idle' }
  | { kind: 'fetching'; since: number }
  | { kind: 'fetched'; at: number }
  | { kind: 'failed'; at: number; message: string };

/** `lastAttempt` is null until the first attempt, so a newly opened repository fetches immediately. */
export function autoFetchDue(lastAttempt: number | null, now: number, interval = AUTO_FETCH_INTERVAL): boolean {
  return lastAttempt === null || now - lastAttempt >= interval;
}

/** Explicit fetches and pulls refresh remote-tracking refs too, so they count as a fetch. */
export function isFetchingAction(action: unknown): boolean {
  const kind = (action as { kind?: unknown } | null)?.kind;
  return kind === 'fetch' || kind === 'pull' || kind === 'backgroundFetch';
}

export function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

export function describeFetchStatus(status: FetchStatus, now: number): string {
  switch (status.kind) {
    case 'idle': return '';
    case 'fetching': return 'Fetching…';
    case 'fetched': return `Fetched ${relativeTime(status.at, now)}`;
    case 'failed': return `Fetch failed ${relativeTime(status.at, now)}`;
  }
}
