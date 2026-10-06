# Native repository service

All commands in `src/model/repository.ts`, `src/model/clone.ts`, and `src/model/operations.ts` are registered by `src/lib.rs`. The
Rust DTOs serialize the same camelCase fields and `{code, message}` errors.
`backend_info` remains available and reports native capability.

Ordinary index/commit writes use these commands:

- `repository_stage({handle, paths: string[]}) -> void`
- `repository_unstage({handle, paths: string[]}) -> void`
- `repository_discard({handle, paths: string[], expectedStatusFingerprint: string}) -> void`
- `repository_ignore_path({handle, path: string}) -> void`
- `repository_open_path({handle, path: string}) -> void`
- `repository_reveal_path({handle, path: string}) -> void`
- `repository_snapshot({handle}) -> {state, status, operation}` (a read; see Read semantics)
- `repository_stage_hunk({handle, path: string, hunkIndex: number, fingerprint: string, lineIndices?: number[]}) -> void`
- `repository_unstage_hunk({handle, path: string, hunkIndex: number, fingerprint: string, lineIndices?: number[]}) -> void`
- `repository_create_commit({handle, message: string, identity?: {name: string, email: string}}) -> {oid: string}`
- `repository_amend_commit({handle, message: string, identity?: {name: string, email: string}, expectedHead: string, expectedHeadRef: string | null, expectedStatusFingerprint: string, messageOnly?: boolean, requireUnpushed?: boolean}) -> {oid: string}`
- `repository_git_identity({handle}) -> {local: {name: string | null, email: string | null}, effective: {name: string | null, email: string | null}}`
- `repository_set_git_identity({handle, identity: {name: string, email: string}, expectedLocal: {name: string | null, email: string | null}}) -> RepositoryGitIdentity`

`repository_commit({handle, oid})` remains a read. Its `CommitDetail` gains two fields:
`canEditMessage: boolean` and `editDisabledReason: string | null` (camelCase on the wire).
They are the eligibility verdict for editing that commit's message in place, and they
carry no authority: the write re-checks everything it relies on.

Eligibility is read-only and checked cheapest-first, so a commit that is not HEAD costs
one extra Git process. The commit is parsed first, so a failure while checking can never
hide the commit itself:

1. A bare repository is not editable.
2. Only the commit HEAD resolves to is editable; any other commit is disabled with a
   reason pointing at interactive rebase. (Root and merge commits are editable when
   they are HEAD. The old ancestry and merge-history probes are gone.)
3. HEAD must be symbolic (a checked-out branch); a detached HEAD is disabled.
4. No operation in progress (the same check writes use) and no unmerged paths.
   A transient `index.lock` is deliberately excluded: it says nothing about
   eligibility, and the write itself still refuses with `indexLocked`.
5. No known remote-tracking ref may contain the commit
   (`git for-each-ref --contains <oid> --format=%(refname) refs/remotes`, which must
   succeed; a failed query is an error, never "not pushed").

Eligibility never fails open. Any error while checking (an operation in progress, a
failed Git command, an unresolved HEAD) is returned as a normal detail with
`canEditMessage: false` and a readable `editDisabledReason` such as "Editing is
unavailable because eligibility could not be checked: …". Remote-tracking refs are local
data: they only prove what the last fetch saw, never what the remote has now, and the
reason text says so. The demo backend returns `canEditMessage: false` for every commit.
When `lineIndices` is supplied to `repository_stage_hunk` or `repository_unstage_hunk`, only the specified 0-based lines within the hunk are staged/unstaged using a selectively generated forward patch (and `--reverse` for unstaging), validating bounds and changed line kinds while preserving all working files and other index entries.

## Read semantics

- Git is the installed executable, launched with explicit arguments and no shell.
  Native paths use `git -C`; WSL uses `wsl.exe --distribution … --exec env … git -C …`.
  Native WSL UNC locations are rejected.
- Git reads disable optional locks, fsmonitor, automatic maintenance, replacement
  objects, external diff, textconv, implicit object fetching, and transport protocols.
  System/global/repository Git configuration and attributes are honored, including
  protected `safe.directory` settings. Native config-file environment selectors are
  preserved; repository/index/object-store environment overrides are removed.
  The safety settings above are targeted overrides, not a config-file exclusion.
  Search also disables signature verification so `log.showSignature` cannot launch GPG.
  Partial/promisor clones are explicitly unsupported to preserve offline behavior.
- Blocking work runs in Tauri blocking workers. Captured commands have a 30-second
  limit and a 32-MiB limit per output stream. Requests have a 60-second subprocess
  budget. Streaming commands instead have a 30-second wait limit for each record,
  within the same per-request budget; time waiting for the user's next page is not
  counted. Stream records and stderr are bounded, with one queued record of read-ahead.
  Native process trees use Unix process groups or Windows kill-on-close Job Objects.
- Sessions and cursors are UUIDs. At most 32 sessions are open simultaneously.
  The registry lock is short-lived; history walks use a per-session lock while
  state, search, status, and diff reads run independently. Closing invalidates the
  handle immediately; acquired requests may finish before resources are released.
