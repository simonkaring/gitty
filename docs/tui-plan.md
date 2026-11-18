# Gitty terminal UI — implementation plan

## First release

Build a keyboard-first Git client for one local repository. Run `gitty-cli tui`
from a repository or `gitty-cli tui --repo PATH` from elsewhere. Browse the
graph and diffs, review working changes, stage or unstage files, create a
commit, and fetch, pull, push, or publish a branch to a configured remote.
Ship the read-only browser as the first milestone slice, not the full release.
Leave existing CLI/stdio interfaces and the desktop UI unchanged.

Defer hunk/line staging, amend, discard, checkout, clone, remote management,
force-push, merge/rebase pulls, auto-fetch, conflict resolution, multi-repo
tabs, and live watching. Sync from a local repository to its configured Git
remote is in scope; opening a repository through Gitty's WSL/SSH transport
is not.

The main workflow is **History → Working changes → Commit → Sync**. Keep
these views reachable from a visible key legend; opening a view or typing a
commit message must not stage files, write a commit, or contact a remote.

## Architecture

- Add a `tui` module under [`crates/gitty-cli/src/`](../crates/gitty-cli/src/).
  Use Ratatui with Crossterm, choosing versions compatible with the CLI's
  [Rust 1.89 minimum](../crates/gitty-cli/Cargo.toml).
- Call the typed [`gitty-core` repository API](../crates/gitty-core/src/repository.rs)
  in process. Reuse local repository opening, pinned history pages, commit
  details, and [`diff_files` / `diff`](../crates/gitty-core/src/diff.rs). Send
  writes through `Service` for mutation locking and preflight. Put any new
  review guards in `gitty-core`, not in UI-only checks or a new Git wrapper.
  Do not introduce a server or pipe requests through a CLI child.
- Keep terminal rendering separate from key handling and repository reads. Give
  one worker ownership of the repo session, keep requests bounded, and tag
  results so a slow read cannot replace the current selection. Allow only one
  write in flight and never queue another write. After any write attempt, read
  authoritative state before enabling writes again; preserve drafts and show
  stale, refused, failed, and unverified outcomes distinctly. Never auto-retry.
  Close the session on shutdown. Quit promptly during reads. If a write is
  running, `q` or Ctrl-C requests exit after the write and local reconciliation;
  cancel any pending credential prompt immediately. Keep the wait visible and
  bounded by existing operation deadlines. Cancellation is not rollback.

## Milestones

1. **Prove the graph in a terminal.** Open a real local repo and draw the first
   history page. Use a small Rust lane layout informed by the
   [desktop layout tests](../src/graph/layout.test.ts), not a port of its canvas
   renderer. Check ordinary merges, octopus merges, and a page split mid-branch
   at 80 columns before expanding the UI. Give the graph a bounded width and
   mark clipped lanes instead of pretending they ended. The graph must remain
   legible without color.
2. **Make history navigable.** Add arrow keys and `j`/`k`, Page Up/Down,
   `q` to quit, and a visible key legend. Fetch the next page near the bottom
   without moving existing rows or losing the selected commit. Keep lane state
   across pages and distinguish unloaded parents from shallow or unavailable
   boundaries. Match the [desktop stash convention](../src/components/RepositoryPane.stashGraph.test.tsx)
   by hiding stash helper edges. Add `r` for manual refresh: start a fresh
   generation, restore the selected commit if present in the new first page,
   and otherwise fall back to the first row. Never append a stale cursor to
   a new generation.
3. **Add the inspector.** `Enter` opens the selected commit; `Tab` switches
   between changed files and diff; `Esc` returns to the same history row.
   Use `DiffSpec::Commit` with the default first-parent base for merges and
   label that choice in the UI. Load only the selected file's patch. Use a
   separate full-width inspector at narrow sizes and show explicit states for
   binary, empty, oversized, and unavailable diffs. Render repository-controlled
   text as text, escaping terminal control characters at the display boundary.
