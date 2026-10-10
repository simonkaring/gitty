// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearGravatarCache, FAILURE_TTL_MS, gravatarImageFailed, gravatarUrl, markGravatarImageFailed, normalizeGravatarEmail } from './gravatar';

afterEach(() => { clearGravatarCache(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Gravatar hashing', () => {
  it('normalizes email and produces the official SHA-256 URL', async () => {
    expect(normalizeGravatarEmail(' MyEmailAddress@example.com ')).toBe('myemailaddress@example.com');
    await expect(gravatarUrl(' MyEmailAddress@example.com ')).resolves.toBe('https://gravatar.com/avatar/84059b07d4be67b806386c0aad8070a23f18836bbaae342275dc0a83414c32ee?s=64&d=404');
  });
  it('rejects invalid email and gracefully skips unavailable crypto', async () => {
    for (const email of ['', 'bad', 'a @b.com', 'a\nb@example.com', `${'a'.repeat(250)}@b.com`]) expect(normalizeGravatarEmail(email)).toBeNull();
    await expect(gravatarUrl('ada@example.com', null)).resolves.toBeNull();
  });
  it('deduplicates concurrent hashes and reuses completed values', async () => {
    const digest = vi.spyOn(crypto.subtle, 'digest');
    const first = gravatarUrl('A@example.com'), second = gravatarUrl(' a@example.com ');
    await expect(first).resolves.toBe(await second);
    await gravatarUrl('a@example.com');
    expect(digest).toHaveBeenCalledTimes(1);
  });
});
describe('Gravatar failure cache', () => {
  it('remembers failed images for ten minutes, then allows a retry', () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    expect(FAILURE_TTL_MS).toBe(600_000);
    markGravatarImageFailed('Ada@Example.com');
    expect(gravatarImageFailed('ada@example.com')).toBe(true);
    vi.advanceTimersByTime(9 * 60_000 + 59_000);
    expect(gravatarImageFailed('ada@example.com')).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(gravatarImageFailed('ada@example.com')).toBe(false);
  });
  it('bounds the failure cache', () => {
    for (let i = 0; i < 600; i++) markGravatarImageFailed(`u${i}@example.com`);
    expect(gravatarImageFailed('u0@example.com')).toBe(false);
    expect(gravatarImageFailed('u599@example.com')).toBe(true);
  });
});
