// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { act, createElement, useState, type ReactElement, type ReactNode } from 'react';
import { DIFF_ROW_ESTIMATE } from './DiffPreview';
import { diffRows, type DiffRow } from '../model/splitDiff';
import { DEFAULT_WORKING_DISCLOSURE, DiffPreview, WorkingChanges, type ActiveDiffState, type WorkingDisclosure, type WorkingDisclosureUpdate } from './WorkingChanges';
import { commitProfileRepositoryKey } from '../model/commitProfiles';
import { draftKey, saveDraft } from '../model/workflow';
import type { FileDiff, RepositorySession, StatusEntry } from '../model/repository';
import { DEFAULT_SETTINGS } from '../model/settings';

const nativeCall = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined));
vi.mock('../model/native', async importOriginal => ({ ...await importOriginal<typeof import('../model/native')>(), native: nativeCall }));
const settingsMock = vi.hoisted(() => ({ overrides: {} as Record<string, unknown>, updateSettings: vi.fn(), openSettings: vi.fn() }));
vi.mock('../model/settings', async importOriginal => ({ ...await importOriginal<typeof import('../model/settings')>(), useSettings: () => ({ settings: { ...DEFAULT_SETTINGS, ...settingsMock.overrides }, updateSettings: settingsMock.updateSettings, openSettings: settingsMock.openSettings }) }));

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
  it('keeps before/after selection scoped to original line indices after pairing replacements', () => {
    const replacement: FileDiff = { ...diff, hunks: [{ header: '@@ -1,2 +1,1 @@', lines: [
      { kind: 'remove', content: 'old one', oldLine: 1, newLine: null },
      { kind: 'remove', content: 'old two', oldLine: 2, newLine: null },
      { kind: 'add', content: 'new one', oldLine: null, newLine: 1 },
    ] }] };
    const onHunk = vi.fn(), onToggleLine = vi.fn();
    const tree = renderTree({ diff: replacement, split: true, hunkAction: 'stage_hunk', selectedLines: { 0: [2, 0] }, onHunk, onToggleLine });
    const toggles = lineButtons(tree);
    expect(toggles.map(toggle => toggle.props['aria-pressed'])).toEqual([true, true, false]);
    toggles[1].props.onClick?.();
    expect(onToggleLine).toHaveBeenCalledWith(0, 2);
    hunkButtons(tree)[0].props.onClick?.();
    expect(onHunk).toHaveBeenCalledWith({ kind: 'stage_hunk', path: 'file.txt', hunkIndex: 0, fingerprint: 'backend-token', lineIndices: [0, 2] });
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(createElement(() => DiffPreview({ diff: replacement, split: true })));
    const rows = host.querySelectorAll('.split-row');
    expect(rows).toHaveLength(2);
    expect([...rows[0].querySelectorAll('.split-code')].map(code => code.textContent)).toEqual(['old one', 'new one']);
    expect(rows[1].querySelector('.split-cell-empty')).not.toBeNull();
  });
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

