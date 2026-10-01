import { expect, it } from 'vitest';
import { initials } from './ui';

it('initials uses first and last word, max two letters', () => {
  expect(initials('Anna Maria Lopez')).toBe('AL');
  expect(initials('  ada  ')).toBe('A');
  expect(initials('')).toBe('?');
});
