import { describe, expect, it } from 'vitest';
import { commitDate, commitIsoString, formatCommitDate } from './dates';

describe('commit dates', () => {
  it('converts native seconds, including epoch and pre-epoch values', () => {
    expect(commitDate(1_700_000_000)?.toISOString()).toBe('2023-11-14T22:13:20.000Z');
    expect(commitDate(0)?.toISOString()).toBe('1970-01-01T00:00:00.000Z');
    expect(commitDate(-86_400)?.toISOString()).toBe('1969-12-31T00:00:00.000Z');
  });

  it('rejects non-finite and out-of-range values', () => {
    for (const bad of [NaN, Infinity, -Infinity, 1e12, 8.64e15, 1e20, -1e12, Number.MAX_SAFE_INTEGER]) expect(commitDate(bad)).toBeNull();
    expect(commitDate('1700000000' as unknown as number)).toBeNull();
  });

  it('never treats seconds as milliseconds', () => {
    expect(commitDate(1_700_000_000_000)).toBeNull();
  });

  it('formats with a fallback and never throws', () => {
    const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' };
    expect(formatCommitDate(1_700_000_000, options, 'en')).toBe('Nov 14, 2023');
    expect(formatCommitDate(1e15, options, 'en')).toBe('—');
    expect(formatCommitDate(NaN)).toBe('—');
    expect(formatCommitDate(1, { timeZone: 'Not/AZone' })).toBe('—');
  });

  it('returns an empty ISO string for invalid values', () => {
    expect(commitIsoString(1_700_000_000)).toBe('2023-11-14T22:13:20.000Z');
    expect(commitIsoString(1e15)).toBe('');
    expect(commitIsoString(NaN)).toBe('');
  });
});
