// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PullRequestDialog } from './PullRequestDialog';

const mocks = vi.hoisted(() => ({ native: vi.fn<(...args: unknown[]) => Promise<unknown>>() }));
vi.mock('../model/native', () => ({ native: mocks.native, errorMessage: String }));

let container: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true, value() { this.setAttribute('open', ''); },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.native.mockReset().mockImplementation(async (command: unknown) => {
    if (command === 'repository_remotes') return [{ name: 'origin', fetchUrl: 'https://github.com/org/repo.git', pushUrl: 'https://github.com/org/repo.git', branches: ['main', 'topic'], currentUpstream: null }];
    if (command === 'list_provider_accounts') return [{ id: 'alice-id', provider: 'github', username: 'alice' }];
    if (command === 'provider_pull_requests') return [];
    if (command === 'provider_create_pull_request') return { id: '2', title: 'Add feature', source: 'topic', target: 'main', url: 'https://github.com/org/repo/pull/2', state: 'open' };
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(<PullRequestDialog handle="repo" source="refs/heads/topic" onClose={() => {}} />); });
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

it('lists requests and creates one through the selected account without pushing', async () => {
  expect(mocks.native).toHaveBeenCalledWith('provider_pull_requests', { handle: 'repo', remote: 'origin', accountId: 'alice-id' });
  await enter('Base branch', 'main');
  await enter('Title', 'Add feature');
  await act(async () => {
    [...container.querySelectorAll('button')].find(button => button.textContent === 'Create pull request')!.click();
  });
  expect(mocks.native).toHaveBeenCalledWith('provider_create_pull_request', {
    handle: 'repo', remote: 'origin', accountId: 'alice-id',
    request: { source: 'topic', target: 'main', title: 'Add feature', description: '' },
  });
  expect(container.textContent).toContain('Add feature');
  expect(mocks.native.mock.calls.some(([command]) => command === 'repository_remote_action')).toBe(false);
});
