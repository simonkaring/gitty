// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorDialog } from './EditorDialog';

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
  await act(async () => { root.render(<EditorDialog />); });
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

describe('EditorDialog', () => {
  it('queues prompts, saves exact text, and cancels the next prompt', async () => {
    expect(mocks.handlers.has('editor_prompt')).toBe(true);
    await emit('editor_prompt', { requestId: 1, fileName: 'COMMIT_EDITMSG', content: 'original\n' });
    await emit('editor_prompt', { requestId: 2, fileName: 'message', content: 'second\n' });
    expect(container.querySelector('dialog')?.hasAttribute('open')).toBe(true);
    const textarea = container.querySelector('textarea')!;
    expect(textarea.value).toBe('original\n');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, 'edited\n\n');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { button('Save').click(); });
    expect(mocks.invoke).toHaveBeenCalledWith('editor_reply', { requestId: 1, content: 'edited\n\n' });
    expect(container.querySelector('textarea')?.value).toBe('second\n');
    await act(async () => { button('Cancel').click(); });
    expect(mocks.invoke).toHaveBeenCalledWith('editor_reply', { requestId: 2, content: null });
    expect(container.querySelector('dialog')).toBeNull();
  });

  it('expires prompts and surfaces a failed reply without silently saving', async () => {
    await emit('editor_prompt', { requestId: 3, fileName: 'message', content: 'draft\n' });
    mocks.invoke.mockRejectedValueOnce(new Error('IPC unavailable'));
    await act(async () => { button('Save').click(); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('IPC unavailable');
    expect(container.querySelector('textarea')?.value).toBe('draft\n');
    await emit('editor_expired', 3);
    expect(container.querySelector('dialog')).toBeNull();
  });
});