- History resolves current local/remote/tag refs and HEAD to concrete commit IDs,
  then starts **one** `rev-list --date-order <captured IDs> --` process per generation.
  History rows use committer timestamps, matching this ordering; original author dates
  remain in the underlying commit objects.
  It consumes only the requested page plus one lookahead ID. Backpressure pauses
  stdout consumption between pages. Consumed IDs are spooled to an anonymous temp
  file, so replaying a cursor uses exactly the same order without keeping the entire
  history in memory. This never re-runs `--all`, re-resolves refs, or applies skip
  offsets to a new walk. **There is no 100,000-commit or whole-repository size rejection.**
  Git itself may still inspect ancestry before yielding topological output, depending
  on its version and commit-graph availability; Git's internal memory is not bounded
  by the application's record buffer. The replay spool grows with visited history.
  Pages are limited to 200 and a session to eight generations (the ninth resets
  the cache and terminates old walkers). Closing/expiring a session closes its
  temp files and terminates/reaps its walkers. Expired cursors return `staleCursor`.
  Objects removed by external pruning cannot be recovered; no retention refs are created.
- Commit objects provide original parent IDs, including unavailable parents at
  shallow boundaries. Page metadata uses one `cat-file --batch` command, with strict
  byte-length framing and aggregate output limits, rather than one process per
  commit. Missing objects cause explicit Git errors. Details and file
  patches load on demand. Search OR-matches case-insensitive literal substrings of
  **message, author name/email, and reference labels**, plus full/prefix commit hashes.
  Matching ref labels select only their pointed-to commits (annotated tags are peeled),
  not their ancestors. Full `refs/...` queries and the `HEAD` alias are supported.
  Branch reachability, date, and literal-path filters are ANDed with every match type.
  Git streams the filtered commits once in topological order; textual fields are
  OR-matched in the backend and matching IDs are deduplicated by that single walk.
  Results are capped at 500, with a 501st match setting `truncated`. A scan that cannot
  finish within the request budget returns a timeout rather than incomplete results.
  Date filtering uses `--since-as-filter` to avoid pruning newer ancestors behind a
  timestamp-skewed commit (requires Git 2.37+). Summary parents always come from the
  actual commit objects, never path-simplified log parent lists.
- Status uses porcelain v2 NUL-delimited records; raw/numstat diff output is also
  NUL-delimited. Spaces, tabs, newlines, leading dashes, and pathspec metacharacters
  are preserved. Non-UTF-8 paths/metadata return `unsupportedEncoding` because the
  shared string contract cannot represent arbitrary native bytes. Blob display
  uses replacement characters for undecodable bytes.
- Status fingerprints include tracked/untracked content so repeated edits with
  unchanged status letters still refresh. Untracked files are hashed with one
  `hash-object --no-filters --stdin-paths` batch; names the line protocol cannot
  carry verbatim (newline, carriage return, leading quote) or a batch Git rejects
  fall back to one no-index patch per file. The tracked patch and untracked hash,
  and the independent state reads, run concurrently because each process launch
  costs about 100 ms through `wsl.exe`. Repository state also fingerprints remotes and shallow boundaries
  so deepening without moving refs invalidates the walk. Reads are best-effort across
  concurrent external changes; nested repository contents are not recursively hashed.
- `repository_snapshot` returns repository state, working status and operation state
  from one read. State and status are computed once and shared with the operation
  state (whose fingerprint covers both) instead of once per command, and the four
  operation pseudo-refs (`MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`,
  `REBASE_HEAD`) resolve in one `cat-file --batch-check` instead of four processes.
  State is read again at the end: if its fingerprint moved, or HEAD disagrees between
  state and status, the read restarts, and after three attempts fails with `unstable`.
  `repository_state`, `repository_status` and `repository_operation_state` remain for
  callers that need only one. The frontend refreshes through the snapshot and walks
  history only when the state fingerprint changed; after a stage, unstage, hunk,
  discard or ignore it re-reads `repository_status` alone, since none of them can move
  HEAD or refs. Commit and amend keep the full refresh.
- The frontend's write lifecycle hands the write's outcome to the refresh
  (`reload(outcome)`) before refreshing. After an amend that confirmed a new `oid`
  (no write error), the refresh remaps the old `expectedHead` to that `oid` *inside*
  the snapshot read, before history paging: the automatic keep-visible candidates
  (selection and scroll anchor) are first filtered to commits that were in the previous
  history, and only then remapped. The walk therefore finds the new tip on its first
  page instead of paging the whole history for an ID that no longer exists, and the
  scroll anchor (ID and offset) is restored on the new row. The remap is honored only
  while the refreshed HEAD is that `oid`. A failed or uncertain write has no confirmed
  `oid`, so nothing is remapped, and a failed refresh never forces a reveal. The same
  filter stops later refreshes from walking all history for an inspector-only orphan
  (a selected ID that was not in the loaded history). Explicit reveal and paging are
  unchanged. After a successful refresh the selection moves to the new commit only if
  it is the same session, the selection is still the old HEAD, and no user selection
  has happened since the write was submitted (including away and back); compare
  base/target, refs and cherry-pick picks are never touched.
- Process waits poll with a 1 ms to 10 ms backoff, so a Git command that finishes in a
  few milliseconds is not charged a fixed 10 ms.
- Root commits compare against the computed empty-tree ID without writing objects.
  Merge comparisons default to first parent; a supplied parent must be an actual
  parent. Explicit comparisons resolve both inputs to commits before diffing.
- Conflict diffs display the working tree against stage 2 (ours), explained in
  `FileDiff.message`. The contract has no stage selector. Mode, rename, and index
  metadata are retained in that message because the contract has no mode fields.
  Hunk display is truncated at 20,000 lines with `truncated: true`; process output
  limits return an error rather than silently returning incomplete data.
