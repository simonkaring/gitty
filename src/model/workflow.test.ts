import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSubmittedDraft, commitMessage, draftKey, operationPaths, readDraft, saveDraft, writeAndRefresh } from './workflow';
import type { RepositorySession, StatusEntry } from './repository';
import type { native } from './native';
import { demoCommittedFiles, demoFileDiff, demoStatus, demoWorkingFiles } from './demoWorkflow';

afterEach(() => vi.unstubAllGlobals());
describe('write lifecycle', () => {
  it.each(['stage_hunk', 'unstage_hunk'] as const)('routes %s with only the selected hunk identity and awaits refresh', async kind => {
    const calls: string[] = [];
    const invoke = vi.fn(async () => { calls.push('write'); }) as typeof native;
    let release!: () => void;
    const reload = vi.fn(() => { calls.push('refresh'); return new Promise<void>(resolve => { release = resolve; }); });
    let done = false;
    const pending = writeAndRefresh('repo-tab', { kind, path: '-odd\tfile', hunkIndex: 2, fingerprint: 'raw-diff-token' }, reload, () => true, invoke).then(outcome => { done = true; return outcome; });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(done).toBe(false);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(`repository_${kind}`, { handle: 'repo-tab', path: '-odd\tfile', hunkIndex: 2, fingerprint: 'raw-diff-token' });
    release(); expect(await pending).toEqual({});
    expect(calls).toEqual(['write', 'refresh']);
  });
  it('refreshes stale hunk failures exactly once and reports failed reconciliation', async () => {
    const invoke = vi.fn().mockRejectedValue({ code: 'staleDiff', message: 'Refresh the preview and select again.' }) as typeof native;
    const reload = vi.fn().mockRejectedValue(new Error('Refresh unavailable'));
    const outcome = await writeAndRefresh('s', { kind: 'stage_hunk', path: 'file', hunkIndex: 0, fingerprint: 'old' }, reload, () => true, invoke);
    expect(outcome).toEqual({ error: 'Refresh the preview and select again.', refreshError: 'Refresh unavailable' });
    expect(invoke).toHaveBeenCalledOnce(); expect(reload).toHaveBeenCalledOnce();
  });
  it.each([-1, 0.5, NaN, Infinity])('rejects invalid hunk index %s before IPC', async hunkIndex => {
    const invoke = vi.fn() as typeof native;
    const reload = vi.fn().mockResolvedValue(undefined);
    const outcome = await writeAndRefresh('s', { kind: 'unstage_hunk', path: 'file', hunkIndex, fingerprint: 'token' }, reload, () => true, invoke);
    expect(outcome.error).toMatch(/complete hunk/); expect(invoke).not.toHaveBeenCalled();
  });
  it('does not publish a hunk result or refresh into a superseding tab session', async () => {
    let current = true;
    let release!: () => void;
    const invoke = vi.fn(() => new Promise<void>(resolve => { release = resolve; })) as typeof native;
    const reload = vi.fn();
    const pending = writeAndRefresh('old', { kind: 'stage_hunk', path: 'file', hunkIndex: 0, fingerprint: 'token' }, reload, () => current, invoke);
    current = false; release();
    expect(await pending).toEqual({ superseded: true }); expect(reload).not.toHaveBeenCalled();
  });
  it('always refreshes after a failed write, without retrying an ambiguous commit', async () => {
    const calls: string[] = [];
    const invoke = vi.fn(async () => { calls.push('write'); throw { code: 'commit_failed', message: 'Hook failed after updating HEAD' }; }) as typeof native;
    const outcome = await writeAndRefresh('s', { kind: 'commit', message: 'A commit' }, async () => { calls.push('refresh'); }, () => true, invoke);
    expect(calls).toEqual(['write', 'refresh']);
    expect(outcome).toEqual({ error: 'Hook failed after updating HEAD' });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('repository_create_commit', { handle: 's', message: 'A commit' });
  });
  it('distinguishes a confirmed commit from a failed refresh', async () => {
    const invoke = vi.fn().mockResolvedValue({ oid: 'new-head' }) as typeof native;
    const result = await writeAndRefresh('s', { kind: 'commit', message: 'Title\n\nBody' }, async () => { throw new Error('Snapshot unavailable'); }, () => true, invoke);
    expect(result).toEqual({ oid: 'new-head', refreshError: 'Snapshot unavailable' });
  });
  it('does not refresh or publish a late response into another session', async () => {
    let resolve!: (result: { oid: string }) => void;
    let current = true;
    const reload = vi.fn();
    const invoke = vi.fn(() => new Promise(r => { resolve = r; })) as typeof native;
    const pending = writeAndRefresh('old-session', { kind: 'commit', message: 'Title' }, reload, () => current, invoke);
    current = false; resolve({ oid: 'old-head' });
    expect(await pending).toEqual({ oid: 'old-head', superseded: true });
    expect(reload).not.toHaveBeenCalled();
  });
  it('awaits refresh before reporting a mutation complete', async () => {
    let release!: () => void;
    const reload = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const invoke = vi.fn().mockResolvedValue(undefined) as typeof native;
    let done = false;
    const pending = writeAndRefresh('s', { kind: 'stage', paths: ['a', 'a', 'b'] }, reload, () => true, invoke).then(() => { done = true; });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(done).toBe(false); release(); await pending;
    expect(invoke).toHaveBeenCalledWith('repository_stage', { handle: 's', paths: ['a', 'b'] });
  });
  it('never invokes an empty-all operation', async () => {
    const invoke = vi.fn() as typeof native;
    const reload = vi.fn().mockResolvedValue(undefined);
    const result = await writeAndRefresh('s', { kind: 'unstage', paths: [] }, reload, () => true, invoke);
    expect(result.error).toBe('Select at least one path.'); expect(invoke).not.toHaveBeenCalled(); expect(reload).toHaveBeenCalledOnce();
  });
});
describe('draft durability', () => {
  const session = { root: '/repo', location: { kind: 'native', path: '/repo' } } as RepositorySession;
  it('keys drafts by worktree and WSL distribution, never by expiring handles', () => {
    expect(draftKey({ ...session, handle: '1' })).toBe(draftKey({ ...session, handle: '2' }));
    expect(draftKey(session)).not.toBe(draftKey({ ...session, root: '/worktree' }));
    expect(draftKey(session)).not.toBe(draftKey({ ...session, location: { kind: 'wsl', distribution: 'Ubuntu', path: '/repo' } }));
  });
  it('persists subject and body immediately and keeps an in-memory fallback', () => {
    const setItem = vi.fn(); vi.stubGlobal('localStorage', { setItem });
    const draft = { subject: 'feat: readable history', body: 'Preserve the graph.' };
    expect(saveDraft('draft-test', draft)).toBe(true);
    expect(setItem).toHaveBeenCalledWith('draft-test', JSON.stringify(draft));
    expect(readDraft('draft-test')).toEqual(draft);
    setItem.mockImplementation(() => { throw new Error('Storage blocked'); });
    expect(saveDraft('offline-draft', draft)).toBe(false);
    expect(readDraft('offline-draft')).toEqual(draft);
  });
  it('does not clear a newer draft when an older commit response arrives', () => {
    vi.stubGlobal('localStorage', { setItem: vi.fn() });
    const submitted = { subject: 'old', body: '' };
    saveDraft('race-draft', { subject: 'new', body: 'Keep this' });
    expect(clearSubmittedDraft('race-draft', submitted)).toBe(false);
    expect(readDraft('race-draft').subject).toBe('new');
    saveDraft('race-draft', submitted);
    expect(clearSubmittedDraft('race-draft', submitted)).toBe(true);
    expect(readDraft('race-draft')).toEqual({ subject: '', body: '' });
    expect(commitMessage({ subject: ' Subject ', body: ' Why\n\nDetails ' })).toBe('Subject\n\nWhy\n\nDetails');
  });
});
describe('whole-file staging', () => {
  const renamed: StatusEntry = { path: 'new.ts', oldPath: 'old.ts', indexStatus: 'R', worktreeStatus: '.', conflicted: false, untracked: false };
  it('unstages both sides of an indexed rename and skips it when staging', () => {
    expect(operationPaths([renamed], 'unstage')).toEqual(['old.ts', 'new.ts']);
    expect(operationPaths([renamed], 'stage')).toEqual([]);
  });
  it.each(['M', 'D', 'R', 'C'])('stages only the destination of an indexed rename with worktree status %s', worktreeStatus => {
    const partial = { ...renamed, worktreeStatus };
    expect(operationPaths([partial], 'stage')).toEqual(['new.ts']);
    expect(operationPaths([partial], 'unstage')).toEqual(['old.ts', 'new.ts']);
  });
  it('stages both sides of a working-tree rename without treating it as an indexed rename', () => {
    expect(operationPaths([{ ...renamed, indexStatus: '.', worktreeStatus: 'R' }], 'stage')).toEqual(['old.ts', 'new.ts']);
    expect(operationPaths([{ ...renamed, indexStatus: 'M', worktreeStatus: 'R' }], 'unstage')).toEqual(['new.ts']);
  });
  it.each(['.', 'M', 'R', 'C'])('never expands an indexed copy source for worktree status %s', worktreeStatus => {
    const copy = { ...renamed, indexStatus: 'C', worktreeStatus };
    expect(operationPaths([copy], 'unstage')).toEqual(['new.ts']);
    expect(operationPaths([copy], 'stage')).toEqual(worktreeStatus === '.' ? [] : ['new.ts']);
  });
  it('stages only the destination of a working-tree copy', () => {
    const copy = { ...renamed, indexStatus: '.', worktreeStatus: 'C' };
    expect(operationPaths([copy], 'stage')).toEqual(['new.ts']);
    expect(operationPaths([copy], 'unstage')).toEqual([]);
  });
  it('deduplicates expanded rename paths in all actions while preserving independent copy-source edits', () => {
    const source = { ...renamed, path: 'old.ts', oldPath: null, indexStatus: 'M', worktreeStatus: '.' };
    const copy = { ...renamed, path: 'copy.ts', indexStatus: 'C', worktreeStatus: 'M' };
    expect(operationPaths([copy], 'unstage')).toEqual(['copy.ts']);
    expect(operationPaths([renamed, source, copy], 'unstage')).toEqual(['old.ts', 'new.ts', 'copy.ts']);
    expect(operationPaths([{ ...renamed, worktreeStatus: 'M' }, copy], 'stage')).toEqual(['new.ts', 'copy.ts']);
  });
  it('excludes conflicted renames and handles unavailable or duplicate origins without inventing paths', () => {
    expect(operationPaths([{ ...renamed, conflicted: true, worktreeStatus: 'R' }], 'unstage')).toEqual([]);
    expect(operationPaths([{ ...renamed, conflicted: true, worktreeStatus: 'R' }], 'stage')).toEqual([]);
    expect(operationPaths([{ ...renamed, oldPath: null }], 'unstage')).toEqual(['new.ts']);
    expect(operationPaths([{ ...renamed, oldPath: 'new.ts' }], 'unstage')).toEqual(['new.ts']);
  });
  it('uses explicit paths and excludes conflicts from all operations', () => {
    const entry: StatusEntry = { path: 'both', oldPath: null, indexStatus: 'M', worktreeStatus: 'M', conflicted: false, untracked: false };
    const entries = [entry, { ...entry, path: 'new', untracked: true }, { ...entry, path: 'conflict', conflicted: true }];
    expect(operationPaths(entries, 'stage')).toEqual(['both', 'new']);
    expect(operationPaths(entries, 'unstage')).toEqual(['both']);
  });
  it('demo commits only the index and retains partially staged working changes', () => {
    const files = demoWorkingFiles();
    const staged = demoFileDiff(files, { kind: 'staged' }, files[0].path);
    const unstaged = demoFileDiff(files, { kind: 'unstaged' }, files[0].path);
    expect(staged.hunks[0].lines.filter(line => line.kind === 'add').map(line => line.content)).toEqual(['  --row-height: 48px;']);
    expect(unstaged.hunks[0].lines.filter(line => line.kind === 'add').map(line => line.content)).toEqual(['  --accent: #21766c;']);
    expect(demoCommittedFiles(files)).toHaveLength(1);
    const committed = files.map(file => ({ ...file, head: file.index }));
    expect(operationPaths(demoStatus(committed, 'new-head').entries, 'unstage')).toEqual([]);
    expect(operationPaths(demoStatus(committed, 'new-head').entries, 'stage')).toHaveLength(3);
  });
});
