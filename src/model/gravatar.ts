const MAX_CACHE_ENTRIES = 500;
const FAILURE_TTL_MS = 2_000;
const cache = new Map<string, { promise: Promise<string | null>; failedAt?: number }>();
const imageFailures = new Map<string, number>();

export function normalizeGravatarEmail(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  if (!normalized || normalized.length > 254 || /[\s\u0000-\u001f\u007f]/.test(normalized) || !/^[^@]+@[^@]+$/.test(normalized)) return null;
  return normalized;
}

export function clearGravatarCache() { cache.clear(); imageFailures.clear(); }
export function gravatarImageFailed(email: string): boolean {
  const normalized = normalizeGravatarEmail(email);
  if (!normalized) return false;
  const failedAt = imageFailures.get(normalized);
  if (failedAt === undefined) return false;
  if (Date.now() - failedAt >= FAILURE_TTL_MS) { imageFailures.delete(normalized); return false; }
  return true;
}
export function markGravatarImageFailed(email: string) {
  const normalized = normalizeGravatarEmail(email);
  if (!normalized) return;
  imageFailures.delete(normalized); imageFailures.set(normalized, Date.now());
  while (imageFailures.size > MAX_CACHE_ENTRIES) imageFailures.delete(imageFailures.keys().next().value!);
}

export async function gravatarUrl(email: string, cryptoApi: Pick<Crypto, 'subtle'> | null = globalThis.crypto): Promise<string | null> {
  const normalized = normalizeGravatarEmail(email);
  if (!normalized || !cryptoApi?.subtle?.digest) return null;
  const now = Date.now();
  const existing = cache.get(normalized);
  if (existing && (existing.failedAt === undefined || now - existing.failedAt < FAILURE_TTL_MS)) {
    cache.delete(normalized); cache.set(normalized, existing);
    return existing.promise;
  }
  if (existing) cache.delete(normalized);
  const promise = (async () => {
    try {
      const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      return `https://gravatar.com/avatar/${hash}?s=64&d=404`;
    } catch { return null; }
  })();
  const entry: { promise: Promise<string | null>; failedAt?: number } = { promise };
  cache.set(normalized, entry);
  void promise.then(url => { if (!url && cache.get(normalized) === entry) entry.failedAt = Date.now(); });
  while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  return promise;
}
