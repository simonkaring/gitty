// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { DiffPreview, WorkingChanges } from './WorkingChanges';
import type { FileDiff, RepositorySession, StatusEntry } from '../model/repository';
import { DEFAULT_SETTINGS } from '../model/settings';

const nativeCall = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock('../model/native', async importOriginal => ({ ...await importOriginal<typeof import('../model/native')>(), native: nativeCall }));
vi.mock('../model/settings', async importOriginal => ({ ...await importOriginal<typeof import('../model/settings')>(), useSettings: () => ({ settings: DEFAULT_SETTINGS, updateSettings: vi.fn(), openSettings: vi.fn() }) }));

const diff: FileDiff = {
  path: 'file.txt', binary: false, truncated: false, message: null,
  hunkAction: { fingerprint: 'backend-token', reason: null },
  hunks: [0, 1].map(i => ({ header: `@@ -${i * 20 + 1},1 +${i * 20 + 1},1 @@`, lines: [{ kind: 'add', content: 'changed', oldLine: null, newLine: i * 20 + 1 }] })),
};

function renderTree(props: Parameters<typeof DiffPreview>[0]): ReactNode {
  let tree: ReactNode = null;
  function Wrapper() {
    tree = DiffPreview(props);
    return tree;
  }
  renderToStaticMarkup(createElement(Wrapper));
  return tree;
}

function buttons(node: ReactNode): ReactElement<{ disabled?: boolean; onClick?: () => void; className?: string; 'aria-pressed'?: boolean; 'aria-label'?: string; children?: ReactNode }>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return element.type === 'button' ? [element as ReturnType<typeof buttons>[number]] : buttons(element.props.children);
}

const hunkButtons = (tree: ReactNode) => buttons(tree).filter(b => b.props.className === 'hunk-action-button');
const lineButtons = (tree: ReactNode) => buttons(tree).filter(b => b.props.className === 'line-select-toggle');

it('combines unstaged and new files while preserving diff and staging actions', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const session: RepositorySession = { handle: 'repo', location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'head', headRef: 'refs/heads/main' };
  const modified: StatusEntry = { path: 'z.txt', oldPath: null, indexStatus: '.', worktreeStatus: 'M', conflicted: false, untracked: false };
  const added = { ...modified, path: 'a.txt', untracked: true };
  const staged = { ...modified, path: 'staged.txt', indexStatus: 'A', worktreeStatus: '.' };
  const deleted = { ...modified, path: 'deleted.txt', worktreeStatus: 'D' };
  const stagedDeleted = { ...modified, path: 'staged-deleted.txt', indexStatus: 'D', worktreeStatus: '.' };
  const renamed = { ...staged, path: 'renamed.txt', oldPath: 'old.txt', indexStatus: 'R' };
  const copied = { ...staged, path: 'copied.txt', oldPath: 'source.txt', indexStatus: 'C' };
  const conflict = { ...modified, path: 'conflict.txt', indexStatus: 'U', worktreeStatus: 'U', conflicted: true };
  const onMutation = vi.fn(async () => ({}));
  const loadDiff = vi.fn(async () => diff);
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => { root.render(createElement(WorkingChanges, { session, status: { entries: [modified, added, staged, deleted, stagedDeleted, renamed, copied, conflict], head: 'head', headRef: session.headRef, fingerprint: 'status' }, revision: 0, busy: false, onMutation, loadDiff, onRefresh: async () => {} })); });
    expect(host.querySelector('[aria-label="Untracked files"]')).toBeNull();
    const unstaged = host.querySelector('[aria-label="Unstaged files"]')!;
    expect(unstaged.querySelector('h2')?.textContent).toBe('Unstaged3');
    expect([...unstaged.querySelectorAll('strong')].map(node => node.textContent)).toEqual(['a.txt', 'deleted.txt', 'z.txt']);
    expect(unstaged.querySelector('[aria-label="New file"]')).not.toBeNull();
    expect(unstaged.querySelector('[aria-label="Modified file"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Staged files"] [aria-label="New file"]')).not.toBeNull();
    expect(unstaged.querySelector('[aria-label="Deleted file"]')?.getAttribute('data-status')).toBe('deleted');
    expect(host.querySelector('[aria-label="Staged files"] [aria-label="Deleted file"]')?.getAttribute('data-status')).toBe('deleted');
    expect(host.querySelector('[aria-label="Staged: renamed.txt"] [aria-label="Renamed file"]')?.getAttribute('data-status')).toBe('renamed');
    expect(host.querySelector('[aria-label="Staged: copied.txt"] [aria-label="Copied file"]')?.getAttribute('data-status')).toBe('copied');
    expect(host.querySelector('[aria-label="Conflicts: conflict.txt"] [aria-label="Conflict file"]')?.getAttribute('data-status')).toBe('conflict');
    expect(host.querySelector('.working-file .badge')).toBeNull();
    await act(async () => { (host.querySelector('[aria-label="Untracked: a.txt"]') as HTMLButtonElement).click(); });
    expect(loadDiff).toHaveBeenLastCalledWith('repo', { kind: 'untracked' }, 'a.txt');
    await act(async () => { (host.querySelector('[aria-label="Stage a.txt"]') as HTMLButtonElement).click(); });
    expect(onMutation).toHaveBeenCalledWith({ kind: 'stage', paths: ['a.txt'] });
    await act(async () => { (host.querySelector('[aria-label="Unstaged: z.txt"]') as HTMLButtonElement).click(); });
    expect(loadDiff).toHaveBeenLastCalledWith('repo', { kind: 'unstaged' }, 'z.txt');
  } finally { await act(async () => { root.unmount(); }); }
});