- Recent repositories are stored in app-data `recent-repositories.json`, capped
  at 20 and replaced atomically. No repository files are written.
- Identity reads report both repository-local and effective Git `user.name` / `user.email` values. The local values are read without includes; effective values honor Git's normal configuration precedence.
- The folder picker uses `rfd`'s native asynchronous dialog. WSL discovery decodes
  UTF-16 output; browsing invokes Linux `find` directly, NUL-delimited, one directory
  level at a time. WSL requires Windows and Linux Git, `env`, and GNU `find`.

## Write semantics

This section describes the ordinary staging/commit API. Graph operations and
targeted conflict resolutions have the additional contract documented below.

- Every write names its files. `paths` is required and an empty array is an
  `invalidRequest` error: **empty never means "all changes"**, and there is no
  whole-tree form. Paths are repository-relative, rejected when absolute, empty,
  longer than 4096 bytes, or containing `..`, `.`, or empty segments. A single
  trailing `/` (how status reports untracked directories and embedded
  repositories) is trimmed, so such an entry stages as the one path it displays.
  Requests are capped at 1000 paths and 1 MiB of path bytes; duplicates are
  merged. Names with spaces, tabs, newlines, Unicode, a leading `-`, or pathspec
  metacharacters (`*`, `[`, `?`, `:`) stay literal: `GIT_LITERAL_PATHSPECS=1`
  disables pathspec magic and globbing, and `--pathspec-file-nul` disables
  C-quoting.
- **Nothing variable travels on the command line.** Paths are sent to Git on
  stdin with `--pathspec-from-file=- --pathspec-file-nul`, and the commit message
  with `--file=-` (both available since Git 2.25; the read path already requires
  2.37). Windows caps an entire command line near 32767 UTF-16 units and Unix
  caps both the total and each single argument, so no argument-shaped request
  could honor the limits above on every platform. Git arguments are now a short
  fixed set, with one exception: `git clean`, used to discard untracked files, has no
  pathspec-from-file form, so its paths follow `--` in batches of at most 16 KiB of
  arguments per process (still literal under `GIT_LITERAL_PATHSPECS=1`). Stdin is a bounded anonymous temp file, so there is no pipe writer
  that could deadlock against full output pipes, and the same handle is what WSL
  forwards into the distribution. Conflict pre-checks query the whole index
  (`ls-files --unmerged -z`) and are filtered in the backend for the same reason;
  a selected directory also covers conflicts inside it. An empty
  `--pathspec-from-file` payload would mean *every file* to Git, so the write path
  re-checks for a non-empty pathspec immediately before the process starts, and
  the payload is NUL-**separated**, never NUL-terminated (a trailing NUL would be
  an empty pathspec element).
- Git reads the commit message from stdin before it runs any hook, so hooks still
  see an immediately closed stdin: they cannot consume the message and cannot
  block waiting for input.
