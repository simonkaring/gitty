/** Shared contract for the native repository service. IDs and cursors are opaque. */
export type RepositoryLocation = { kind: 'native'; path: string } | { kind: 'wsl'; distribution: string; path: string };
export interface RepositorySession {
  handle: string;
  location: RepositoryLocation;
  name: string;
  root: string;
  gitDir: string;
  commonDir: string;
  linkedWorktree: boolean;
  shallow: boolean;
  bare: boolean;
  head: string | null;
  headRef: string | null;
}
export interface RepositoryRef { name: string; fullName: string; commitId: string; kind: 'local' | 'remote' | 'tag' }
export interface CommitSummary { id: string; parents: string[]; subject: string; author: string; email: string; timestamp: number }
export interface CommitDetail extends CommitSummary { body: string }
export interface HistoryPage { commits: CommitSummary[]; cursor: string | null; generation: string; shallow: boolean }
export interface HistoryQuery { branch?: string }
export interface StatusEntry { path: string; oldPath: string | null; indexStatus: string; worktreeStatus: string; conflicted: boolean; untracked: boolean }
export interface RepositoryStatus { entries: StatusEntry[]; head: string | null; headRef: string | null; fingerprint: string }
export type DiffSpec =
  | { kind: 'commit'; oid: string; parent?: string }
  | { kind: 'compare'; base: string; target: string }
  | { kind: 'staged' | 'unstaged' | 'untracked' | 'conflict' };
export interface DiffFile { path: string; oldPath: string | null; status: string; additions: number | null; deletions: number | null; binary: boolean }
export interface DiffLine { kind: 'context' | 'add' | 'remove' | 'meta'; content: string; oldLine: number | null; newLine: number | null }
export interface DiffHunk { header: string; lines: DiffLine[] }
export interface FileDiff { path: string; hunks: DiffHunk[]; binary: boolean; truncated: boolean; message: string | null; hunkAction?: { fingerprint: string | null; reason: string | null } | null }
export interface SearchQuery { text: string; branch?: string; since?: string; until?: string; path?: string }
export interface SearchResult { commits: CommitSummary[]; truncated: boolean }
export interface RepositoryState { session: RepositorySession; refs: RepositoryRef[]; remotes: string[]; fingerprint: string }
export interface WslDistribution { name: string; running: boolean }
export interface DirectoryEntry { name: string; path: string }
export interface RepositoryError { code: string; message: string }
export interface CreateCommitResult { oid: string }
/** Writes use explicit repository-relative paths; an empty array never means all.
 * File stage/unstage affect whole paths, including the remainder of partially staged
 * files. Conflicted paths cannot be mutated here. The service is authoritative
 * for bare repositories, in-progress merges, identity, hooks, and other checks.
 * A rejected commit can have an ambiguous outcome: refresh, preserve the draft,
 * and never automatically retry. repository_commit is still a read operation.
 */
export type RepositoryMutation =
  | { kind: 'stage' | 'unstage'; paths: string[] }
  | { kind: 'stage_hunk'; path: string; hunkIndex: number; fingerprint: string }
  | { kind: 'unstage_hunk'; path: string; hunkIndex: number; fingerprint: string }
  | { kind: 'commit'; message: string };

/* Tauri commands (all argument names camelCase):
 * repository_pick() -> string | null
 * repository_open({location}) -> RepositoryState
 * repository_close({handle}) -> void
 * repository_recent() -> RepositoryLocation[]
 * repository_state({handle}) -> RepositoryState
 * repository_history({handle, cursor: string|null, limit, query: HistoryQuery}) -> HistoryPage
 * repository_commit({handle, oid}) -> CommitDetail
 * repository_status({handle}) -> RepositoryStatus
 * repository_diff_files({handle, spec: DiffSpec}) -> DiffFile[]
 * repository_diff({handle, spec: DiffSpec, path}) -> FileDiff
 * repository_search({handle, query: SearchQuery}) -> SearchResult
 * repository_stage({handle, paths: string[]}) -> void
 * repository_unstage({handle, paths: string[]}) -> void
 * repository_stage_hunk({handle, path, hunkIndex, fingerprint}) -> void
 * repository_unstage_hunk({handle, path, hunkIndex, fingerprint}) -> void
 * Hunk indices are zero-based complete hunks from FileDiff. Fingerprints bind
 * raw backend diffs and index entries; they are not atomic external-Git locks.
 * Unsupported/truncated previews have no actionable fingerprint. No patch text
 * is accepted from the client. Both commands leave the working tree untouched.
 * repository_create_commit({handle, message: string}) -> CreateCommitResult
 * wsl_distributions() -> WslDistribution[]
 * wsl_directories({distribution, path}) -> DirectoryEntry[]
 * Errors: {code: string, message: string}
 */