describe('hunk preview actions', () => {
  it.each([false, true])('routes the selected complete hunk in split=%s', split => {
    for (const kind of ['stage_hunk', 'unstage_hunk'] as const) {
      const onHunk = vi.fn();
      const tree = renderTree({ diff, split, hunkAction: kind, onHunk });
      const actions = hunkButtons(tree);
      expect(actions).toHaveLength(2);
      actions[1].props.onClick?.();
      expect(onHunk).toHaveBeenCalledExactlyOnceWith({ kind, path: 'file.txt', hunkIndex: 1, fingerprint: 'backend-token' });
      const html = renderToStaticMarkup(createElement(() => DiffPreview({ diff, split, hunkAction: kind, onHunk })));
      expect(html).toContain(`${kind === 'stage_hunk' ? 'Stage' : 'Unstage'} hunk 2 in file.txt`);
      expect(html).toContain(split ? 'split-row' : 'line-number');
    }
  });

  it.each([false, true])('renders line selection toggles and routes selected lines in split=%s', split => {
    for (const kind of ['stage_hunk', 'unstage_hunk'] as const) {
      const onHunk = vi.fn();
      const tree = renderTree({ diff, split, hunkAction: kind, onHunk });
      const toggles = lineButtons(tree);
      expect(toggles).toHaveLength(2);
      expect(toggles[0].props['aria-pressed']).toBe(false);
      expect(toggles[0].props['aria-label']).toContain(`Select line 1 for ${kind === 'stage_hunk' ? 'staging' : 'unstaging'}`);

      // With line 0 selected in hunk 1:
      const treeWithSelection = renderTree({ diff, split, hunkAction: kind, onHunk, selectedLines: { 1: [0] } });
      const selectedToggles = lineButtons(treeWithSelection);
      expect(selectedToggles[1].props['aria-pressed']).toBe(true);
      expect(selectedToggles[1].props['aria-label']).toContain(`Deselect line 21 for ${kind === 'stage_hunk' ? 'staging' : 'unstaging'}`);

      // Hunk button label changed to "selected lines":
      const hButtons = hunkButtons(treeWithSelection);
      expect(hButtons[1].props['aria-label']).toContain(`${kind === 'stage_hunk' ? 'Stage' : 'Unstage'} selected lines 2 in file.txt`);
      hButtons[1].props.onClick?.();
      expect(onHunk).toHaveBeenCalledExactlyOnceWith({
        kind,
        path: 'file.txt',
        hunkIndex: 1,
        fingerprint: 'backend-token',
        lineIndices: [0],
      });
    }
  });

  it('toggles line selection state when toggle buttons are clicked', () => {
    const onToggleLine = vi.fn();
    const tree = renderTree({ diff, split: false, hunkAction: 'stage_hunk', onToggleLine });
    const toggles = lineButtons(tree);
    toggles[0].props.onClick?.();
    expect(onToggleLine).toHaveBeenCalledExactlyOnceWith(0, 0);
  });

  it('does not allow a retained line selection to submit while writes are blocked', () => {
    const onHunk = vi.fn();
    const onToggleLine = vi.fn();
    const tree = renderTree({ diff, split: false, hunkAction: 'stage_hunk', selectedLines: { 0: [0] }, busy: true, onHunk, onToggleLine });
    expect(lineButtons(tree)[0].props['aria-pressed']).toBe(true);
    expect(hunkButtons(tree)[0].props.disabled).toBe(true);
    expect(lineButtons(tree)[0].props.disabled).toBe(true);
    hunkButtons(tree)[0].props.onClick?.();
    lineButtons(tree)[0].props.onClick?.();
    expect(onHunk).not.toHaveBeenCalled();
    expect(onToggleLine).not.toHaveBeenCalled();
  });

  it.each([
    { busy: true },
    { unavailable: 'Unavailable in demo. Open a desktop repository.' },
    { diff: { ...diff, truncated: true } },
    { diff: { ...diff, binary: true } },
    { diff: { ...diff, hunkAction: null } },
    { diff: { ...diff, hunkAction: { fingerprint: null, reason: 'Use whole-file staging for renames.' } } },
  ])('disables and guards unavailable actions: %j', overrides => {
    const onHunk = vi.fn();
    const tree = renderTree({ diff, split: false, hunkAction: 'stage_hunk', onHunk, ...overrides });
    for (const action of buttons(tree)) {
      expect(action.props.disabled).toBeTruthy();
      action.props.onClick?.();
    }
    expect(onHunk).not.toHaveBeenCalled();
    if (!('busy' in overrides)) {
      expect(renderToStaticMarkup(createElement(() => DiffPreview({ diff, split: false, hunkAction: 'stage_hunk', onHunk, ...overrides })))).toContain('hunk-unavailable');
    }
  });

  it('keeps historical and untracked previews read-only', () => {
    expect(buttons(renderTree({ diff, split: false }))).toEqual([]);
  });
});