describe('stable staging updates', () => {
  it.each(['stage', 'unstage'] as const)('keeps feedback and sidebar content mounted during %s', async kind => {
    let finish!: (value: {}) => void;
    const onMutation = vi.fn(() => new Promise<{}>(resolve => { finish = resolve; }));
    const { host, unmount } = await mount([entry('edited', kind === 'stage' ? '.' : 'M', kind === 'stage' ? 'M' : '.')], onMutation);
    try {
      const feedback = host.querySelector('.working-feedback')!;
      const content = host.querySelector('.working-sidebar-content');
      const composer = host.querySelector('.commit-composer');
      expect(feedback.textContent).toBe('');
      await click(host.querySelector(`[aria-label="${kind === 'stage' ? 'Stage' : 'Unstage'} edited"]`));
      expect(feedback.textContent).toContain(kind === 'stage' ? 'Staging' : 'Unstaging');
      expect(host.querySelector('.working-sidebar-content')).toBe(content);
      expect(host.querySelector('.commit-composer')).toBe(composer);
      expect(host.querySelector<HTMLButtonElement>('.file-stage-button')!.disabled).toBe(true);
      await act(async () => { finish({}); });
      expect(host.querySelector('.working-feedback')).toBe(feedback);
      expect(feedback.textContent).toBe('');
      expect(host.querySelector('.workflow-status')).toBeNull();
      expect(host.querySelector('.working-sidebar-content')).toBe(content);
    } finally { await unmount(); }
  });

  it('retains the same diff during a write and refresh, blocks stale hunks, and clears it on file navigation', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    const root = createRoot(host);
    const onMutation = vi.fn(async () => ({}));
    let active: ActiveDiffState | null = null;
    const onActiveDiffChange = (value: ActiveDiffState | null) => { active = value; };
    let finish!: (value: FileDiff) => void;
    const loadDiff = vi.fn(() => new Promise<FileDiff>(resolve => { finish = resolve; }));
    const render = (revision: number, busy = false) => act(async () => {
      root.render(createElement(WorkingChanges, { session, status: { entries: [entry('edited', '.', 'M'), entry('other', '.', 'M')], head: 'head', headRef: session.headRef, fingerprint: `${revision}` }, revision, busy, onMutation, loadDiff, onActiveDiffChange, onRefresh: async () => {} }));
    });
    const latest = (): ActiveDiffState => active!;
    try {
      await render(0);
      await click(host.querySelector('[aria-label="Unstaged: edited"]'));
      await act(async () => { finish(diff); });
      expect(latest().diff).toBe(diff);
      await render(0, true);
      expect(latest().diff).toBe(diff);
      expect(latest().loading).toBe(false);
      expect(latest().busy).toBe(true);
      await render(1);
      expect(latest().diff).toBe(diff);
      expect(latest().busy).toBe(true);
      await act(async () => { latest().onHunk?.({ kind: 'stage_hunk', path: 'edited', hunkIndex: 0, fingerprint: 'backend-token' }); });
      expect(onMutation).not.toHaveBeenCalled();
      const refreshed = { ...diff, hunkAction: { fingerprint: 'new-token', reason: null } };
      await act(async () => { finish(refreshed); });
      expect(latest().diff).toBe(refreshed);
      expect(latest().busy).toBe(false);
      await click(host.querySelector('[aria-label="Unstaged: other"]'));
      expect(latest().diff).toBeNull();
      expect(latest().loading).toBe(true);
    } finally { await act(async () => { root.unmount(); }); }
  });
});


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
      expect(host.querySelector('.working-feedback')?.textContent).toBe('Copied file name.');
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