- Writes use a separate command contract from reads. They keep
  `GIT_LITERAL_PATHSPECS`, `GIT_NO_LAZY_FETCH`, `GIT_NO_REPLACE_OBJECTS`,
  `GIT_TERMINAL_PROMPT=0`, `protocol.allow=never`, `core.fsmonitor=false`,
  `core.untrackedCache=false`, `maintenance.auto=false` and `gc.auto=0`, and are
  still launched with explicit arguments and no shell. They drop the read-only
  overrides: `GIT_OPTIONAL_LOCKS=0` (a write must take the index lock),
  `LC_ALL=C`, and the diff display suppressions, because `git -c` settings reach
  hooks through `GIT_CONFIG_PARAMETERS` and hooks deserve the user's own
  environment. Repository/index/object-store and identity `GIT_*` variables are
  removed exactly as for reads, so an inherited `GIT_INDEX_FILE` or
  `GIT_AUTHOR_NAME` cannot redirect a write; native config-file selectors are
  preserved. Configured hooks, `commit.gpgsign`/`gpg.program`, `commit.cleanup`,
   identity and templates are honored, and their failures are surfaced verbatim
   (stderr and stdout, capped at 4000 characters). An optional saved profile
   overrides author and committer environment variables for a new commit, or
   committer alone for an amend (Git retains the old author); no Git config is
   written. The values are validated and passed in the process environment
   (through WSL's `env` launcher for Linux Git) only for that commit command.
   **No `--no-verify`,
  `--no-gpg-sign`, `--force`, `--all`, or `-a` is ever passed**; `--amend` is used
  only by the explicit amend command. No global Git configuration is written.
  Hooks run with stdin closed, so a hook
  that expects a terminal fails instead of hanging.
- Writes for the same underlying repository are serialized by one mutation lock
  keyed by `kind + common directory`, so additional sessions on the same
  repository — and linked worktrees, which share refs and objects — queue behind
  each other. Different repositories never share a lock, and the registry lock is
  only held while looking the key up, never across a subprocess. Validation runs
  inside the lock, so checks and the write are one unit relative to other Gitty
  sessions. External Git can still change the repository before the subprocess
  acquires Git's own index/ref locks. Reads are never blocked.
- Applying a saved identity explicitly sets `user.name` and `user.email` in repository-local Git config (`git config --local --replace-all`), shared by linked worktrees. Values are validated like commit profiles and local values are compared against `expectedLocal` under the mutation lock; external changes detected before writing return `staleOperation`. Only those two keys are written, not global Git config. Git config writes use separate commands, so a failure after the first command may leave one field changed; clients re-read the identity after any failure. Worktree-specific config can override the shared local values and is shown separately in the effective read.
- Before an ordinary stage/unstage/commit write: bare repositories are rejected (`bareRepository`); an
  in-progress merge, rebase, `am`, cherry-pick, revert, sequencer run or bisect is
  rejected (`operationInProgress`), detected from this worktree's Git directory
   *and* by resolving `MERGE_HEAD`/`CHERRY_PICK_HEAD`/`REVERT_HEAD`
  through Git in one `cat-file --batch-check`, because the reftable backend keeps
  some of those outside the Git directory; an existing `index.lock` is reported as
  `indexLocked`. Gitty never removes a lock manually; dedicated graph commands
  delegate explicit continuation/abort to Git. A branch literally named like a pseudo-ref fails
  closed as an operation in progress.
- Unmerged paths are refused (`unresolvedConflict`) for stage and unstage, and
   any unmerged path refuses an ordinary commit; the ordinary diff stays read-only and the
  conflict stages are left intact (`git reset -- path` would silently discard
  them).
- Stage runs `git add --all`, so deletions stage as deletions and a rename staged
  as its old and new path becomes a rename in the index.
- Unstage runs `git reset --quiet`, which restores those index entries
  from HEAD — or empties them on an unborn branch — and **never reads or writes
  the working tree**. Partially staged files keep their working-tree content.
  Paths that match nothing are a silent no-op in Git, so a stale selection
  resolves on the frontend's next refresh rather than failing.
- Discard is the only write that destroys working-tree content, so it is guarded
  twice. Under the mutation lock it re-reads the status and compares its fingerprint
  with the one the caller reviewed (`staleOperation`, nothing touched, when it moved),
  then classifies every requested path from that fresh status and refuses the whole
  request before running anything if any path does not qualify. Untracked files are
  deleted with `git clean --force --quiet -- <paths>`; tracked files with a worktree
  status of `M`, `D` or `T` are restored with `git restore --worktree
  --pathspec-from-file=- --pathspec-file-nul`, whose source is the index, so staged
  content, including the staged half of a partially staged file, is kept. Refused with
  `invalidRequest`: staged-only or unchanged paths, unknown paths, directory or nested
  repository entries (a status path ending in `/`), and intent-to-add, renamed or
  copied entries. Unmerged paths and operations in progress are refused as for stage.
  Restore runs before clean. A failure part-way through the clean batches leaves earlier
  batches applied, so clients re-read status after any outcome. There is no whole-tree
  form and `paths` must be explicit.
- `repository_ignore_path` appends `/<path>` to the root `.gitignore`, with `\`, `*`,
  `?` and `[` escaped and trailing spaces escaped, only for a path that is currently
  untracked (otherwise ignoring it would do nothing). It is append-only, adding a
  newline first when the file lacks one, and goes through a `cap-std` directory handle,
  so a `.gitignore` symlink cannot lead outside the worktree. Names containing a line
  break are refused. It runs under the mutation lock.
- `repository_open_path` and `repository_reveal_path` take a repository-relative path,
  validate it like a write, canonicalize it and require it to stay inside the worktree
  once symlinks are resolved (`invalidPath` otherwise, `notFound` when it is missing).
  Open passes a file to the operating system's default application, so it refuses
  (`openRefused`) anything that is not a regular file, any file with an execute bit on
  Unix, and extensions that are programs or launchers (`app`, `bat`, `cmd`, `command`,
  `exe`, `jar`, `lnk`, `msi`, `ps1`, `scr`, `sh`, `vbs` and similar). Reveal selects the
  file in Finder (`open -R`) or Explorer (`/select,`), and opens the containing folder on
  other platforms. They take no mutation lock. All three commands in this and the
  previous bullet return `unsupported` for repositories inside WSL.
- Commit runs `git commit --quiet --file=-`: the staged index only, never `-a`.
  The message must contain non-whitespace, be under 64 KiB and contain no NUL;
  Git's configured `commit.cleanup` then applies as usual. With nothing staged the
  commit is refused as `nothingStaged` before Git runs (compared against HEAD, or
  against the computed empty tree on an unborn branch, without writing objects).
  An unborn branch is confirmed with `symbolic-ref`: `rev-parse --verify --quiet`
  exits 1 for a detached HEAD at a missing object exactly as it does for an unborn
  branch, and committing a root commit on top of a broken HEAD would be wrong, so
  that case is reported as `unresolvedHead`. The returned `oid` is HEAD read back
   after the command, so it is accurate even if a post-commit hook moved HEAD
   again. If Git fails but HEAD moved anyway, or if HEAD cannot be confirmed, the
   result is `mutationUnverified` rather than a plain failure.
- Amend runs `git commit --quiet --amend --file=-` by default: the message is
  rewritten and the current staged index is folded into the new commit, never
  unstaged content. It requires an existing HEAD and revalidates the expected HEAD OID,
  symbolic ref, and status fingerprint under the common-directory mutation lock
  immediately before Git runs. A mismatch already visible then returns
  `staleOperation`; the check is not an atomic compare-and-swap against external Git
  before the commit subprocess acquires Git's own locks. Hooks, signing, cleanup,
  message limits, uncertain outcomes, and the no-retry rule are the same as for a
  new commit. Two optional booleans, both defaulting to `false` and fully independent
  (the existing composer sends neither and keeps exactly these semantics):
  - `messageOnly` adds `--only` with no paths:
    `git commit --quiet --amend --only --file=-`. Git ignores the index, so the new
    commit keeps the old tree and parents (root and merge commits included), and
    staged, partially staged and working-tree changes are all left exactly as they
    were. Hooks and signing still run.
  - `requireUnpushed` refuses with `pushedCommit` when a known remote-tracking ref
    contains the HEAD being amended. The check (`for-each-ref --contains … refs/remotes`)
    runs under the same mutation lock after the stale checks and before Git runs; a
    failed query is an error, not permission. It reads local refs only, which are not
    proof about the remote, so the message says to fetch.
  The inline message editor sends both `true`.
- Writes get a 120-second deadline of their own (hooks and signing are
  interactive-speed work) instead of the 60-second read request budget; checks
  around them get 30 seconds. A write that is abandoned — timeout, output limit,
  or a lost process — returns `mutationUnverified`, whose message says the
  repository may already have changed and to refresh and check before retrying.
  **The backend never retries a mutation**, and the frontend is expected to
  reconcile from `repository_state`/`repository_status` after every outcome.
- Error codes for writes: `invalidHandle`, `invalidRequest`, `invalidPath`,
  `tooManyPaths`, `bareRepository`, `operationInProgress`, `indexLocked`,
  `unresolvedConflict`, `unresolvedHead`, `nothingStaged`, `pushedCommit` (amend with
  `requireUnpushed` found a containing remote-tracking ref), `staleOperation` (discard review
  out of date), `openRefused`, `notFound`, `unsupported`, `openExternal`, `git` (Git exited
  non-zero: hook rejection, missing identity, signing failure, ignored or
  unmatched paths), `mutationUnverified`, plus the shared `unsupportedEncoding`,
  `inputLimit`, `worker` and process codes.
- Mutations do not invalidate history generations themselves; committing changes
  refs, so the existing state fingerprint already forces the frontend to start a
  new walk.
- Every Git write run through `Repository::write` or `write_commit` (stage,
  unstage, commit, hunks, fetch, pull, push, graph operations) emits a
  `git_command` event after it finishes: `{command, stdin, success, code, millis}`.
  `command` is `git` plus the arguments without `-c` configuration overrides, so
  credential-helper and askpass wiring never reaches the activity log. `stdin` is
  the UTF-8 text fed to Git (NUL-separated pathspecs become lines, commit and
  merge messages are verbatim) or `null`; `git apply` patches are file content
  and are never reported. The environment is not included. Reads and clone are
  not reported.

## Repository cloning

Cloning is workspace-owned because no repository session exists yet. Its IPC
contract is:

- `repository_clone({operationId, request, onProgress}) -> RepositoryLocation`
- `repository_cancel_clone({operationId}) -> void`
- `repository_pick_clone_parent() -> string | null`

`request` contains a source, a native/WSL parent location, and one new directory
name. `onProgress` is a bounded Tauri channel. At most four clones run at once;
operation IDs are UUIDs, and closing the main window cancels registered clones.

- Clone runs installed Git without a shell, outside repository context, with a
  30-minute deadline. It performs a full, non-bare clone of the remote's default
  branch and passes `--no-recurse-submodules`; no partial filter is used. Local
  sources retain Git's local clone behavior but use `--no-hardlinks`, so object
  files are copied rather than sharing inodes with the source.
- Credential helpers, system/global Git configuration, SSH agent/configuration,
  and configured filters remain available. Prompts and external askpass remain
  disabled except for a matching connected provider account on native HTTPS
  clones. Recursive submodules and external transport helpers are disabled.
  HTTP(S) URLs containing credentials
  are rejected; Gitty does not retain credentials.
- The destination must not exist. Git clones into an operation-owned hidden sibling
  and publishes it with a no-replace rename only after success. Failure, timeout,
  and cancellation remove only that owned temporary directory; an existing or
  concurrently created destination is never overwritten or deleted.
- Progress records and total progress output are bounded and updates are throttled.
  Cancellation and publication use one atomic lifecycle transition: cancellation
  accepted before publication prevents the destination rename and cleans the owned
  temporary directory; after publication begins, cancellation is rejected and the
  clone reports its actual completion result. Native cancellation terminates the
  process group. Windows uses a kill-on-close
  Job Object for the `wsl.exe` launcher, but cannot guarantee every Linux descendant
  is terminated; Gitty never terminates an entire WSL distribution.

## Remote tracking and authentication

Connected cloud-provider accounts are managed through `list_provider_accounts`,
`provider_connect_token`, `provider_oauth_start`, `provider_oauth_poll`,
`provider_oauth_cancel`, and `provider_disconnect`. The account metadata file
in app data contains provider, username, an opaque ID and an OAuth flag; access/refresh tokens
are stored in the OS credential store under that ID. GitHub, GitLab and
Bitbucket tokens are checked against the provider's user endpoint on connect.
Azure DevOps PATs are checked when used against an organization. GitHub/GitLab.com
and Microsoft Entra work/school accounts support public-client device authorization,
configured using build-time client IDs. Only request IDs, user codes, approved
verification URLs and timing information cross IPC. Device codes stay in Rust;
tokens are saved only after account verification and refresh before API use.

Provider accounts authorize provider APIs independently of Git operations. Native
HTTPS clone/fetch/pull/push append bundled Git Credential Manager as a fallback
after existing helpers, unless GCM is already configured or helpers are explicitly
disabled. Gitty does not modify global Git configuration, and provider tokens do
not override existing helpers. Tokens never appear in Git arguments, remote URLs
or browser preferences. WSL keeps its own distribution credential handling.
`provider_pull_requests` and
`provider_create_pull_request` call bounded, host-specific HTTPS provider APIs
for a selected connected account. PR creation is explicit and does not push.

- The native pane schedules a fetch of the selected/configured remote about every
  five minutes while active and visible. The backend's `backgroundFetch` action
  uses an explicit `refs/heads/*:refs/remotes/<remote>/*` refspec with `--no-tags`
  and no pruning; it never moves local heads, checks out, merges, or rebases.
  The normal mutation lock and post-action refresh apply even on failure.
- Background fetch remains noninteractive (`credential.interactive=false` plus
  `GCM_INTERACTIVE=false`) and can use existing credentials and SSH agents.
  Explicit clone/fetch/pull/push allow helper sign-in. Native operations can use
  a local per-app askpass bridge when those cannot supply credentials. Gitty
  keeps answers in memory only. A cancelled or expired prompt fails the helper,
  and a prompt has a 90-second response deadline within Git's write deadline.
  On Windows, explicit WSL fetch/pull/push can use a per-operation scoped askpass
  bridge when `wslpath` translates the Gitty executable for Windows interop.
  If translation fails (or no askpass registry is available), the helper-UI
  fallback sets `credential.interactive=true`, so a credential helper with its
  own sign-in window (typically Windows Git Credential Manager reached through
  WSL interop) can re-authenticate. Terminal prompts remain disabled. The WSL
  bridge inherits SSH `BatchMode=yes` even though it sets `SSH_ASKPASS`;
  interactive SSH passphrase support is not established. Without the bridge,
  askpass remains disabled. Background fetch remains fully noninteractive. Failed
  explicit actions explain this. No user credential is embedded in a Git argument;
  ad-hoc prompt answers are not retained, while connected account tokens remain
  in the OS credential store until disconnected.
- The frontend auto-fetches only the focused tab of a visible window: when a
  repository opens, when its tab or the window regains focus, and on a 30-second
  check, at most once per five minutes. Explicit fetch and pull reset that clock.
  Background fetch failures appear as a toolbar fetch status, not an error banner.
- Pull (`RemoteAction::Pull`) no longer requires an entirely clean worktree.
  Fast-forward and merge pulls preserve existing working changes whenever Git can
  safely carry them, while `--no-overwrite-ignore` and Git's untracked collision
  checks protect untracked and ignored files from being overwritten. If incoming
  changes conflict with uncommitted local work, Git refuses the integration with
  its path-specific explanation. Rebase pulls (`PullMode::Rebase`) refuse tracked
  staged or unstaged changes (`dirtyWorktree`), while allowing untracked files
  provided they do not collide with incoming commits (`protect_untracked`).
  No automatic stashing is performed. Callers refresh repository state on every
  outcome, and conflicts between local commits and incoming commits leave the
  operation in progress for existing conflict controls.

## Graph operations and full conflict editor

The exact additional IPC contract is `src/model/operations.ts`. All six commands
are registered as application commands (no broad filesystem or opener plugin
capability is exposed):

- `repository_operation_state({handle}) -> OperationState`
- `repository_run_operation({handle, request}) -> OperationResult`
- `repository_conflict_file({handle, path}) -> ConflictFile`
- `repository_resolve_conflict({handle, path, fingerprint, resolution}) -> void`
- `repository_remotes({handle}) -> RemoteInfo[]`
- `open_external_url({url}) -> void`
- `editor_reply({requestId, content}) -> void`

Rust serde names, nullability and tagged unions match that contract. `currentUpstream` is the remote-qualified short
name, such as `origin/main`. The singular fetch/push URL fields report Git's
effective first URL; all locally known remote branches are included, except the
remote's symbolic `HEAD` alias. These reads do not fetch or contact remotes.

### Operation safety and semantics

- The common-directory mutation lock also covers graph actions and conflict
  resolution. `expectedHead`, `expectedHeadRef` and `expectedOperation` are
  revalidated under that lock. The operation fingerprint includes all refs,
  status/content fingerprints, index stages, operation metadata and conflict
  working bytes. Changed expectations return `staleOperation` before writing.
  This serializes Gitty sessions, not external Git processes: Git's own locks
  remain authoritative and an external change can still race a subprocess.
- New actions require no in-progress operation. Branch creation and merges allow
  local changes that Git can safely preserve; other new actions require a clean
  worktree/index, including no untracked files (except carrying a branch switch,
  described below). Bare repositories are rejected. Gitty never forces,
  automatically stashes, removes locks or automatically retries writes.
- Branch creation resolves the start point to a commit; checkout is optional.
  Creation without checkout leaves local changes untouched; checkout carries
  staged/unstaged/untracked work when Git can preserve it, refusing overwrites.
  Switching accepts local branches only (`switch --no-guess`). `switchBranch`
  with `carryChanges: true` skips the clean-worktree requirement: Git's plain
  switch carries staged/unstaged work, and `--merge` is used only when the target
  changes a tracked path that has local changes, so conflicts return as an
  `OperationResult` with `operation.conflicts` for the conflict editor (this can
  restage merged paths). Untracked/ignored obstructions are still refused by Git. Merges target the
  current local branch with explicit `--ff` or `--no-ff`, and `--no-edit`.
  Git preserves unrelated local changes and refuses changes that would be
  overwritten or ordinary staged changes that would enter a true merge commit.
  Switch/merge refuse ignored-file overwrites. Rebase/cherry-pick preflight
  destination/replay trees, including queued continuation steps, for obstructing
  ignored or untracked files.
- Rebase is noninteractive, uses the merge backend and disables autostash,
  autosquash and update-refs. A range containing merge commits is rejected with
  `mergeHistory` rather than silently flattening it. Detached merge/rebase
  requests are rejected. Ordered cherry-picks accept 1–100 concrete commits and
  validate the optional 1-based mainline against every merge commit first.
- `interactiveRebase` accepts an ancestor `onto` and a complete permutation of
  1–100 concrete, linear commits with `pick`, `drop`, `reword`, `squash`, or `fixup`.
  It rejects duplicates, missing commits, merge ranges, an all-drop plan, or a
  squash/fixup without an earlier retained commit. The reviewed fingerprint and
  HEAD are checked under the mutation lock. A per-mutation authenticated
  `GIT_SEQUENCE_EDITOR` bridge verifies Git's generated pick list matches every
  reviewed commit before rewriting the todo; it does not accept `exec` or
  user-supplied patch text. Native `GIT_EDITOR` prompts handle message edits.
  WSL interactive rebase creation remains unsupported.
- Tags never overwrite existing refs. A supplied message creates an annotated
  tag and honors signing configuration; no message creates a lightweight tag
  (explicit `--no-sign` avoids `tag.gpgSign` changing its type).
- Continue/skip/abort use Git's existing operation state, so application restart
  is not special. Merge cannot skip. Rebase/cherry-pick/revert can skip. Rebase
  progress reads Git's step/total; sequencer progress combines completed commits
  and its remaining todo. A stale `REBASE_HEAD` alone is not an active rebase.
  Apply-backend rebases, `git am`, bisect and unknown sequencers are explicitly
  unsupported. Supported rebase todo instructions are `pick`, `reword`, `squash`,
  and `fixup`. Directives including `exec`/`x`, `break`, `label`, `reset`, `merge`,
  `update-ref` and unknown instructions are rejected with `unsupportedOperation`;
  they must be continued in Git, but can still be aborted here.
  Rebase abort/skip conservatively refuses non-conflicted staged/unstaged changes
  it cannot distinguish from unrelated work, including some staged resolutions.
- Hook and signing settings remain active. Non-editor operations use constant
  editor overrides to stay noninteractive. For eligible native rebase continuation
  requiring message edits (`reword`, `squash`), an authenticated loopback TCP
  `GIT_EDITOR` bridge prompts the desktop app without exposing filesystem paths.
  Each concurrent rebase receives a distinct helper token and pending prompts
  are cancelled only for their own mutation. Message files are checked against
  their initial contents and replaced within a pinned parent directory, so a
  symlink swap cannot redirect an editor save outside the Git directory.
  Prompts have a 90-second response deadline. User cancellation, timeout, or
  tampered files on disk cause the helper to exit nonzero, safely interrupting the
  Git write without modifying the message. WSL Git cannot run native editor helpers;
  interactive rebase continuation on WSL repositories is refused with an explanation
  to finish in Git.
- A conflict-producing Git exit returns `OperationResult` with output, actual
  HEAD and refreshed operation state. Other Git failures return `{code,message}`.
  The frontend must refresh repository/status/operation state in `finally` on
  **every** mutation outcome, including errors. Timeout/capture failures are
  `mutationUnverified` and must not be blindly retried. Post-write reads do not
  inherit an already-expired read-request budget from a slow hook.

### Conflict data and writes

- The editor reads full stage 1/2/3 blobs by object ID, independently of the
  truncated diff viewer. Strict UTF-8 and NUL checks determine editability.
  Missing stages are `null`; binary/non-UTF-8 stage content is `null` with an
  explanation. Each blob/working result is limited to 16 MiB; oversize content
  returns an explicit error, never a truncated editable string.
- The opaque fingerprint covers stage modes/OIDs, actual working bytes/type,
  HEAD and relevant operation refs. Resolution re-reads it under the mutation
  lock. Changes are rejected before writing. Selecting a missing side fails
  with `missingStage`; deletion must be chosen explicitly.
- Text replaces the working bytes exactly (including CRLF and final-newline
  choice), then `git add` applies the repository's usual clean/EOL rules.
  Working stages the existing regular file. Delete removes only that regular
  file and stages its deletion. Ours/theirs write the selected blob's exact bytes
  and install its exact OID/mode with `update-index --index-info`; binary bytes
  are never decoded or filtered through a text representation. Side selection
  therefore uses repository blob line endings, not smudged worktree endings.
- Native editing uses capability-rooted directory handles (`cap-std`), validates
  every ancestor and rejects symlinks. Replacement writes are temporary files
  renamed within the pinned parent directory. WSL uses a fixed Python 3 program
  via `wsl.exe --exec python3 -c`, with JSON/binary stdin and `openat`-style pinned
  directory descriptors plus `O_NOFOLLOW`. **WSL conflict filesystem access
  requires Python 3**; Git operations otherwise use the existing WSL Git transport.
- Ordinary add/add and modify/delete conflicts work, as do independent regular
  file paths in rename conflicts. Git still determines rename relationships
  after staging. On Unix and WSL, symlink conflicts support exact stage-2/stage-3 blob/mode selection
  or deletion, installing the link without following its target; text editing and
  staging an existing symlink as the resolution are unavailable. When both
  submodule sides are gitlinks and the working path is a directory or absent,
  choosing one side installs its exact OID in the index without modifying the
  nested worktree; deletion and other submodule path layouts remain unsupported.
  Directory/file and other special-file conflicts, missing parent directories,
  and ambiguous path spellings receive explicit
  unsupported errors rather than unsafe editing. Conflict paths cannot traverse
  `.git`, `..`, symlink ancestors, Windows alternate streams or path separators.
- A Git staging/index failure after the working replacement can leave an edited
  but unresolved file. It returns `mutationUnverified` without rollback or retry; refresh
  and review before the next action. Ordinary stage/unstage/commit/amend still reject
  all in-progress operations and unmerged paths.

The external opener is invoked only by its explicit IPC command. URLs are parsed,
must use HTTPS with a host, and must not contain credentials, whitespace, control
characters or backslashes. `open` uses the platform opener with a separate URL
argument; there is no general-purpose shell command or URL-handler capability.

## Verification

`cargo fmt`, `cargo test`, and `cargo check` run on macOS. Tests create real Git
repositories and cover history mutation between pages, merges, shallow original
parents, unborn/bare/detached/linked repositories, rename and binary metadata,
untracked/staged/unstaged/conflicted changes, root comparisons, odd filenames,
message/author/hash/ref OR search with combined filters, protected global
`safe.directory` and system configuration, a 100,005-commit history with only four
IDs cached after the first three-commit page, cursor replay after moving refs,
stream cancellation/reaping, driver suppression and unchanged index bytes/mtime, timeout and
output limits, persistence, and invalid handles/cursors. The non-UTF-8 filename
integration test is Linux-only (APFS rejects those filenames).

Write tests also use real repositories: staging, unstaging and the initial commit
on an unborn branch with spaces, tabs, Unicode, a leading dash and pathspec
metacharacters in file names; rejected empty requests and escaping paths; a
partially staged file committing only its index content while the working tree
keeps its newer content; unstaging a partially staged file, a staged deletion and
a rename; committing a rename as one `R` entry; refusal on bare repositories, on
a conflicted merge (with `MERGE_HEAD` left untouched), on a directory-shaped
rebase state, and on a conflicted `stash pop` that has no operation state at all;
detection of a conflicted cherry-pick in a `--ref-format=reftable` repository
(skipped automatically if Git has no reftable backend); a held `index.lock` that
is respected and left on disk; an empty identity and a failing `gpg.program`
reported without moving HEAD; a rejecting `pre-commit` hook whose output reaches
the caller with the index and working tree preserved; eight concurrent stages
from three sessions across a repository and its linked worktree, followed by a
commit in each; and a sleeping hook that proves a second session for the same
repository waits while an unrelated repository does not. A 400-path request and a
40 KiB message, both larger than a Windows command line, are staged, committed
and unstaged in single requests; a `pre-commit` hook that reads stdin receives
nothing while the message arrives intact; a directory selection covering a
conflict is refused while a sibling with a shared prefix is not; and a HEAD
detached at a missing object is reported as `unresolvedHead` instead of becoming
a second root commit. The unverified-outcome mapping for abandoned writes and the
non-empty NUL-separated pathspec payload are unit-tested rather than by a
120-second timeout. Hook tests are Unix-only.

Amend tests cover message-only and staged rewrites while preserving unstaged
content, stale HEAD/ref/status rejection under the mutation lock, hooks, and
signing failures. Clone tests use local bare remotes and cover an openable result,
default-branch/full-clone behavior, no recursive submodule initialization,
progress, cancellation, timeout/error cleanup, and preservation of existing and
concurrently created destinations.

Real WSL tests (`src/wsl_tests.rs`) run on Windows when `GITTY_WSL_TEST_DISTRO`
names a distribution with Git (`$env:GITTY_WSL_TEST_DISTRO="Ubuntu"; cargo test
wsl_tests`). They create temporary repositories under `/tmp` inside the
distribution and cover opening a path with spaces/Unicode, state, status and
untracked-content fingerprints, stage/commit, index-lock detection, background
fetch, pull and push against a local bare remote, and report refresh timing.
Without the variable they return immediately.

Windows Job Objects and the graphical picker require platform/UI
integration testing; they are not exercised by the macOS unit test suite. Killing
the Windows WSL launcher cannot promise termination of every Linux descendant
inside the distribution. The app does not terminate an entire WSL distribution.
Under WSL, the Git-directory listing used for lock and operation detection runs
`find -maxdepth 1` in the distribution and therefore needs the same GNU `find`
the browser already requires; it is not covered by the macOS suite. Graph
operations, regular-file conflict resolution, hunk staging, stashes, remote
operations, amend, and cloning are described above. Line staging and a scoped
WSL askpass bridge have local tests; Windows/WSL runtime checks remain open.
The current suite includes 189 passing library tests (one ignored) and two binary tests on macOS. One signing test, `operations_unsupported_state_bare_and_signing_errors`, depends on the machine's global Git configuration: a global `gpg.format =` with an empty value makes Git abort while reading configuration, which no repository-local setting can override, so run it with `GIT_CONFIG_GLOBAL=/dev/null` on such a machine.
