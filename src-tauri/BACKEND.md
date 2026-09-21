# M2 native repository service

All commands in `src/model/repository.ts` are registered by `src/lib.rs`. The
Rust DTOs serialize the same camelCase fields and `{code, message}` errors.
`backend_info` remains available and reports native capability.

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
  then starts **one** `rev-list --topo-order <captured IDs> --` process per generation.
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
  unchanged status letters still refresh. This adds Git work, especially with many
  untracked files. Repository state also fingerprints remotes and shallow boundaries
  so deepening without moving refs invalidates the walk. Reads are best-effort across
  concurrent external changes; nested repository contents are not recursively hashed.
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
- The folder picker uses `rfd`'s native asynchronous dialog. WSL discovery decodes
  UTF-16 output; browsing invokes Linux `find` directly, NUL-delimited, one directory
  level at a time. WSL requires Windows and Linux Git, `env`, and GNU `find`.

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

Windows Job Objects, WSL execution, and the graphical picker require platform/UI
integration testing; they are not exercised by the macOS unit test suite. Killing
the Windows WSL launcher cannot promise termination of every Linux descendant
inside the distribution. The app does not terminate an entire WSL distribution.
