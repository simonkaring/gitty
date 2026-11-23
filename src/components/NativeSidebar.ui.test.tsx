// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { NativeSidebar } from './NativeSidebar';
import type { RepositoryState } from '../model/repository';
import { DEFAULT_SIDEBAR_SECTIONS, type SidebarSectionConfig } from '../model/settings';

it('double-click switches local and origin branches but not tags or other remotes', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const state: RepositoryState = {
    session: { handle: 'test', location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'tip', headRef: 'refs/heads/main' },
    refs: [
      { name: 'topic', fullName: 'refs/heads/topic', kind: 'local', commitId: 'tip' },
      { name: 'origin/feature/topic', fullName: 'refs/remotes/origin/feature/topic', kind: 'remote', commitId: 'tip' },
      { name: 'upstream/topic', fullName: 'refs/remotes/upstream/topic', kind: 'remote', commitId: 'tip' },
      { name: 'origin/HEAD', fullName: 'refs/remotes/origin/HEAD', kind: 'remote', commitId: 'tip' },
      { name: 'v1', fullName: 'refs/tags/v1', kind: 'tag', commitId: 'tip' },
    ], remotes: ['origin', 'upstream'], fingerprint: '',
  };
  const switchBranch = vi.fn();
  const host = document.createElement('div'); const root = createRoot(host);
  try {
    await act(async () => { root.render(<NativeSidebar state={state} commits={[]} filters={null} busy={false} reveal={() => {}} switchBranch={switchBranch} openMenu={() => {}} onAction={() => {}} folderOpen={{}} onFolderOpen={() => {}} />); });
    for (const button of host.querySelectorAll('.ref-item')) {
      await act(async () => { button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    }
    expect(switchBranch.mock.calls).toEqual([['refs/heads/topic'], ['refs/remotes/origin/feature/topic']]);
    expect(host.querySelector('[title="refs/remotes/origin/HEAD"]')).toBeNull();
  } finally { await act(async () => { root.unmount(); }); }
});

it('shows a tree icon for a local branch checked out in another worktree', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const state: RepositoryState = {
    session: { handle: 'test', location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'tip', headRef: 'refs/heads/main' },
    refs: [
      { name: 'topic', fullName: 'refs/heads/topic', kind: 'local', commitId: 'tip' },
      { name: 'other', fullName: 'refs/heads/other', kind: 'local', commitId: 'tip' },
    ], remotes: [], fingerprint: '',
  };
  const host = document.createElement('div'); const root = createRoot(host);
  try {
    await act(async () => { root.render(<NativeSidebar state={state} commits={[]} filters={null} busy={false} reveal={() => {}} switchBranch={() => {}} openMenu={() => {}} onAction={() => {}} folderOpen={{}} onFolderOpen={() => {}} worktreeRefs={new Set(['refs/heads/topic'])} />); });
    const item = (name: string) => host.querySelector(`[aria-label="local refs/heads/${name}"]`)!;
    expect(item('topic').querySelector('.lucide-tree-pine')).not.toBeNull();
    expect(item('topic').getAttribute('title')).toContain('another worktree');
    expect(item('other').querySelector('.lucide-tree-pine')).toBeNull();
  } finally { await act(async () => { root.unmount(); }); }
});

it('opens folder actions for local and origin folders by right-click, button and keyboard only', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const state: RepositoryState = {
    session: { handle: 'test', location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'tip', headRef: 'refs/heads/main' },
    refs: [
      { name: 'feat/a', fullName: 'refs/heads/feat/a', kind: 'local', commitId: 'tip' },
      { name: 'origin/feat/a', fullName: 'refs/remotes/origin/feat/a', kind: 'remote', commitId: 'tip' },
      { name: 'upstream/feat/a', fullName: 'refs/remotes/upstream/feat/a', kind: 'remote', commitId: 'tip' },
    ], remotes: ['origin', 'upstream'], fingerprint: '',
  };
  const openFolderMenu = vi.fn();
  const onFolderOpen = vi.fn();
  const host = document.createElement('div'); const root = createRoot(host);
  try {
    await act(async () => { root.render(<NativeSidebar state={state} commits={[]} filters={null} busy={false} reveal={() => {}} switchBranch={() => {}} openMenu={() => {}} onAction={() => {}} folderOpen={{}} onFolderOpen={onFolderOpen} openFolderMenu={openFolderMenu} />); });
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.reference-folder-actions')].map(button => button.getAttribute('aria-label'));
    expect(buttons).toEqual(['Actions for folder feat/', 'Actions for folder origin/feat/']);
    const local = host.querySelector<HTMLElement>('summary[title="feat"]')!;
    await act(async () => { local.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 6 })); });
    expect(openFolderMenu).toHaveBeenLastCalledWith({ kind: 'local', path: 'feat' }, 5, 6, local);
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Actions for folder origin/feat/"]')!.click(); });
    expect(openFolderMenu.mock.lastCall![0]).toEqual({ kind: 'origin', path: 'feat' });
    await act(async () => { local.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true })); });
    expect(openFolderMenu).toHaveBeenCalledTimes(3);
    const upstream = host.querySelector<HTMLElement>('summary[title="upstream/feat"]')!;
    await act(async () => { upstream.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    expect(openFolderMenu).toHaveBeenCalledTimes(3);
    expect(onFolderOpen).not.toHaveBeenCalled();
  } finally { await act(async () => { root.unmount(); }); }
});

