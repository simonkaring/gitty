// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { OperationDialog } from './OperationDialog';
import type { OperationState } from '../model/operations';
import type { RepositoryState } from '../model/repository';

const nativeCall = vi.hoisted(() => vi.fn());
vi.mock('../model/native', () => ({ native: nativeCall, errorMessage: (error: unknown) => String(error) }));
const state: RepositoryState = {
  session: { handle: 'handle', location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'head', headRef: 'refs/heads/main' },
  refs: [{ name: 'topic', fullName: 'refs/heads/topic', commitId: 'tip', kind: 'local' }], remotes: [], fingerprint: 'state',
};
const idle: OperationState = { kind: 'none', label: '', current: null, incoming: null, step: null, total: null, conflicts: [], canContinue: false, canSkip: false, fingerprint: 'idle' };

it.each([[true, false], [false, false], [true, true]])('reviews merge policy noFastForward=%s and explicit stashChanges=%s', async (noFastForward, stashChanges) => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  nativeCall.mockImplementation(async (command: string) => command === 'repository_state' ? state : idle);
  const onWrite = vi.fn().mockResolvedValue(undefined);
  const host = document.createElement('div'), root = createRoot(host);
  const button = (text: string) => [...host.querySelectorAll('button')].find(value => value.textContent === text)!;
  async function edit(value: string) {
    const textarea = host.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  try {
    await act(async () => { root.render(<OperationDialog state={state} operation={idle} context={{ oid: 'tip', ref: 'refs/heads/topic', destination: 'refs/heads/release', initial: 'merge' }} commits={[]} busy={false} onWrite={onWrite} onCompare={() => {}} onPullRequest={() => {}} onClose={() => {}} />); });
    expect(host.querySelector('textarea')!.value).toBe("Merge branch 'topic' into 'release'");
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
    const stashCheck = host.querySelector<HTMLInputElement>('input[aria-describedby="merge-stash-help"]')!;
    expect(stashCheck.checked).toBe(false);
    await edit(' \n');
    expect(button('Review operation').disabled).toBe(true);
    const message = 'Integrate topic\n\nReady for the release.';
    await edit(message);
    if (!noFastForward) await act(async () => { host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
    if (stashChanges) await act(async () => { stashCheck.click(); });
    await act(async () => { button('Review operation').click(); });
    expect(host.querySelector('section[aria-label="Operation summary"]')!.textContent).toContain(noFastForward ? 'Always create a merge commit (--no-ff).' : 'Allow fast-forward when possible; otherwise create a merge commit.');
    expect(host.querySelector('section[aria-label="Operation summary"] pre')!.textContent).toBe(message);
    if (stashChanges) expect(host.querySelector('section[aria-label="Operation summary"]')!.textContent).toContain('Stash before merging and restore staging afterward.');
    await act(async () => { button('Back').click(); });
    expect(host.querySelector('textarea')!.value).toBe(message);
    await act(async () => { button('Review operation').click(); });
    await act(async () => { button('Execute operation').click(); });
    expect(onWrite).toHaveBeenCalledWith('repository_run_operation', { request: {
      action: { kind: 'merge', source: 'refs/heads/topic', destination: 'refs/heads/release', noFastForward, message, ...(stashChanges ? { stashChanges: true } : {}) },
      expectedHead: 'head', expectedHeadRef: 'refs/heads/main', expectedOperation: 'idle',
    } });
  } finally {
    await act(async () => { root.unmount(); });
  }
});
