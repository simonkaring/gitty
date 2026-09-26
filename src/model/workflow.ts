import { errorMessage, native, statusGroups } from './native';
import type { CreateCommitResult, RepositoryMutation, RepositorySession, StatusEntry } from './repository';

export interface MutationOutcome { oid?: string; error?: string; refreshError?: string; superseded?: boolean }
/** One attempt only. Even a failed write can have changed the index or HEAD. */
export async function writeAndRefresh(handle: string, mutation: RepositoryMutation, reload: () => Promise<void>, current: () => boolean, invoke = native): Promise<MutationOutcome> {
  const outcome: MutationOutcome = {};
  try {
    if (!current()) return { superseded: true };
    if (mutation.kind === 'commit') {
       const result = await invoke<CreateCommitResult>('repository_create_commit', { handle, message: mutation.message, ...(mutation.identity ? { identity: mutation.identity } : {}) });
      outcome.oid = result.oid;
    } else if (mutation.kind === 'amend') {
      if (!mutation.expectedHead || !mutation.expectedStatusFingerprint) throw new Error('Refresh and review the last commit before amending.');
       const result = await invoke<CreateCommitResult>('repository_amend_commit', { handle, message: mutation.message, ...(mutation.identity ? { identity: mutation.identity } : {}), expectedHead: mutation.expectedHead, expectedHeadRef: mutation.expectedHeadRef, expectedStatusFingerprint: mutation.expectedStatusFingerprint });
      outcome.oid = result.oid;
    } else if (mutation.kind === 'stage_hunk' || mutation.kind === 'unstage_hunk') {
      if (!mutation.path || !mutation.fingerprint || !Number.isSafeInteger(mutation.hunkIndex) || mutation.hunkIndex < 0) throw new Error('Select a complete hunk from a current diff.');
      if (mutation.lineIndices !== undefined) {
        if (!Array.isArray(mutation.lineIndices) || !mutation.lineIndices.length || mutation.lineIndices.length > 20000 || !mutation.lineIndices.every(i => Number.isSafeInteger(i) && i >= 0) || new Set(mutation.lineIndices).size !== mutation.lineIndices.length) {
          throw new Error('Select one or more valid distinct changed lines.');
        }
      }
      await invoke(`repository_${mutation.kind}`, {
        handle,
        path: mutation.path,
        hunkIndex: mutation.hunkIndex,
        fingerprint: mutation.fingerprint,
        ...(mutation.lineIndices !== undefined ? { lineIndices: mutation.lineIndices } : {}),
      });
    } else {
      if (!mutation.paths.length) throw new Error('Select at least one path.');
      await invoke(`repository_${mutation.kind}`, { handle, paths: [...new Set(mutation.paths)] });
    }
  } catch (error) { outcome.error = errorMessage(error); }
  if (!current()) return { ...outcome, superseded: true };
  try { await reload(); } catch (error) { outcome.refreshError = errorMessage(error); }
  return current() ? outcome : { ...outcome, superseded: true };
}

export function operationPaths(entries: StatusEntry[], kind: 'stage' | 'unstage'): string[] {
  const groups = statusGroups(entries);
  const eligible = kind === 'stage' ? [...groups.unstaged, ...groups.untracked] : groups.staged;
  return [...new Set(eligible.flatMap(entry => {
    // oldPath belongs to the indexed rename/copy when X is R/C. It is not
    // an index path to git-add again when staging remaining working-tree edits.
    // Reset both sides of an indexed rename, but never reset a copy's source:
    // that path may have independent staged edits of its own.
    const includeOrigin = kind === 'unstage'
      ? entry.indexStatus === 'R'
      : entry.worktreeStatus === 'R' && !['R', 'C'].includes(entry.indexStatus);
    return includeOrigin && entry.oldPath ? [entry.oldPath, entry.path] : [entry.path];
  }))];
}

export interface CommitDraft { subject: string; body: string }
const memory = new Map<string, CommitDraft>();
export function draftKey(session: RepositorySession): string {
  // Handles expire. Include WSL distribution and worktree root, not just repo name.
  return `gitty:commit-draft:${JSON.stringify([session.location.kind, session.location.kind === 'wsl' ? session.location.distribution : '', session.root])}`;
}
export function readDraft(key: string): CommitDraft {
  if (memory.has(key)) return memory.get(key)!;
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (value && typeof value === 'object' && 'subject' in value && 'body' in value && typeof value.subject === 'string' && typeof value.body === 'string') return value as CommitDraft;
  } catch { /* Malformed or unavailable storage must not prevent composing. */ }
  return { subject: '', body: '' };
}
export function saveDraft(key: string, draft: CommitDraft): boolean {
  memory.set(key, draft);
  try { localStorage.setItem(key, JSON.stringify(draft)); return true; } catch { return false; }
}
export function clearSubmittedDraft(key: string, submitted: CommitDraft): boolean {
  const current = readDraft(key);
  if (current.subject !== submitted.subject || current.body !== submitted.body) return false;
  saveDraft(key, { subject: '', body: '' });
  return true;
}
export function commitMessage(draft: CommitDraft): string {
  return `${draft.subject.trim()}${draft.body.trim() ? `\n\n${draft.body.trim()}` : ''}`;
}

export function draftFromCommitMessage(message: string): CommitDraft {
  const newline = message.indexOf('\n');
  if (newline < 0) return { subject: message, body: '' };
  return {
    subject: message.slice(0, newline),
    body: message.slice(newline + 1).replace(/^\n/, '').trimEnd(),
  };
}
