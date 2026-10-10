// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AskPassDialog } from './AskPassDialog';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  invoke: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.handlers.set(name, handler);
    return () => { mocks.handlers.delete(name); };
  }),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

let container: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() { this.setAttribute('open', ''); },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(<AskPassDialog />); });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  mocks.handlers.clear();
});

async function emit(name: string, payload: unknown) {
  await act(async () => { mocks.handlers.get(name)!({ payload }); });
}
function button(label: string): HTMLButtonElement {
  return [...container.querySelectorAll('button')].find((node) => node.textContent === label)!;
}

describe('AskPassDialog', () => {
  it('answers the username prompt using its requestId, then cancels the password prompt', async () => {
    await emit('git_askpass_prompt', { requestId: 1, prompt: 'Username for example' });
    await emit('git_askpass_prompt', { requestId: 2, prompt: 'Password for example' });
    expect(container.querySelector('dialog')?.hasAttribute('open')).toBe(true);
    const input = container.querySelector('input')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'test-user');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(mocks.invoke).toHaveBeenCalledWith('repository_provide_password', { requestId: 1, password: 'test-user' });
    expect(container.querySelector('input')?.type).toBe('password');
    await act(async () => { button('Cancel').click(); });
    expect(mocks.invoke).toHaveBeenCalledWith('repository_provide_password', { requestId: 2, password: null });
    expect(container.querySelector('dialog')).toBeNull();
  });

  it('closes on cancellation even if the prompt expired before the reply', async () => {
    await emit('git_askpass_prompt', { requestId: 3, prompt: 'Username for example' });
    mocks.invoke.mockRejectedValueOnce(new Error('Invalid request ID'));
    await act(async () => { button('Cancel').click(); });
    expect(container.querySelector('dialog')).toBeNull();
  });

  it('shows the repository and operation separately from Git\'s own prompt text', async () => {
    await emit('git_askpass_prompt', { requestId: 4, prompt: 'Password for https://example.test', context: { repository: 'gitty', operation: 'push origin' } });
    const dialog = container.querySelector('dialog')!;
    const text = dialog.textContent ?? '';
    expect(text).toContain('gitty · push origin');
    expect(text).toContain('Git says: Password for https://example.test');
    expect(text.indexOf('gitty · push origin')).toBeLessThan(text.indexOf('Git says:'));
  });

  it('omits the context line when the prompt has none', async () => {
    await emit('git_askpass_prompt', { requestId: 5, prompt: 'Password for example', context: null });
    expect(container.querySelector('.askpass-context')).toBeNull();
    expect(container.querySelector('dialog')?.textContent).toContain('Git says: Password for example');
    await act(async () => { button('Cancel').click(); });
    await emit('git_askpass_prompt', { requestId: 6, prompt: 'Password for example' });
    expect(container.querySelector('.askpass-context')).toBeNull();
  });
});