4. **Make terminal lifecycle safe before enabling writes.** Refuse
   non-interactive input/output before entering raw mode. Restore terminal
   state on quit, handled Ctrl-C, and errors or panics after setup. Handle empty
   repositories, invalid paths, and resizing. Isolate TUI-launched Git and
   its helpers from the controlling terminal (a new session on Unix; verify
   equivalent console isolation on Windows). Raw Git prompt settings alone
   do not stop hooks, credential helpers, or pinentry from opening the terminal.
   Keep desktop and existing CLI process behavior unchanged. Do not enable
   writes on a platform until isolation and cleanup are verified.
5. **Stage and unstage whole files.** Show separate index and worktree lists
   from status, with per-file staged, unstaged, or untracked diffs. A partially
   staged file can appear in both lists. Act only on explicit selected paths;
   follow [desktop rename selection](../src/model/workflow.ts): stage includes
   the old path only for a worktree rename whose index status is neither
   renamed nor copied. Unstage includes the old path only for an index rename,
   never a copy. Ordinary untracked directories are listed file by file;
   refuse trailing-slash embedded-repository entries rather than staging a
   Git link the user didn't review. Reuse `Service::stage` / `unstage` with
   reviewed entry points. Under the mutation lock, stage rechecks selected
   status entries and worktree content/type, including both rename paths;
   unstage checks the selected index entries and the HEAD/ref used as its
   reset base, not worktree contents. Don't use the whole-repo status
   fingerprint. Never turn a missing selection into
   “all,” change working files, or disturb unrelated index entries. Keep
   conflicts inspectable but don't offer ordinary write actions Gitty would
   refuse. A bare repository has no Working Changes or Commit actions.
6. **Commit from the reviewed index.** Show the target branch or detached HEAD, the
   entire staged file list, and a multiline message. Require explicit submit;
   no implicit stage, amend, sign-off, or push. Reuse
   `Service::create_commit_with_identity` internals with Git's configured
   identity, hooks, and signing. Add a reviewed entry point: the current one
   does not accept expected HEAD/ref or index state. Revalidate the reviewed
   HEAD OID, symbolic ref (including an unborn branch), and full staged-entry
   snapshot (compare the bounded NUL-delimited `git ls-files --stage -z`
   output, not worktree content or tracking counts) under the mutation lock.
   Stale review means refresh, retain the message,
   and require confirmation again. This guard covers Gitty writers and detects
   external changes before preflight completes; it is not a transaction with
   external Git. On confirmed success, surface the new OID and refresh status
   and history. Hooks can modify the index: compare the resulting commit tree
   with the reviewed staged snapshot and report differences rather than
   promising that hooks cannot alter the commit. On unverified completion,
   reconcile before offering another
   commit; do not claim failure or success without evidence.
7. **Sync with configured remotes.** Show offline `sync_info` and remote
   metadata; label ahead/behind as relative to local tracking refs. Fetch
   does not prune refs for deleted remote branches.
   Offer explicit Fetch for a named remote, fast-forward-only Pull into the
   current branch from its upstream, and normal Push of the current branch
   to its same-name upstream. For a first push, Publish names the remote and
   destination and explicitly sets upstream on success. Show and confirm the
   source/destination before push or publish; don't silently push to a
   differently named upstream. Reuse [`Service::remote_action`](../crates/gitty-core/src/remote.rs)
   and typed [`RemoteAction`](../crates/gitty-core/src/remote_dto.rs) with
   explicit targets. The current actions don't accept UI review expectations:
   add shared guarded entry points to recheck the reviewed branch/ref/OID,
   upstream, and effective URL under the mutation lock. Use Git's resolved
   fetch URL for Fetch/Pull and its single resolved push URL for Push/Publish;
   URL equality does not pin SSH configuration or server identity. The push
   guard pins local state, not the server ref; Git enforces non-force push
   rules. Keep the existing post-fetch pull recheck. Never force, auto-stash,
   or retry. A refused pull can still update tracking refs, and interruption
   can leave a private `refs/gitty/pull/*` ref.

   Once push starts, only classify an error as a confirmed rejection if Git's
   porcelain reports rejection for the exact destination ref. Otherwise,
   retain the attempted source OID, destination ref, and endpoint for
   reconciliation. Offer an explicit, read-only lookup of the exact ref at
   the reviewed **push** endpoint through `gitty-core` (not a fetch from a
   potentially different URL). Report whether the destination currently
   matches, differs, is absent, or could not be checked; that does not prove
   whether a previous push ever landed. For Publish, separately check local
   upstream configuration. Require fresh review for another push; if the
   endpoint cannot be verified, show manual recovery guidance instead of
   offering a retry. Redact credentials in displayed URLs and diagnostics.

   Start with user-configured credential helpers and SSH agents; do not
   assume the desktop's bundled helper fallback. For prompts reuse
   the [scoped askpass bridge](../crates/gitty-core/src/askpass.rs) with masked
   input, trusted operation context, and existing expiry/cancellation. Reuse
   the CLI askpass helper mode. Answer prompts independently of the worker
   waiting for Git; cancel pending prompts and clean up the registry on exit.
   Disable Git's own terminal prompts and never persist or log answers.
