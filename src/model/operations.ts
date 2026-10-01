/** Native graph operations. Expected state is captured when the action is reviewed. */
export type OperationKind = 'none' | 'merge' | 'rebase' | 'cherryPick' | 'revert' | 'unsupported';
export interface OperationState {
  kind: OperationKind;
  label: string;
  current: string | null;
  incoming: string | null;
  step: number | null;
  total: number | null;
  conflicts: string[];
  canContinue: boolean;
  canSkip: boolean;
  /** Includes operation, refs and working state; checked again under the mutation lock. */
  fingerprint: string;
}
export type GitAction =
  | { kind: 'createBranch'; name: string; startPoint: string; checkout: boolean }
  | { kind: 'switchBranch'; branch: string; carryChanges?: boolean }
  | { kind: 'merge'; source: string; noFastForward: boolean }
  | { kind: 'rebase'; onto: string }
  | { kind: 'interactiveRebase'; onto: string; steps: RebaseStep[] }
  | { kind: 'cherryPick'; commits: string[]; mainline?: number }
  | { kind: 'createTag'; name: string; oid: string; message?: string }
  | { kind: 'continue' | 'skip' | 'abort' };
export interface RebaseStep { oid: string; instruction: 'pick' | 'drop' | 'reword' | 'squash' | 'fixup' }
export interface OperationRequest {
  action: GitAction;
  expectedHead: string | null;
  expectedHeadRef: string | null;
  expectedOperation: string;
}
export interface OperationResult { head: string | null; operation: OperationState; output: string }
export interface ConflictVersion { oid: string; mode: string; content: string | null }
export interface ConflictFile {
  path: string;
  fingerprint: string;
  base: ConflictVersion | null;
  ours: ConflictVersion | null;
  theirs: ConflictVersion | null;
  result: string | null;
  editable: boolean;
  reason: string | null;
  oursLabel: string;
  theirsLabel: string;
}
export type ConflictResolution = { kind: 'text'; content: string } | { kind: 'ours' | 'theirs' | 'delete' | 'working' };
export interface RemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string;
  /** Locally known branch names on this remote (without the remote prefix). */
  branches: string[];
  /** Upstream of the current branch, when it belongs to this remote. */
  currentUpstream: string | null;
}

export interface EditorPromptPayload {
  requestId: number;
  fileName: string;
  content: string;
}

/* Commands (camelCase arguments):
 * repository_operation_state({handle}) -> OperationState
 * repository_run_operation({handle, request: OperationRequest}) -> OperationResult
 * repository_conflict_file({handle, path}) -> ConflictFile
 * repository_resolve_conflict({handle, path, fingerprint, resolution: ConflictResolution}) -> void
 * repository_remotes({handle}) -> RemoteInfo[]
 * open_external_url({url}) -> void
 * editor_reply({requestId: number, content: string | null}) -> void
 * All writes use repository mutation serialization and are followed by frontend refresh.
 */