describe('disclosure controls', () => {
  type Props = Partial<Parameters<typeof WorkingChanges>[0]>;
  const mountWith = async (entries: StatusEntry[], props: Props = {}, onMutation = vi.fn(async () => ({}))) => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const element = (extra: Props = {}) => createElement(WorkingChanges, { session, status: { entries, head: 'head', headRef: session.headRef, fingerprint: 'reviewed' }, revision: 0, busy: false, onMutation, loadDiff: async () => diff, onRefresh: async () => {}, ...props, ...extra });
    await act(async () => { root.render(element()); });
    return { host, root, onMutation, element, unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
  };
  const toggle = (host: HTMLElement, name: string) => host.querySelector<HTMLButtonElement>(`h2 > button[aria-label^="${name},"]`)!;
  const composerToggle = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('.composer-toggle')!;
  const subject = (host: HTMLElement) => host.querySelector<HTMLInputElement>('input[name="subject"]')!;
  const hiddenInside = (node: Element | null) => !!node?.closest('[hidden]');
  const type = async (input: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const rows = [entry('edited', '.', 'M'), entry('fresh', '?', '?', { untracked: true }), entry('staged', 'M', '.')];
  const storage = { items: new Map<string, string>(), failing: false };
  beforeEach(() => {
    storage.items.clear(); storage.failing = false;
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.items.get(key) ?? null, setItem: (key: string, value: string) => { if (storage.failing) throw new Error('quota'); storage.items.set(key, value); }, removeItem: (key: string) => storage.items.delete(key) });
    saveDraft(draftKey(session), { subject: '', body: '' });
    nativeCall.mockReset(); nativeCall.mockResolvedValue(undefined); settingsMock.overrides = {}; settingsMock.updateSettings.mockClear(); settingsMock.openSettings.mockClear();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('renders conflicts, unstaged and staged as groups headed by an h2 containing a real toggle button', async () => {
    const { host, unmount } = await mountWith([...rows, entry('both', 'U', 'U', { conflicted: true })]);
    try {
      expect([...host.querySelectorAll('.working-category')].map(node => node.getAttribute('aria-label'))).toEqual(['Conflicts files', 'Unstaged files', 'Staged files']);
      const unstaged = toggle(host, 'Unstaged');
      expect(unstaged.parentElement?.tagName).toBe('H2');
      expect(unstaged.type).toBe('button');
      expect(unstaged.parentElement?.textContent).toBe('Unstaged2');
      expect(unstaged.getAttribute('aria-expanded')).toBe('true');
      const list = host.querySelector(`#${CSS.escape(unstaged.getAttribute('aria-controls')!)}`)!;
      expect(list.contains(host.querySelector('[aria-label="Untracked: fresh"]'))).toBe(true);
      expect(unstaged.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
      expect(new Set([...host.querySelectorAll('h2 > button')].map(node => node.getAttribute('aria-controls'))).size).toBe(3);
    } finally { await unmount(); }
  });

  it('folds a group without unmounting its rows, keeping the count and a stable controls id', async () => {
    const { host, unmount } = await mountWith(rows);
    try {
      const unstaged = toggle(host, 'Unstaged');
      const controls = unstaged.getAttribute('aria-controls');
      const stage = host.querySelector('[aria-label="Stage edited"]');
      await click(unstaged);
      expect(unstaged.getAttribute('aria-expanded')).toBe('false');
      expect(unstaged.getAttribute('aria-controls')).toBe(controls);
      const list = host.querySelector(`[id="${controls}"]`) as HTMLElement;
      expect(list.hidden).toBe(true);
      expect(list.contains(stage)).toBe(true);
      expect(stage?.isConnected).toBe(true);
      expect(unstaged.parentElement?.textContent).toBe('Unstaged2');
      expect(toggle(host, 'Staged').getAttribute('aria-expanded')).toBe('true');
      await click(unstaged);
      expect(unstaged.getAttribute('aria-expanded')).toBe('true');
      expect(list.hidden).toBe(false);
    } finally { await unmount(); }
  });

  it('keeps a folded Conflicts group visible and reopenable, while an empty one is not shown', async () => {
    const none = await mountWith(rows);
    try { expect((none.host.querySelector('.working-category.conflict') as HTMLElement).hidden).toBe(true); } finally { await none.unmount(); }
    const { host, unmount } = await mountWith([...rows, entry('both', 'U', 'U', { conflicted: true })]);
    try {
      const section = host.querySelector('.working-category.conflict') as HTMLElement;
      expect(section.hidden).toBe(false);
      expect(section.classList.contains('has-entries')).toBe(true);
      await click(toggle(host, 'Conflicts'));
      expect(section.hidden).toBe(false);
      expect(section.classList.contains('has-entries') && section.classList.contains('is-collapsed')).toBe(true);
      expect(toggle(host, 'Conflicts').getAttribute('aria-expanded')).toBe('false');
      await click(toggle(host, 'Conflicts'));
      expect(toggle(host, 'Conflicts').getAttribute('aria-expanded')).toBe('true');
      expect(hiddenInside(host.querySelector('[aria-label="Conflicts: both"]'))).toBe(false);
    } finally { await unmount(); }
  });

  it('re-opens a folded Conflicts group when conflicts appear after there were none', async () => {
    const calm = await mountWith(rows);
    try {
      await click(toggle(calm.host, 'Conflicts'));
      expect(toggle(calm.host, 'Conflicts').getAttribute('aria-expanded')).toBe('false');
      const conflicted = [...rows, entry('both', 'U', 'U', { conflicted: true })];
      await act(async () => { calm.root.render(calm.element({ status: { entries: conflicted, head: 'head', headRef: session.headRef, fingerprint: 'next' } })); });
      expect(toggle(calm.host, 'Conflicts').getAttribute('aria-expanded')).toBe('true');
    } finally { await calm.unmount(); }
  });

  it('keeps the selected file and its diff when the group holding it is folded', async () => {
    const onActiveDiffChange = vi.fn<(diff: ActiveDiffState | null) => void>();
    const { host, unmount } = await mountWith(rows, { onActiveDiffChange });
    try {
      await click(host.querySelector('[aria-label="Unstaged: edited"]'));
      await vi.waitFor(() => expect(onActiveDiffChange.mock.lastCall?.[0]?.diff).toBe(diff));
      const before = onActiveDiffChange.mock.calls.length;
      await click(toggle(host, 'Unstaged'));
      expect(onActiveDiffChange.mock.calls.slice(before).some(([value]) => value === null)).toBe(false);
      expect(onActiveDiffChange.mock.lastCall?.[0]).toMatchObject({ path: 'edited', group: 'unstaged' });
      expect(host.querySelector('[aria-label="Unstaged: edited"]')?.getAttribute('aria-pressed')).toBe('true');
      expect(toggle(host, 'Unstaged').hasAttribute('data-holds-selection')).toBe(true);
      expect(toggle(host, 'Staged').hasAttribute('data-holds-selection')).toBe(false);
    } finally { await unmount(); }
  });

  it('collapses and expands the composer from one labelled icon toggle without changing its h2 and count', async () => {
    const { host, onMutation, unmount } = await mountWith(rows);
    try {
      const heading = host.querySelector('.composer-heading')!;
      expect(heading.querySelector(':scope > h2')?.textContent).toBe('Create commit');
      expect(heading.querySelector(':scope > span')?.textContent).toBe('1 staged');
      expect(heading.querySelector('h2 button')).toBeNull();
      const button = composerToggle(host);
      const body = host.querySelector(`[id="${button.getAttribute('aria-controls')}"]`) as HTMLElement;
      expect(button.getAttribute('aria-label')).toBe('Collapse commit composer');
      expect(button.getAttribute('aria-expanded')).toBe('true');
      expect(body.hidden).toBe(false);
      await click(button);
      expect(button.getAttribute('aria-label')).toBe('Expand commit composer');
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(body.hidden).toBe(true);
      expect(hiddenInside(find(host, /Commit staged changes/) ?? null)).toBe(true);
      expect(hiddenInside(host.querySelector('input[type="checkbox"]'))).toBe(true);
      await click(button);
      expect(body.hidden).toBe(false);
      expect(onMutation).not.toHaveBeenCalled();
      expect(nativeCall).not.toHaveBeenCalled();
    } finally { await unmount(); }
  });

  it('keeps summary and description values across a collapse, flags the draft, and never submits', async () => {
    const { host, onMutation, unmount } = await mountWith(rows);
    try {
      await type(subject(host), 'feat: keep me');
      await type(host.querySelector('textarea')!, 'Some body');
      await click(composerToggle(host));
      expect(host.querySelector('.composer-draft')?.textContent).toBe('Draft');
      await click(composerToggle(host));
      expect(host.querySelector('.composer-draft')).toBeNull();
      expect(subject(host).value).toBe('feat: keep me');
      expect(host.querySelector('textarea')!.value).toBe('Some body');
      expect(onMutation).not.toHaveBeenCalled();
      await click(find(host, /Commit staged changes/));
      expect(onMutation).toHaveBeenCalledExactlyOnceWith({ kind: 'commit', message: 'feat: keep me\n\nSome body', identity: undefined });
    } finally { await unmount(); }
  });

  it('labels the summary and description visibly and keeps the textarea compact', async () => {
    const { host, unmount } = await mountWith(rows);
    try {
      expect(host.querySelector<HTMLLabelElement>(`label[for="${subject(host).id}"]`)?.textContent).toBe('Summary required');
      const body = host.querySelector('textarea')!;
      expect(host.querySelector(`label[for="${body.id}"]`)?.textContent).toBe('Description optional');
      expect(body.rows).toBe(2);
      expect(host.querySelector('.amend-control input')?.getAttribute('type')).toBe('checkbox');
      expect(host.querySelector('.amend-control')?.textContent).toBe('Amend last commit');
    } finally { await unmount(); }
  });

  it('keeps the storage warning visible outside a collapsed composer', async () => {
    storage.failing = true;
    const { host, unmount } = await mountWith(rows);
    try {
      await type(subject(host), 'draft');
      await click(composerToggle(host));
      const warning = [...host.querySelectorAll('small')].find(node => node.textContent === 'Storage unavailable. Draft is kept for this session only.')!;
      expect(warning).toBeTruthy();
      expect(hiddenInside(warning)).toBe(false);
    } finally { await unmount(); }
  });

  describe('amending', () => {
    const detail = { body: 'Original subject\n\nOriginal body' };
    const amendCheckbox = (host: HTMLElement) => host.querySelector<HTMLInputElement>('.amend-control input')!;
    it('restores the ordinary draft, preserves the author note and allows a zero-staged amend with every guard', async () => {
      nativeCall.mockResolvedValue(detail);
      const { host, onMutation, unmount } = await mountWith([entry('edited', '.', 'M')]);
      try {
        await type(subject(host), 'ordinary draft');
        await click(amendCheckbox(host));
        await vi.waitFor(() => expect(subject(host).value).toBe('Original subject'));
        expect(host.querySelector('.composer-heading > span')?.textContent).toBe('0 staged');
        expect(host.querySelector('.composer-heading h2')?.textContent).toBe('Rewrite last commit');
        expect(host.querySelector('.composer-amend-note')?.textContent).toBe('The original author is preserved when amending.');
        expect(hiddenInside(host.querySelector('.composer-amend-note'))).toBe(false);
        expect(host.querySelector('.composer-identity-role')?.textContent).toBe('Committer');
        expect(find(host, /^Rewrite last commit$/)?.hasAttribute('disabled')).toBe(false);
        await click(composerToggle(host)); await click(composerToggle(host));
        expect(onMutation).not.toHaveBeenCalled();
        await click(find(host, /^Rewrite last commit$/));
        expect(onMutation).toHaveBeenCalledExactlyOnceWith({ kind: 'amend', message: 'Original subject\n\nOriginal body', identity: undefined, expectedHead: 'head', expectedHeadRef: 'refs/heads/main', expectedStatusFingerprint: 'reviewed' });
        await click(amendCheckbox(host));
        expect(subject(host).value).toBe('ordinary draft');
        expect(host.querySelector('.composer-amend-note')).toBeNull();
        expect(host.querySelector('.composer-identity-role')?.textContent).toBe('Commit as');
      } finally { await unmount(); }
    });
    it('expands a collapsed composer when amending starts', async () => {
      nativeCall.mockResolvedValue(detail);
      const { host, unmount } = await mountWith(rows);
      try {
        await click(composerToggle(host));
        expect(composerToggle(host).getAttribute('aria-expanded')).toBe('false');
        await click(amendCheckbox(host));
        expect(composerToggle(host).getAttribute('aria-expanded')).toBe('true');
        expect(hiddenInside(subject(host))).toBe(false);
      } finally { await unmount(); }
    });
    it('keeps the loading status visible outside a collapsed body', async () => {
      let finish!: (value: unknown) => void;
      nativeCall.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
      const { host, unmount } = await mountWith(rows);
      try {
        await click(amendCheckbox(host));
        await click(composerToggle(host));
        const status = [...host.querySelectorAll('[role="status"]')].find(node => node.textContent === 'Loading last commit…')!;
        expect(status).toBeTruthy();
        expect(hiddenInside(status)).toBe(false);
        await act(async () => { finish(detail); });
        expect([...host.querySelectorAll('[role="status"]')].some(node => node.textContent === 'Loading last commit…')).toBe(false);
      } finally { await unmount(); }
    });
    it('keeps a failed amend load visible and recoverable outside a collapsed body', async () => {
      nativeCall.mockRejectedValue({ code: 'git', message: 'Last commit unavailable' });
      const { host, unmount } = await mountWith(rows);
      try {
        await click(amendCheckbox(host));
        await click(composerToggle(host));
        const alert = host.querySelector('.composer-feedback [role="alert"]')!;
        expect(alert.textContent).toContain('Last commit unavailable');
        expect(hiddenInside(alert)).toBe(false);
        expect(composerToggle(host).getAttribute('aria-expanded')).toBe('false');
        await click(composerToggle(host));
        await click(amendCheckbox(host));
        expect(host.querySelector('.composer-feedback [role="alert"]')).toBeNull();
        expect(subject(host).value).toBe('');
      } finally { await unmount(); }
    });
  });

  describe('commit identity', () => {
    const ada = { id: 'profile-ada', name: 'Ada Lovelace', email: 'ada@example.com' };
    const summary = (host: HTMLElement) => host.querySelector('.composer-identity > summary') as HTMLElement;
    const drawer = (host: HTMLElement) => host.querySelector('details.composer-identity') as HTMLDetailsElement;
    it('summarises the repository default when no profile is chosen and opens only on request', async () => {
      const { host, unmount } = await mountWith(rows);
      try {
        expect(summary(host).textContent).toBe('Commit as Repository default');
        expect(drawer(host).open).toBe(false);
        await click(summary(host));
        expect(drawer(host).open).toBe(true);
        const select = drawer(host).querySelector('select')!;
        expect(drawer(host).querySelector(`label[for="${select.id}"]`)?.textContent).toBe('Commit as');
        expect(select.value).toBe('');
        await click(find(host, /Manage profiles/));
        expect(settingsMock.openSettings).toHaveBeenCalledExactlyOnceWith('Commit profiles');
        await click(summary(host));
        expect(drawer(host).open).toBe(false);
      } finally { await unmount(); }
    });
    it('names the selected profile, passes it to commits and persists a change through settings only', async () => {
      settingsMock.overrides = { commitProfiles: [ada], repositoryCommitProfiles: { [commitProfileRepositoryKey(session)]: ada.id } };
      const { host, onMutation, unmount } = await mountWith(rows);
      try {
        expect(summary(host).querySelector('.composer-identity-name')?.textContent).toBe('Ada Lovelace');
        expect(summary(host).title).toBe('Ada Lovelace <ada@example.com>');
        await click(summary(host));
        const select = drawer(host).querySelector('select')!;
        expect(select.value).toBe(ada.id);
        await act(async () => { select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); });
        const update = settingsMock.updateSettings.mock.calls[0][0] as (current: typeof DEFAULT_SETTINGS) => unknown;
        expect(update({ ...DEFAULT_SETTINGS, repositoryCommitProfiles: { [commitProfileRepositoryKey(session)]: ada.id, other: 'x' } })).toEqual({ repositoryCommitProfiles: { other: 'x' } });
        await type(subject(host), 'feat: as ada');
        await click(find(host, /Commit staged changes/));
        expect(onMutation).toHaveBeenCalledExactlyOnceWith({ kind: 'commit', message: 'feat: as ada', identity: { name: 'Ada Lovelace', email: 'ada@example.com' } });
      } finally { await unmount(); }
    });
    it('falls back to the default label when the stored profile no longer exists', async () => {
      settingsMock.overrides = { repositoryCommitProfiles: { [commitProfileRepositoryKey(session)]: 'profile-gone' } };
      const { host, unmount } = await mountWith(rows);
      try { expect(summary(host).querySelector('.composer-identity-name')?.textContent).toBe('Repository default'); } finally { await unmount(); }
    });
  });

  it('can be driven by lifted state that survives the list unmounting, and local state works without it', async () => {
    let lifted: WorkingDisclosure = DEFAULT_WORKING_DISCLOSURE;
    const onDisclosureChange = (update: WorkingDisclosureUpdate) => { lifted = update(lifted); };
    const first = await mountWith(rows, { disclosure: lifted, onDisclosureChange });
    try {
      await click(toggle(first.host, 'Staged'));
      await click(composerToggle(first.host));
      await click(first.host.querySelector('details.composer-identity > summary'));
      // The parent owns the state, so nothing changed until it passes it back in.
      expect(toggle(first.host, 'Staged').getAttribute('aria-expanded')).toBe('true');
      expect(lifted).toEqual({ collapsed: { conflict: false, unstaged: false, staged: true }, composerCollapsed: true, identityOpen: true });
    } finally { await first.unmount(); }
    const second = await mountWith(rows, { disclosure: lifted, onDisclosureChange });
    try {
      expect(toggle(second.host, 'Staged').getAttribute('aria-expanded')).toBe('false');
      expect(toggle(second.host, 'Unstaged').getAttribute('aria-expanded')).toBe('true');
      expect(composerToggle(second.host).getAttribute('aria-expanded')).toBe('false');
      expect((second.host.querySelector('details.composer-identity') as HTMLDetailsElement).open).toBe(true);
    } finally { await second.unmount(); }
    const local = await mountWith(rows);
    try {
      await click(toggle(local.host, 'Staged'));
      expect(toggle(local.host, 'Staged').getAttribute('aria-expanded')).toBe('false');
    } finally { await local.unmount(); }
  });

  it('shares one lifted state object across remounts when the parent holds it', async () => {
    function Parent({ show }: { show: boolean }) {
      const [state, setState] = useState<WorkingDisclosure>(DEFAULT_WORKING_DISCLOSURE);
      return show ? createElement(WorkingChanges, { session, status: { entries: rows, head: 'head', headRef: session.headRef, fingerprint: 'reviewed' }, revision: 0, busy: false, onMutation: async () => ({}), loadDiff: async () => diff, onRefresh: async () => {}, disclosure: state, onDisclosureChange: update => setState(update) }) : null;
    }
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => { root.render(createElement(Parent, { show: true })); });
      await click(toggle(host, 'Unstaged'));
      expect(toggle(host, 'Unstaged').getAttribute('aria-expanded')).toBe('false');
    } finally { await act(async () => { root.unmount(); }); host.remove(); }
  });
});

