// Backend commit timestamps are always integer Unix seconds (src-tauri/src/commit.rs).
// These helpers never throw: untrusted values render as a fallback instead of crashing a pane.

const MAX_DATE_MS = 8.64e15;
// 1900-01-01 .. 9999-12-31 in seconds; anything else is treated as corrupt commit metadata.
const MIN_SECONDS = -2_208_988_800;
const MAX_SECONDS = 253_402_300_799;

export const INVALID_DATE_TEXT = '—';

/** Converts native commit seconds to a Date, or null when the value is not a plausible commit time. */
export function commitDate(seconds: number): Date | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  if (seconds < MIN_SECONDS || seconds > MAX_SECONDS || Math.abs(seconds * 1000) > MAX_DATE_MS) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale ?? ''}|${JSON.stringify(options)}`;
  let cached = formatters.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, cached);
  }
  return cached;
}

/** Formats commit seconds with a memoized Intl.DateTimeFormat; returns '—' for invalid values. */
export function formatCommitDate(seconds: number, options: Intl.DateTimeFormatOptions = {}, locale?: string): string {
  const date = commitDate(seconds);
  if (!date) return INVALID_DATE_TEXT;
  try {
    return formatter(locale, options).format(date);
  } catch {
    return INVALID_DATE_TEXT;
  }
}

/** ISO-8601 string for commit seconds, or '' when invalid (safe for `dateTime`/`title`). */
export function commitIsoString(seconds: number): string {
  return commitDate(seconds)?.toISOString() ?? '';
}

/** Local calendar-day group of a commit: stable key plus a "Today" / "Yesterday" / weekday / date label. */
export function commitDay(seconds: number, now = new Date()): { key: string; label: string } | null {
  const date = commitDate(seconds);
  if (!date) return null;
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(date)) / 864e5);
  const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  if (days === 0) return { key, label: 'Today' };
  if (days === 1) return { key, label: 'Yesterday' };
  if (days > 1 && days < 7) return { key, label: formatCommitDate(seconds, { weekday: 'long' }) };
  return { key, label: formatCommitDate(seconds, date.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }) };
}
