// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthorAvatar } from './AuthorAvatar';

const mocks = vi.hoisted(() => ({ gravatarUrl: vi.fn<(email: string) => Promise<string | null>>(), failed: vi.fn(() => false), markFailed: vi.fn() }));
vi.mock('../model/gravatar', () => ({ gravatarUrl: mocks.gravatarUrl, gravatarImageFailed: mocks.failed, markGravatarImageFailed: mocks.markFailed }));
const roots: Array<{ root: ReturnType<typeof createRoot>; host: HTMLDivElement }> = [];
afterEach(async () => {
  for (const { root } of roots.splice(0)) await act(async () => root.unmount());
  mocks.gravatarUrl.mockReset(); mocks.failed.mockReset().mockReturnValue(false); mocks.markFailed.mockReset();
});
beforeEach(() => { mocks.gravatarUrl.mockResolvedValue(null); });
function mount() {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'), root = createRoot(host); roots.push({ root, host });
  return { host, render: (props: { name: string; email: string; mode?: 'initials' | 'gravatar'; tiny?: boolean }) => act(async () => root.render(<AuthorAvatar {...props} />)) };
}

it('shows initials without requesting an image by default or for invalid emails', async () => {
  const { host, render } = mount();
  await render({ name: 'Ada Lovelace', email: 'bad-email' });
  expect(host.querySelector('.avatar')?.textContent).toBe('AL');
  expect(host.querySelector('img')).toBeNull(); expect(mocks.gravatarUrl).not.toHaveBeenCalled();
  await render({ name: 'Ada Lovelace', email: 'bad-email', mode: 'gravatar' });
  expect(host.querySelector('img')).toBeNull();
});

it('renders an accessible decorative image after the hash, handles failure, and suppresses stale responses', async () => {
  let resolve!: (url: string | null) => void;
  mocks.gravatarUrl.mockImplementation(() => new Promise(done => { resolve = done; }));
  const { host, render } = mount();
  await render({ name: 'Ada Lovelace', email: 'ada@example.com', mode: 'gravatar', tiny: true });
  await act(async () => resolve('https://gravatar.com/avatar/hash?s=64&d=404'));
  const image = host.querySelector('img')!;
  expect(image.getAttribute('alt')).toBe(''); expect(image.getAttribute('referrerpolicy')).toBe('no-referrer'); expect(image.getAttribute('decoding')).toBe('async'); expect(image.draggable).toBe(false);
  await act(async () => image.dispatchEvent(new Event('error')));
  expect(host.querySelector('img')).toBeNull(); expect(mocks.markFailed).toHaveBeenCalledWith('ada@example.com');

  let oldResolve!: (url: string | null) => void;
  mocks.gravatarUrl.mockImplementation(() => new Promise(done => { oldResolve = done; }));
  await render({ name: 'Grace', email: 'grace@example.com', mode: 'gravatar' });
  await render({ name: 'Grace', email: 'grace@example.com', mode: 'initials' });
  await act(async () => oldResolve('https://gravatar.com/avatar/old'));
  expect(host.querySelector('img')).toBeNull(); expect(host.querySelector('.avatar')?.textContent).toBe('G');
});

it('removes the image immediately when email or mode changes', async () => {
  mocks.gravatarUrl.mockImplementation(async email => `https://gravatar.com/avatar/${email}`);
  const { host, render } = mount();
  await render({ name: 'Ada', email: 'ada@example.com', mode: 'gravatar' });
  const adaImage = host.querySelector('img')!;
  expect(adaImage).not.toBeNull();
  await act(async () => adaImage.dispatchEvent(new Event('load')));
  expect(adaImage.style.opacity).toBe('1');
  await render({ name: 'Grace', email: 'grace@example.com', mode: 'gravatar' });
  expect(mocks.gravatarUrl).toHaveBeenLastCalledWith('grace@example.com');
  const graceImage = host.querySelector('img')!;
  expect(graceImage).not.toBe(adaImage);
  expect(graceImage.style.opacity).toBe('');
  await act(async () => graceImage.dispatchEvent(new Event('load')));
  expect(graceImage.style.opacity).toBe('1');
  await render({ name: 'Grace', email: 'grace@example.com', mode: 'initials' });
  expect(host.querySelector('img')).toBeNull();
});
