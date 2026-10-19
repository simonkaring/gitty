// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { WorktreeDialog, Worktrees } from './Worktrees';
import type { RepositorySession } from '../model/repository';
import { worktreeLocation, type WorktreeAction, type Worktree } from '../model/worktrees';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('../model/native', () => ({ native: invoke, isDemoHandle: (handle: string) => handle.startsWith('demo:'), errorMessage: (e: unknown) => String(e) }));
const session: RepositorySession = { handle: 'h', location: { kind: 'wsl', distribution: 'Ubuntu', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'tip', headRef: 'refs/heads/main' };
const target: Worktree = { path: '/topic space', head: 'tip', branch: 'refs/heads/topic', main: false, bare: false, locked: null, prunable: null };
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  invoke.mockReset(); invoke.mockResolvedValue({ token: 'reviewed', preview: 'Removing worktrees/stale: missing' });
});
async function mount(initial: WorktreeAction = 'remove', onWrite = vi.fn().mockResolvedValue(undefined)) {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const onComplete = vi.fn(); const onClose = vi.fn();
  await act(async () => root.render(<WorktreeDialog session={session} initial={initial} target={initial === 'prune' ? undefined : target} busy={false} onWrite={onWrite} onClose={onClose} onComplete={onComplete} />));
  const submit = async () => { await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); };
  return { host, onWrite, onComplete, onClose, submit, cleanup: async () => { await act(async () => root.unmount()); host.remove(); } };
}

it('reviews before writing and submits a captured request only once', async () => {
  const t = await mount();
  try {
    expect(t.onWrite).not.toHaveBeenCalled();
    await t.submit(); expect(t.onWrite).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('repository_worktree_review', expect.objectContaining({ handle: 'h', request: expect.objectContaining({ action: 'remove', path: '/topic space', force: false }) }));
    await act(async () => { const form = t.host.querySelector('form')!; form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(t.onWrite).toHaveBeenCalledExactlyOnceWith('repository_worktree_execute', { token: 'reviewed', request: expect.objectContaining({ action: 'remove', force: false }) });
    expect(t.onComplete).toHaveBeenCalledOnce();
  } finally { await t.cleanup(); }
});

it('requires a fresh force review and acknowledgement, including keyboard form submission', async () => {
  const t = await mount();
  try {
    await t.submit();
    await act(async () => t.host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(t.host.textContent).toContain('permanently lost');
    expect(t.host.textContent).not.toContain('Review captured');
    await t.submit();
    await t.submit(); expect(t.onWrite).not.toHaveBeenCalled();
    expect(t.host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    await act(async () => t.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1].click());
    await t.submit();
    expect(t.onWrite).toHaveBeenCalledExactlyOnceWith('repository_worktree_execute', expect.objectContaining({ request: expect.objectContaining({ force: true }) }));
  } finally { await t.cleanup(); }
});

it('requires another explicit review after a failed write, without retrying', async () => {
  const t = await mount('remove', vi.fn().mockRejectedValue(new Error('staleOperation')));
  try {
    await t.submit(); await t.submit();
    expect(t.host.textContent).toContain('staleOperation');
    expect(t.host.textContent).not.toContain('Review captured');
    expect(t.onWrite).toHaveBeenCalledOnce(); expect(t.onComplete).not.toHaveBeenCalled();
    await t.submit(); expect(t.onWrite).toHaveBeenCalledOnce();
  } finally { await t.cleanup(); }
});

it('shows the prune preview and explicit expiry before execution', async () => {
  const t = await mount('prune');
  try {
    expect(t.host.textContent).toContain('expiry “now”');
    await t.submit(); expect(t.host.textContent).toContain('Removing worktrees/stale: missing');
    expect(t.onWrite).not.toHaveBeenCalled();
    await t.submit(); expect(t.onWrite).toHaveBeenCalledOnce();
  } finally { await t.cleanup(); }
});

it('opens a sibling worktree with its WSL distribution and marks the current worktree', async () => {
  const main = { ...target, path: '/repo', branch: 'refs/heads/main', main: true };
  invoke.mockResolvedValue([main, target]);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); const onOpen = vi.fn();
  try {
    await act(async () => root.render(<Worktrees session={session} active revision={0} busy={false} onOpen={onOpen} onWrite={vi.fn()} />));
    expect(host.querySelector('[aria-current="true"]')?.getAttribute('title')).toBe('/repo');
    await act(async () => host.querySelector<HTMLButtonElement>('[title="/topic space"]')!.click());
    expect(onOpen).toHaveBeenCalledExactlyOnceWith({ kind: 'wsl', distribution: 'Ubuntu', path: '/topic space' });
    expect(worktreeLocation({ kind: 'wsl', distribution: 'Debian', path: '/repo' }, '/topic')).toEqual({ kind: 'wsl', distribution: 'Debian', path: '/topic' });
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it('shows demo worktrees but disables management', async () => {
  invoke.mockResolvedValue([{ ...target, path: '/repo', main: true }]);
  const host = document.createElement('div'); const root = createRoot(host);
  try {
    await act(async () => root.render(<Worktrees session={{ ...session, handle: 'demo:repo' }} active revision={0} busy={false} onOpen={vi.fn()} onWrite={vi.fn()} />));
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Create worktree"]')!.disabled).toBe(true);
    expect(host.textContent).toContain('requires a real repository');
  } finally { await act(async () => root.unmount()); }
});
