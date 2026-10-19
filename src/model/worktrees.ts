import type { RepositoryLocation } from './repository';

export interface Worktree {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  main: boolean;
  locked: string | null;
  prunable: string | null;
}
export type WorktreeAction = 'create' | 'move' | 'remove' | 'lock' | 'unlock' | 'prune';
export interface WorktreeRequest {
  action: WorktreeAction;
  path: string;
  destination: string;
  branch: string;
  startPoint: string;
  reason: string;
  force: boolean;
}
export interface WorktreeReview { token: string; preview: string }
export function worktreeLocation(origin: RepositoryLocation, path: string): RepositoryLocation {
  return { ...origin, path };
}
export function worktreeName(path: string) { return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path; }
export const worktreeEvents = new EventTarget();

/* Tauri IPC:
 * repository_worktrees({handle}) -> Worktree[]
 * repository_worktree_review({handle, request: WorktreeRequest}) -> WorktreeReview
 * repository_worktree_execute({handle, request: WorktreeRequest, token: string}) -> void
 * A failed execute may follow a completed Git write: refresh, review again, never retry automatically.
 */