const session: RepositorySession = { handle: 'repo', location: { kind: 'native', path: '/repo' }, name: 'repo', root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, shallow: false, bare: false, head: 'head', headRef: 'refs/heads/main' };
const entry = (path: string, indexStatus: string, worktreeStatus: string, extra: Partial<StatusEntry> = {}): StatusEntry => ({ path, oldPath: null, indexStatus, worktreeStatus, conflicted: false, untracked: false, ...extra });
async function mount(entries: StatusEntry[], onMutation = vi.fn(async () => ({})), options: { handle?: string; busy?: boolean } = {}) {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(WorkingChanges, { session: { ...session, handle: options.handle ?? session.handle }, status: { entries, head: 'head', headRef: session.headRef, fingerprint: 'reviewed' }, revision: 0, busy: options.busy ?? false, onMutation, loadDiff: async () => diff, onRefresh: async () => {} })); });
  return { host, onMutation, unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
}
const click = (node: Element | null | undefined) => act(async () => { (node as HTMLButtonElement).click(); });
const find = (host: HTMLElement, text: RegExp) => [...host.querySelectorAll('button')].find(button => text.test(button.textContent ?? ''));


describe('discarding changes', () => {
  it('counts only what can be discarded, leaving staged-only, conflicted and intent-to-add entries out', async () => {
    const { host, unmount } = await mount([entry('edited', '.', 'M'), entry('fresh', '?', '?', { untracked: true }), entry('staged', 'M', '.'), entry('intent', '.', 'A'), entry('both', 'U', 'U', { conflicted: true })]);
    try { expect(find(host, /Discard all/)?.textContent).toBe('Discard all (2)'); } finally { await unmount(); }
  });
  it('asks first, names the files, and sends the reviewed fingerprint only after confirmation', async () => {
    const { host, onMutation, unmount } = await mount([entry('edited', '.', 'M'), entry('partial', 'M', 'M'), entry('fresh', '?', '?', { untracked: true }), entry('staged', 'M', '.')]);
    try {
      await click(find(host, /Discard all/));
      expect(onMutation).not.toHaveBeenCalled();
      const dialog = host.querySelector('dialog.discard-dialog')!;
      expect([...dialog.querySelectorAll('.discard-list li')].map(li => li.textContent)).toEqual(['edited', 'fresh · untracked, deleted', 'partial']);
      expect(dialog.textContent).toContain('cannot be undone');
      expect(dialog.textContent).toContain('deleted from disk');
      expect(dialog.textContent).toContain('Staged changes are kept');
      expect(document.activeElement?.textContent).toBe('Cancel');
      await click(find(host, /^Discard 3 files$/));
      expect(onMutation).toHaveBeenCalledExactlyOnceWith({ kind: 'discard', paths: ['edited', 'fresh', 'partial'], expectedStatusFingerprint: 'reviewed' });
      expect(host.querySelector('dialog')).toBeNull();
    } finally { await unmount(); }
  });
  it('cancelling changes nothing and offers no discard when nothing qualifies', async () => {
    const { host, onMutation, unmount } = await mount([entry('edited', '.', 'M')]);
    try {
      await click(find(host, /Discard all/));
      await click(find(host, /^Cancel$/));
      expect(host.querySelector('dialog')).toBeNull(); expect(onMutation).not.toHaveBeenCalled();
    } finally { await unmount(); }
    const none = await mount([entry('staged', 'M', '.')]);
    try { expect((find(none.host, /Discard all/) as HTMLButtonElement).disabled).toBe(true); } finally { await none.unmount(); }
  });
});