describe('virtualized diff rows', () => {
  const HUNK_LINES = 10_000;
  /** Two 10,000-line hunks: mostly context, with a removal/addition pair every 100 lines. */
  const big: FileDiff = {
    path: 'big.txt', binary: false, truncated: false, message: null,
    hunkAction: { fingerprint: 'big-token', reason: null },
    hunks: [0, 1].map(h => ({ header: `@@ big ${h} @@`, lines: Array.from({ length: HUNK_LINES }, (_, i) => {
      const number = h * 100_000 + i;
      return i % 100 === 50 ? { kind: 'remove' as const, content: `removed ${i}`, oldLine: number, newLine: null }
        : i % 100 === 51 ? { kind: 'add' as const, content: `added ${i}`, oldLine: null, newLine: number }
        : { kind: 'context' as const, content: `context ${i}`, oldLine: number, newLine: number };
    }) })),
  };
  /** Offset of a row from the estimates DiffPreview uses before jsdom (which has no layout) measures anything. */
  const offsetOf = (split: boolean, predicate: (row: DiffRow, index: number) => boolean) => {
    const rows = diffRows(big.hunks, split);
    const index = rows.findIndex(predicate);
    let offset = 0;
    for (let i = 0; i < index; i++) offset += rows[i].kind === 'hunk' ? DIFF_ROW_ESTIMATE.hunk : split ? DIFF_ROW_ESTIMATE.split : DIFF_ROW_ESTIMATE.unified;
    return { index, offset, total: rows.reduce((sum, row) => sum + (row.kind === 'hunk' ? DIFF_ROW_ESTIMATE.hunk : split ? DIFF_ROW_ESTIMATE.split : DIFF_ROW_ESTIMATE.unified), 0) };
  };
  async function mountDiff(props: Parameters<typeof DiffPreview>[0]) {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => { root.render(createElement(DiffPreview, props)); });
    const surface = host.querySelector<HTMLElement>('.native-diff')!;
    let top = 0;
    Object.defineProperty(surface, 'clientHeight', { configurable: true, get: () => 600 });
    Object.defineProperty(surface, 'scrollTop', { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, value); } });
    const rows = () => [...host.querySelectorAll<HTMLElement>('[data-row]')];
    const spacers = () => [...host.querySelectorAll<HTMLElement>('.diff-virtual-spacer')].map(spacer => parseFloat(spacer.style.height));
    return {
      host, surface, rows, spacers,
      scrollTo: (value: number) => act(async () => { top = value; surface.dispatchEvent(new Event('scroll')); }),
      key: (key: string, target: Element = surface) => act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); }),
      button: (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`),
      unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); },
    };
  }

  it('renders a bounded window of a 20,000-line diff with spacers for the rest, and reaches off-screen hunk headers', async () => {
    const view = await mountDiff({ diff: big, split: false, hunkAction: 'stage_hunk', onHunk: vi.fn() });
    try {
      const { total, offset: secondHunk } = offsetOf(false, row => row.kind === 'hunk' && row.hunkIndex === 1);
      expect(view.surface.dataset.virtual).toBe('true');
      expect(view.rows().length).toBeLessThan(200);
      expect(Number(view.host.querySelector<HTMLElement>('.unified-content')!.dataset.virtualHeight)).toBe(total);
      const renderedHeight = view.rows().reduce((sum, row) => sum + (row.classList.contains('hunk-header') ? DIFF_ROW_ESTIMATE.hunk : DIFF_ROW_ESTIMATE.unified), 0);
      expect(view.spacers()[0] + renderedHeight + view.spacers()[1]).toBe(total);
      expect(view.button('Stage hunk 2 in big.txt')).toBeNull();

      await view.scrollTo(secondHunk - 100);
      const indices = view.rows().map(row => Number(row.dataset.row));
      expect(indices.length).toBeLessThan(200);
      expect(Math.min(...indices)).toBeGreaterThan(0);
      expect(view.spacers()[0]).toBe(offsetOf(false, (_, index) => index === Math.min(...indices)).offset);
      expect(view.button('Stage hunk 2 in big.txt')).not.toBeNull();
      expect(view.button('Stage hunk 1 in big.txt')).toBeNull();
      expect(view.spacers()[0] + view.rows().reduce((sum, row) => sum + (row.classList.contains('hunk-header') ? DIFF_ROW_ESTIMATE.hunk : DIFF_ROW_ESTIMATE.unified), 0) + view.spacers()[1]).toBe(total);
    } finally { await view.unmount(); }
  });

  it.each([false, true])('sends original line indices from rows deep in a virtualized diff in split=%s', async split => {
    const onHunk = vi.fn();
    const view = await mountDiff({ diff: big, split, hunkAction: 'stage_hunk', onHunk });
    try {
      const target = offsetOf(split, row => row.hunkIndex === 1 && (row.kind === 'line' ? row.item.index === 7050 : row.kind === 'split' && row.row.before?.index === 7050));
      await view.scrollTo(target.offset - 200);
      expect(view.rows().some(row => Number(row.dataset.row) === target.index)).toBe(true);
      if (split) {
        const row = view.host.querySelector(`[data-row="${target.index}"]`)!;
        expect([...row.querySelectorAll('.split-code')].map(code => code.textContent)).toEqual(['removed 7050', 'added 7051']);
        await click(view.button('Select line 107050 for staging (before)'));
        await click(view.button('Select line 107051 for staging (after)'));
      } else {
        await click(view.button('Select line 107050 for staging'));
        await view.scrollTo(target.offset - 200 + DIFF_ROW_ESTIMATE.unified);
        await click(view.button('Select line 107051 for staging'));
      }
      expect(view.button(split ? 'Deselect line 107050 for staging (before)' : 'Deselect line 107050 for staging')?.getAttribute('aria-pressed')).toBe('true');
      // Scroll back to the hunk header: selection survives its rows leaving the window.
      await view.scrollTo(offsetOf(split, row => row.kind === 'hunk' && row.hunkIndex === 1).offset - 50);
      await click(view.button('Stage selected lines 2 in big.txt'));
      expect(onHunk).toHaveBeenCalledExactlyOnceWith({ kind: 'stage_hunk', path: 'big.txt', hunkIndex: 1, fingerprint: 'big-token', lineIndices: [7050, 7051] });
    } finally { await view.unmount(); }
  });

  it('moves a roving active line with the arrow keys and toggles it with Space', async () => {
    const onHunk = vi.fn();
    const view = await mountDiff({ diff, split: false, hunkAction: 'stage_hunk', onHunk });
    try {
      const toggles = () => [...view.host.querySelectorAll<HTMLButtonElement>('.line-select-toggle')];
      expect(view.surface.tabIndex).toBe(0);
      expect(toggles().map(toggle => toggle.tabIndex)).toEqual([-1, -1]);
      expect(view.surface.hasAttribute('aria-activedescendant')).toBe(false);
      await view.key('ArrowDown');
      expect(document.getElementById(view.surface.getAttribute('aria-activedescendant')!)).toBe(toggles()[0]);
      expect(view.host.querySelector('.diff-active')?.textContent).toContain('changed');
      await view.key('ArrowDown');
      expect(document.getElementById(view.surface.getAttribute('aria-activedescendant')!)).toBe(toggles()[1]);
      await view.key(' ');
      expect(toggles().map(toggle => toggle.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
      await view.key('ArrowUp');
      expect(document.getElementById(view.surface.getAttribute('aria-activedescendant')!)).toBe(toggles()[0]);
      await view.key('Enter');
      expect(toggles().map(toggle => toggle.getAttribute('aria-pressed'))).toEqual(['true', 'true']);
      await click(view.button('Stage selected lines 2 in file.txt'));
      expect(onHunk).toHaveBeenCalledExactlyOnceWith({ kind: 'stage_hunk', path: 'file.txt', hunkIndex: 1, fingerprint: 'backend-token', lineIndices: [0] });
      // Space on a focused hunk button keeps its native meaning instead of toggling the active line.
      await view.key(' ', view.button('Stage selected lines 1 in file.txt')!);
      expect(toggles().map(toggle => toggle.getAttribute('aria-pressed'))).toEqual(['true', 'true']);
    } finally { await view.unmount(); }
  });

  it('keeps keyboard selection off while writes are blocked', async () => {
    const onToggleLine = vi.fn();
    const view = await mountDiff({ diff, split: false, hunkAction: 'stage_hunk', busy: true, onToggleLine });
    try {
      await view.key('ArrowDown');
      await view.key(' ');
      expect(onToggleLine).not.toHaveBeenCalled();
    } finally { await view.unmount(); }
  });

  it('reveals the active row when keyboard navigation jumps outside the rendered window', async () => {
    const onToggleLine = vi.fn();
    const view = await mountDiff({ diff: big, split: true, hunkAction: 'stage_hunk', onToggleLine, selectedLines: {} });
    try {
      const last = diffRows(big.hunks, true).length - 1;
      await view.key('End');
      expect(view.surface.scrollTop).toBeGreaterThan(0);
      const active = view.host.querySelector<HTMLElement>('.diff-active')!;
      expect(active.closest<HTMLElement>('[data-row]')?.dataset.row).toBe(String(last));
      expect(view.rows().length).toBeLessThan(200);
      expect(document.getElementById(view.surface.getAttribute('aria-activedescendant')!)).toBe(active);
      // A paired replacement row: Left/Right choose the side, Space sends that side's original index.
      const pair = offsetOf(true, row => row.hunkIndex === 1 && row.kind === 'split' && row.row.before?.index === 9950);
      await view.key('Home');
      await view.scrollTo(pair.offset - 300);
      await view.key('ArrowDown');
      let guard = 0;
      while (view.host.querySelector<HTMLElement>('.diff-active')?.closest<HTMLElement>('[data-row]')?.dataset.row !== String(pair.index) && guard++ < 40) await view.key('ArrowDown');
      await view.key('ArrowRight');
      await view.key(' ');
      await view.key('ArrowLeft');
      await view.key(' ');
      expect(onToggleLine.mock.calls).toEqual([[1, 9951], [1, 9950]]);
    } finally { await view.unmount(); }
  });

  it('keeps the shared horizontal offset wired to the split scrollbar', async () => {
    const view = await mountDiff({ diff: big, split: true });
    try {
      const scrollbar = view.host.querySelector<HTMLElement>('.split-horizontal-scroll')!;
      Object.defineProperty(scrollbar, 'scrollLeft', { configurable: true, get: () => 120, set: () => {} });
      await act(async () => { scrollbar.dispatchEvent(new Event('scroll', { bubbles: false })); });
      expect(view.surface.style.getPropertyValue('--split-scroll-offset')).toBe('120px');
      expect(view.host.querySelector('.split-content > .diff-virtual-spacer')).not.toBeNull();
    } finally { await view.unmount(); }
  });
});
