// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearGravatarCache, gravatarUrl, normalizeGravatarEmail } from './gravatar';

afterEach(() => { clearGravatarCache(); vi.restoreAllMocks(); });

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
