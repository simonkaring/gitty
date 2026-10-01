// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IntegrationsSettings } from './IntegrationsSettings';

const mocks = vi.hoisted(() => ({ native: vi.fn<(...args: unknown[]) => Promise<unknown>>() }));
vi.mock('../model/native', () => ({ native: mocks.native, errorMessage: String }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));

let container: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.native.mockReset().mockResolvedValueOnce([]);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(<IntegrationsSettings />); });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.useRealTimers();
});

const authorization = { id: 'request-one', userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device', interval: 5, expiresIn: 900 };
async function click(text: string) {
  await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === text)!.click(); });
}

it('opens provider sign-in, honors polling intervals and stores only account metadata in the UI', async () => {
  vi.useFakeTimers();
  mocks.native.mockImplementation(async (command) => {
    if (command === 'provider_oauth_start') return authorization;
    if (command === 'provider_oauth_poll') return { account: { id: 'account', provider: 'github', username: 'alice' }, interval: 0 };
  });
  await click('Connect GitHub in browser');
  expect(container.textContent).toContain('ABCD-EFGH');
  expect(mocks.native).toHaveBeenCalledWith('open_external_url', { url: authorization.verificationUri });
  expect(mocks.native).not.toHaveBeenCalledWith('provider_oauth_poll', expect.anything());
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(mocks.native).toHaveBeenCalledWith('provider_oauth_poll', { id: authorization.id });
  expect(container.textContent).toContain('alice');
  expect(container.textContent).not.toContain('ABCD-EFGH');
});

it('cancels sign-in and stops polling when dismissed', async () => {
  vi.useFakeTimers();
  mocks.native.mockImplementation(async command => command === 'provider_oauth_start' ? authorization : undefined);
  await click('Connect GitHub in browser');
  await click('Cancel sign-in');
  expect(mocks.native).toHaveBeenCalledWith('provider_oauth_cancel', { id: authorization.id });
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(mocks.native).not.toHaveBeenCalledWith('provider_oauth_poll', expect.anything());
  expect(container.textContent).not.toContain('ABCD-EFGH');
});

it('shows missing-registration errors and keeps the token fallback available', async () => {
  mocks.native.mockRejectedValueOnce(new Error('Browser sign-in is not configured in this build'));
  await click('Connect GitHub in browser');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('not configured');
  expect(container.textContent).toContain('Connect with an access token instead');
  expect(mocks.native).not.toHaveBeenCalledWith('open_external_url', expect.anything());
});

async function enter(label: string, value: string) {
  const input = [...container.querySelectorAll('input')].find(item => item.closest('label')?.textContent === label)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('sends a token to native storage and never displays it as account metadata', async () => {
  mocks.native.mockResolvedValueOnce({ id: 'one', provider: 'github', username: 'alice' });
  await enter('Account username', 'alice');
  await enter('Access token', 'example-secret');
  await act(async () => {
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(mocks.native).toHaveBeenCalledWith('provider_connect_token', { provider: 'github', username: 'alice', token: 'example-secret' });
  expect(container.textContent).toContain('alice');
  expect(container.textContent).not.toContain('example-secret');
  expect([...container.querySelectorAll('input')].find(input => input.type === 'password')?.value).toBe('');
});