describe('file context menu', () => {
  const rightClick = async (host: HTMLElement, label: string) => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 });
    await act(async () => { host.querySelector(`[aria-label="${label}"]`)!.closest('.working-file')!.dispatchEvent(event); });
    return event;
  };
  const items = () => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')] as HTMLButtonElement[];
  const labels = () => items().map(item => item.textContent);
  const item = (text: RegExp) => items().find(node => text.test(node.textContent ?? ''))!;
  const rows = [entry('edited', '.', 'M'), entry('fresh', '?', '?', { untracked: true }), entry('staged', 'M', '.'), entry('both', 'U', 'U', { conflicted: true }), entry('gone', '.', 'D')];
  beforeEach(() => { nativeCall.mockClear(); });

  it('replaces the default menu, so right-click no longer selects text', async () => {
    const { host, unmount } = await mount(rows);
    try {
      const event = await rightClick(host, 'Unstaged: edited');
      expect(event.defaultPrevented).toBe(true);
      expect(document.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('Actions for edited');
    } finally { await unmount(); }
  });
  it('offers the actions that fit each kind of row', async () => {
    const { host, unmount } = await mount(rows);
    try {
      await rightClick(host, 'Unstaged: edited');
      expect(labels()).toEqual(['Stage', 'Discard changes…', 'Copy path', 'Copy file name', 'Open file', expect.stringMatching(/Reveal in Finder|Show in/)]);
      await rightClick(host, 'Untracked: fresh');
      expect(labels()).toEqual(['Stage', 'Discard changes…', 'Add to .gitignore', 'Copy path', 'Copy file name', 'Open file', expect.stringMatching(/Reveal in Finder|Show in/)]);
      await rightClick(host, 'Staged: staged');
      expect(labels()).toEqual(['Unstage', 'Copy path', 'Copy file name', 'Open file', expect.stringMatching(/Reveal in Finder|Show in/)]);
      await rightClick(host, 'Conflicts: both');
      expect(labels()).toEqual(['Copy path', 'Copy file name', 'Open file', expect.stringMatching(/Reveal in Finder|Show in/)]);
      await rightClick(host, 'Unstaged: gone');
      expect(item(/Open file/).disabled).toBe(true); expect(item(/Reveal in Finder|Show in/).disabled).toBe(true);
    } finally { await unmount(); }
  });
  it('stages through the same path rules as the row button and closes itself', async () => {
    const { host, onMutation, unmount } = await mount(rows);
    try {
      await rightClick(host, 'Unstaged: edited');
      await click(item(/^Stage$/));
      expect(onMutation).toHaveBeenCalledExactlyOnceWith({ kind: 'stage', paths: ['edited'] });
      expect(document.querySelector('[role="menu"]')).toBeNull();
      await rightClick(host, 'Staged: staged');
      await click(item(/^Unstage$/));
      expect(onMutation).toHaveBeenLastCalledWith({ kind: 'unstage', paths: ['staged'] });
    } finally { await unmount(); }
  });
  it('discards one file only after the confirmation, using the fingerprint it showed', async () => {
    const { host, onMutation, unmount } = await mount(rows);
    try {
      await rightClick(host, 'Untracked: fresh');
      await click(item(/Discard changes/));
      expect(onMutation).not.toHaveBeenCalled();
      expect([...host.querySelectorAll('.discard-list li')].map(li => li.textContent)).toEqual(['fresh · untracked, deleted']);
      await click(find(host, /^Discard 1 file$/));
      expect(onMutation).toHaveBeenCalledExactlyOnceWith({ kind: 'discard', paths: ['fresh'], expectedStatusFingerprint: 'reviewed' });
    } finally { await unmount(); }
  });
  it('ignores an untracked file through the write path', async () => {
    const { host, onMutation, unmount } = await mount(rows);
    try {
      await rightClick(host, 'Untracked: fresh');
      await click(item(/Add to \.gitignore/));
      expect(onMutation).toHaveBeenCalledExactlyOnceWith({ kind: 'ignore', path: 'fresh' });
    } finally { await unmount(); }
  });
  it('copies the path and the file name', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const { host, unmount } = await mount([entry('src/deep/file.ts', '.', 'M')]);
    try {
      await rightClick(host, 'Unstaged: src/deep/file.ts');
      await click(item(/Copy path/));
      await rightClick(host, 'Unstaged: src/deep/file.ts');
      await click(item(/Copy file name/));
      expect(writeText.mock.calls).toEqual([['src/deep/file.ts'], ['file.ts']]);
      expect(host.querySelector('.workflow-status')?.textContent).toBe('Copied file name.');
    } finally { await unmount(); }
  });
  it('opens and reveals through the backend without taking the write lock, and surfaces refusals', async () => {
    const { host, onMutation, unmount } = await mount(rows);
    try {
      await rightClick(host, 'Unstaged: edited');
      await click(item(/Open file/));
      expect(nativeCall).toHaveBeenLastCalledWith('repository_open_path', { handle: 'repo', path: 'edited' });
      nativeCall.mockRejectedValueOnce({ code: 'openRefused', message: 'Gitty will not open this file: it is executable.' });
      await rightClick(host, 'Unstaged: edited');
      await click(item(/Reveal in Finder|Show in/));
      expect(nativeCall).toHaveBeenLastCalledWith('repository_reveal_path', { handle: 'repo', path: 'edited' });
      expect(host.querySelector('.workflow-alert.error')?.textContent).toContain('it is executable');
      expect(onMutation).not.toHaveBeenCalled();
    } finally { await unmount(); }
  });
  it('disables writes while busy and desktop-only actions in the demo', async () => {
    const busy = await mount(rows, undefined, { busy: true });
    try {
      await rightClick(busy.host, 'Untracked: fresh');
      for (const text of [/^Stage$/, /Discard changes/, /Add to \.gitignore/]) expect(item(text).disabled).toBe(true);
      expect(item(/Copy path/).disabled).toBe(false);
    } finally { await busy.unmount(); }
    const demo = await mount(rows, undefined, { handle: 'demo:repo' });
    try {
      await rightClick(demo.host, 'Untracked: fresh');
      for (const text of [/Add to \.gitignore/, /Open file/, /Reveal in Finder|Show in/]) expect(item(text).disabled).toBe(true);
      expect(item(/^Stage$/).disabled).toBe(false);
    } finally { await demo.unmount(); }
  });
  it('opens from the keyboard, moves focus past disabled items, and closes on Escape', async () => {
    const { host, unmount } = await mount(rows);
    try {
      const trigger = host.querySelector('[aria-label="Unstaged: gone"]') as HTMLButtonElement;
      await act(async () => { trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })); });
      expect(items().length).toBeGreaterThan(0);
      expect(document.activeElement).toBe(item(/^Stage$/));
      await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })); });
      // Open and reveal are disabled for a deleted file, so End stops on the last enabled item.
      expect(document.activeElement).toBe(item(/Copy file name/));
      await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    } finally { await unmount(); }
  });
});
