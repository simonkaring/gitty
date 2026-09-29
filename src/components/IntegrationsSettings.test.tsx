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