it('orders and hides sections from the options menu', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const state: RepositoryState = {
    session: { handle: 'test', location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'tip', headRef: 'refs/heads/main' },
    refs: [{ name: 'main', fullName: 'refs/heads/main', kind: 'local', commitId: 'tip' }, { name: 'v1', fullName: 'refs/tags/v1', kind: 'tag', commitId: 'tip' }], remotes: [], fingerprint: '',
  };
  const onSectionsChange = vi.fn();
  const host = document.createElement('div'); const root = createRoot(host);
  const render = (sections: SidebarSectionConfig[]) => act(async () => { root.render(<NativeSidebar state={state} commits={[]} filters={null} busy={false} reveal={() => {}} switchBranch={() => {}} openMenu={() => {}} onAction={() => {}} folderOpen={{}} onFolderOpen={() => {}} sections={sections} onSectionsChange={onSectionsChange} />); });
  const titles = () => [...host.querySelectorAll('.reference-group > summary')].map(summary => summary.textContent?.replace(/\d+$/, ''));
  try {
    await render(DEFAULT_SIDEBAR_SECTIONS);
    expect(titles()).toEqual(['Local branches', 'Remote branches', 'Tags', 'Stashes']);
    await render([{ id: 'tag', visible: true }, { id: 'local', visible: true }, { id: 'remote', visible: false }, { id: 'worktrees', visible: true }, { id: 'stash', visible: false }, { id: 'remotes', visible: true }]);
    expect(titles()).toEqual(['Tags', 'Local branches']);
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Customize sidebar sections"]')!.click(); });
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Move Tags down"]')!.click(); });
    expect(onSectionsChange.mock.lastCall![0].map((section: SidebarSectionConfig) => section.id)).toEqual(['local', 'tag', 'remote', 'worktrees', 'stash', 'remotes']);
    await act(async () => { host.querySelector<HTMLButtonElement>('.history-column-reset-btn')!.click(); });
    expect(onSectionsChange.mock.lastCall![0]).toEqual(DEFAULT_SIDEBAR_SECTIONS);
  } finally { await act(async () => { root.unmount(); }); }
});

it('lists the stash with pop and drop actions, confirming a drop once', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const state: RepositoryState = {
    session: { handle: 'test', location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'tip', headRef: 'refs/heads/main' },
    refs: [{ name: 'stash', fullName: 'refs/stash', kind: 'stash', commitId: 'stash-oid' }], remotes: [], fingerprint: '',
  };
  const onStash = vi.fn();
  const host = document.createElement('div'); const root = createRoot(host);
  const noop = () => {};
  try {
    await act(async () => { root.render(<NativeSidebar state={state} commits={[]} filters={null} busy={false} reveal={noop} switchBranch={noop} openMenu={noop} onAction={noop} folderOpen={{}} onFolderOpen={noop} onStash={onStash} />); });
    const row = host.querySelector<HTMLButtonElement>('[aria-label="stash refs/stash"]')!;
    expect(row.textContent).toContain('stash');
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Pop stash"]')!.click(); });
    expect(onStash).toHaveBeenLastCalledWith({ kind: 'pop', oid: 'stash-oid', restoreIndex: true });
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Drop stash"]')!.click(); });
    expect(onStash).toHaveBeenCalledTimes(1);
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Confirm drop stash"]')!.click(); });
    expect(onStash).toHaveBeenLastCalledWith({ kind: 'drop', oid: 'stash-oid' });
  } finally { await act(async () => { root.unmount(); }); }
});
