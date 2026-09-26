// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { OperationDialog } from './OperationDialog';
import type { OperationState } from '../model/operations';
import type { CommitSummary, RepositoryState } from '../model/repository';

const capture = vi.hoisted(() => vi.fn());
vi.mock('../model/operationFlow', () => ({ captureOperation: capture }));

const commits: CommitSummary[] = ['c', 'b', 'a', 'base'].map((id, index) => ({
  id, parents: index < 3 ? [['b'], ['a'], ['base']][index] : [],
  subject: `Commit ${id}`, author: 'Test', email: 'test@example.com', timestamp: 0,
}));
const state = {
  session: { handle: 'handle', location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'c', headRef: 'refs/heads/main' },
  refs: [{ name: 'base', fullName: 'refs/heads/base', commitId: 'base', kind: 'local' }],
  remotes: [], fingerprint: 'fingerprint',
} satisfies RepositoryState;
const operation: OperationState = { kind: 'none', label: '', current: null, incoming: null, step: null, total: null, conflicts: [], canContinue: false, canSkip: false, fingerprint: 'reviewed' };

it('reviews the keyboard-accessible ordered rebase plan before sending the captured request', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  const host = document.createElement('div'); const root = createRoot(host);
  const onWrite = vi.fn(async () => {});
  capture.mockImplementation(async (_: string, action: unknown) => ({ action, expectedHead: 'c', expectedHeadRef: 'refs/heads/main', expectedOperation: 'reviewed' }));
  try {
    await act(async () => { root.render(<OperationDialog state={state} operation={operation} context={{ oid: 'base', initial: 'interactiveRebase' }} commits={commits} busy={false} onWrite={onWrite} onCompare={() => {}} onPullRequest={() => {}} onClose={() => {}} />); });
    const select = [...host.querySelectorAll('select')].find(node => node.getAttribute('aria-label') === 'Action for b')!;
    await act(async () => { select.value = 'squash'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    const earlier = [...host.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'Move c earlier')! as HTMLButtonElement;
    await act(async () => { earlier.click(); });
    await act(async () => { ([...host.querySelectorAll('button')].find(button => button.textContent === 'Review operation') as HTMLButtonElement).click(); });
    const reviewed = capture.mock.calls.at(-1)![1];
    expect(reviewed.steps.map((step: { oid: string }) => step.oid)).toEqual(['a', 'c', 'b']);
    expect(reviewed.steps[2].instruction).toBe('squash');
    expect(host.querySelector('ol[aria-label="Reviewed rebase order"]')?.textContent).toContain('Commit b');
    await act(async () => { ([...host.querySelectorAll('button')].find(button => button.textContent === 'Execute operation') as HTMLButtonElement).click(); });
    expect(onWrite).toHaveBeenCalledWith('repository_run_operation', { request: expect.objectContaining({ action: reviewed, expectedOperation: 'reviewed' }) });
  } finally {
    await act(async () => { root.unmount(); });
  }
});