8. **Document the release.** Document launch commands, keybindings,
   and supported platforms in the README; update the
   [headless knowledge guide](knowledge/headless-inspection.md) when the
   implementation lands. Update the
   [mutation safeguards](knowledge/git-mutation-safeguards.md) and
   [backend contract](../src-tauri/BACKEND.md) with any new review guarantees.

## Release checks

- Unit-test lane joins, clipping, stash edges, and append stability; test
  selection, refresh, and stale results separately from rendering. Use a
  Ratatui test backend to exercise narrow and wide layouts.
- Use disposable real-Git fixtures for paged merge history, root and merge
  diffs, renamed and binary files, and shallow history. Compare HEAD, refs,
  index, and working-file contents before and after a read-only session.
- For local writes, verify literal paths, renames and copies, embedded-repo
  refusal, partial staging, unrelated index entries, unchanged working bytes,
  and an unborn branch. Verify exact committed trees with non-mutating hooks
  and notices when a hook changes the committed tree. Change selected content,
  the index, or HEAD externally between review and execution and verify the
  relevant action is refused; unrelated edits or a fetch must not invalidate
  a commit. Cover lock contention, signing failures, and uncertain completion.
- For sync, use disposable bare remotes with an independent clone. Verify
  fetch-only ref updates, fast-forward pull, diverged pull/push refusal,
  publish/upstream configuration, and changed review targets. Assert local and
  remote refs independently. Simulate push acceptance followed by client failure
  or timeout, including separate fetch and push URLs. Exercise missing credentials,
  askpass success, cancellation and expiry without real secrets or a public
  remote. Test a helper opening `/dev/tty`, terminal-based pinentry, and whether
  Windows OpenSSH can invoke the existing askpass helper before claiming support.
- Verify existing CLI/stdio behavior and run `npm run check:headless`,
  `npm run test:headless`, and `cargo fmt --all -- --check`. Smoke-test launch,
  resize, slow reads, and terminal restoration in a real terminal on macOS,
  Linux, and Windows before claiming support on each.

The first milestone is the go/no-go check: a merge-heavy graph must remain
useful at 80 columns, and loading another page must not redraw existing lanes.

## Status

All milestones are implemented in `gitty-cli tui`. Writes are enabled only on
macOS; Linux and Windows builds are read-only until terminal isolation, cleanup,
and askpass are verified there. Not yet exercised: real terminal pinentry
signing, Git Credential Manager, SSH passphrase prompts, and an interactive
manual session in a non-PTY-emulated terminal.

Run the local smoke test with `cargo build -p gitty-cli && python3 scripts/test-tui.py`.
It uses a macOS pseudo-terminal and disposable repositories; it does not
establish Linux/Windows write support or cover real-host SSH and signing prompts.
