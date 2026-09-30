import { describe, expect, it } from 'vitest';
import { fuzzy } from './CommandPalette';

describe('command palette fuzzy match', () => {
  it('ranks word-start substrings above inner substrings above subsequences', () => {
    const start = fuzzy('Switch to main', 'main')!, inner = fuzzy('Remain here', 'main')!, loose = fuzzy('Merge and integrate', 'main')!;
    expect(start.score).toBeLessThan(inner.score);
    expect(inner.score).toBeLessThan(loose.score);
    expect(start.hits).toEqual([10, 11, 12, 13]);
  });
  it('rejects out-of-order characters and accepts empty queries', () => {
    expect(fuzzy('Fetch', 'hf')).toBeNull();
    expect(fuzzy('Fetch', '  ')).toEqual({ score: 0, hits: [] });
  });
});
