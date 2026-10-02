// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { DiffPreview, WorkingChanges } from './WorkingChanges';
import type { FileDiff, RepositorySession, StatusEntry } from '../model/repository';
import { DEFAULT_SETTINGS } from '../model/settings';

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
