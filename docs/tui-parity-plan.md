# Gitty terminal UI — catching up with gitui

Follow-up to the [first-release plan](tui-plan.md). The goal is to make
`gitty-cli tui` a daily driver while keeping what gitui lacks: the lane
graph, review before every write, commit profiles, and one engine shared with
the desktop.

Most of the gap is UI, not engine. `gitty-core` already has reviewed entry
points for nearly everything gitui does:

| gitui feature | Engine today | TUI today |
|---|---|---|
| Writes on all platforms | Yes | macOS and Linux; Windows read-only (`WRITES` in `tui.rs`) |
| Hunk and line staging | `stage_hunk` / `unstage_hunk` with fingerprint and `line_indices` | Reviewed files, hunks, line ranges, and current list |
| Discard / revert changes | `Service::discard` / `discard_hunk` | Reviewed files and hunks |
| Amend | `amend_commit_with_identity` with expected HEAD/status | Reviewed eligible HEAD, `F3` toggle |
| Stash apply, drop, inspect | `StashAction::{Apply, Drop}`, `stashes()` | Reviewed save, apply, pop, drop, and tracked/untracked inspection |
| Branch create, checkout, delete | `GitAction::{CreateBranch, SwitchBranch}`, `delete_branches` | Reviewed branch list actions |
| Log search | `search()` / `cancel_search()` | History matches, `n`/`N`, cancellable |
| Tags, merge, rebase, cherry-pick, continue/abort | `GitAction::*` with `reviewed()` | None |
| Branch rename | `GitAction::RenameBranch` | Reviewed local rename |
| Blame | **Missing** | None |
| Help for the current screen, custom key bindings | n/a | Fixed legend |

Every new action follows the rule from the first release: open a review
screen, send the write through `Service` with the reviewed state, and read
the repository again afterwards. Don't check anything in the UI alone, and
never retry automatically.

## Phase 1 — Writes on Linux and Windows (blocker)

Nothing else matters to most users until this is done.

1. Linux: verify the new Unix session isolation, terminal restore on panic
   and Ctrl-C, and askpass with a user's credential helper and SSH agent. Port
   `scripts/test-tui.py` (Python `pty`) to run on Linux in CI.
2. Turn on `WRITES` for Linux once step 1 passes. Ship that before Windows.
3. Windows: confirm console isolation and that Windows OpenSSH calls our
   askpass helper. Add a ConPTY smoke test (or a documented manual checklist
   if automation isn't feasible), then turn on `WRITES` for Windows.
4. Still to test on every platform: terminal pinentry signing, Git Credential
   Manager and SSH passphrase prompts (the [first-release
   status](tui-plan.md#status) lists these as untested).

Done when the smoke test passes in CI on Linux and has been run by hand on
Windows, and the README no longer says writes are macOS-only.

## Phase 2 — Staging and committing like gitui

Implemented: reviewed hunk/line stage and unstage, file/hunk discard, amend,
and stage/unstage of the current list. `n`/`N` selects hunks, `v` starts a
line range, `s` reviews it, `d` reviews discard (`D` additionally authorizes
untracked deletion), `S` reviews the list, and `F3` toggles amend.
All writes reconcile repository state afterwards; stale reviews require a
fresh selection. Hunk discard uses a shared core fingerprint-checked reverse
patch; list writes validate every selection before changing the index.
Verified with real-Git unit tests, 80/120-column render checks, and repeated
Linux PTY smoke runs. macOS execution remains to be checked on a macOS host.

1. **Hunk and line staging in the diff view.** Move between hunks with
   free keys (`[` is already taken), `s` stages or unstages
   the hunk, and `v` starts a line selection. Pass the diff fingerprint we
   showed so a changed file is refused, not staged wrongly. Port the
   behaviour from the desktop, not its code.
2. **Discard.** `d` on a file or hunk, behind a review screen that names
   exactly what will be lost. Untracked files need their own explicit
   confirmation.
3. **Amend.** A toggle on the commit review screen. Reuse
   `commit_edit_eligibility` to hide it for merges or published commits the
   desktop refuses, and keep the message draft when switching.
4. **Stage all / unstage all** for the current list, with the same review.

## Phase 3 — Branches, stashes and search

Implemented: `B` lists local and remote branches with counts relative to HEAD;
`Enter` checks out, `n` creates, `e` renames, and `d` deletes local/origin
branches. `C` in history creates from the selected commit. The engine's clean
checkout and non-forced deletion refusals remain visible. Other remotes remain
inspectable; checkout/deletion retain the engine's origin-only remote support.
`t` lists stashes with tracked/untracked inspection, apply/pop with optional
index restoration, and drop. `/` searches history; `n`/`N` reveals matches
across history pages, and `Esc` cancels the Git walk and rejects late replies.
All new writes are reviewed, guarded by `Service`, and followed by a refresh.
Verified with full CLI/core tests, 80/120-column render checks, TypeScript and
format checks, and three successful Linux PTY runs. Clippy retains its existing
baseline warnings. macOS/Windows execution remains untested for this phase.

1. **Branch list view** (`B`): local and remote branches with ahead/behind.
   Checkout with `SwitchBranch` (respect `switch_overlaps_changes`), create
   from the selected commit, delete with `delete_branches`.
2. **Branch rename.** The only missing engine piece in this phase: add
   `GitAction::RenameBranch` in `gitty-core` with review and tests. The protocol
   and TypeScript action type include it; desktop rename controls are deferred.
3. **Stash list view**: inspect a stash's diff, apply (with an option to
   restore the index), pop, drop. The graph already draws stashes, so
   selecting one can open this view.
4. **Log search** (`/`): call `search()` on the worker, show matches in
   the graph, `n`/`N` jump between them, `Esc` cancels with `cancel_search()`.

## Phase 4 — Usability

Implemented: contextual `?` help (`F1` in editors), a shared named-action table
for dispatch/help/footer, and optional `keys` overrides or `"keys": "vim"` in
`tui.json`. Conflicts and invalid key settings visibly fall back to defaults
without overwriting the file. Mouse actions remain logical actions, and every
write retains its review step.
Verified: full CLI/core suites, key lookup/conflict/preset/settings round-trip
tests, remapped-write review and 80/120-column help checks, and three consecutive
Linux PTY runs covering help and remapped staging. Formatting passes; Clippy
has only the existing baseline warnings. Other platforms remain untested here.

### Benchmark — synthetic 200k commits

One release-mode Linux run using `scripts/bench-tui.py --generate`:
200,000 empty-tree commits, 2,000 merges, two branch tips, 100 commits per page.
The ignored `terminal_benchmark` test runs the real TUI worker, app paging and
graph code, rendering a 120×40 test terminal after each page.

| Measurement | Result |
|---|---:|
| Open through first history page | 1,414 ms |
| Load remaining history to the end (2,000 pages total) | 20,644 ms |
| Graph layout and rendering within paging | 1,988 ms |
| Peak Linux process RSS (`VmHWM`, Git children excluded) | 106,216 KiB (103.7 MiB) |
| Cumulative paging at 50k / 100k / 150k / 200k commits | 3.58 / 8.23 / 13.90 / 20.64 s |

No graph-layout explosion appeared in this fixture. Paging did slow down:
successive 50k blocks took 3.58, 4.65, 5.67 and 6.75 seconds.

Cause (measured, not yet fixed): the per-page `git cat-file --batch` spawn.
Git's own time is flat (4 ms for the newest or oldest 100 commits). TUI-launched
Git gets `pre_exec(setsid)` in `process::spawn_piped` for terminal isolation,
which makes std use `fork()` instead of `posix_spawn`, and `fork()` cost grows
with the TUI's resident memory (every loaded commit). With the hook disabled
as an experiment, paging all 200k commits fell from 42.5 s to 14.1 s on the
same machine, with flat 3.5 s per 50k commits. The cursor-map scan is not a
factor (≤2,000 entries). Per page this is ~6 → ~13 ms at 200k commits deep,
so it only matters when loading a whole very large history.

The isolation itself must stay. Fix options, in order of preference:
1. Use `CommandExt::setsid` (`POSIX_SPAWN_SETSID`) once `process_setsid` is
   stable; still unstable on Rust 1.98.
2. Call `posix_spawn` with `POSIX_SPAWN_SETSID` directly via `libc` for the
   TUI path. Needs a replacement for `std::process::Child` in every
   `spawn_piped` caller, so it's a large change.
3. Keep TUI memory per commit lower; this reduces the slope but doesn't remove it. This empty-tree fixture is not a Linux-kernel checkout or a
bound on repositories with many concurrent lanes, large files or thousands of
refs; benchmark those before claiming general large-repository performance.

1. **Help overlay** (`?`): bindings for the current view, built from the
   same table the key handler uses so the two can't drift.
2. **Custom key bindings**: an optional `keys` map in `tui.json`, with a
   vim preset. Only after the table from step 1 exists, so it's one lookup
   instead of edits throughout `tui.rs`.
3. **Large repositories**: build a gitui-style benchmark (full Linux kernel
   history: time to scroll to the end, peak memory, no freezes) using
   `bench_tests.rs` as a starting point. Fix whatever it finds before
   claiming speed.

## Phase 5 — Beyond gitui (optional)

Item 1 implemented: reviewed merge/rebase/cherry-pick/tag from history and
branches, an operation header, and reviewed continue/skip/abort. Merge's stash
option is off until explicitly toggled in review. Real-Git stale-review tests
and PTY cherry-pick/conflicting merge/abort coverage are included.
Item 2 implemented: a bounded linear interactive-rebase plan with all five
instructions and reordering, followed by an immutable review. EditorRegistry
supplies reword/squash messages through an in-TUI editor, including cancellation,
expiry and shutdown cleanup. Unit tests cover stale plans and editing during a
write; the PTY smoke drops and rewords commits through the actual helper bridge.

gitui doesn't have these yet; the engine already has most of them.

- Merge, rebase, cherry-pick, tag from the graph, with continue/skip/abort
  for operations in progress.
- Interactive rebase (gitui's other 1.0 roadmap item), using the
  existing `InteractiveRebase` plan types.
- Conflict resolution (`resolve_conflict`).
- Blame: new in `gitty-core`, so it's last.
- Submodules: not supported anywhere in Gitty today; decide separately.

## Order and size

Phases 1 and 2 are what make the TUI a real option for people choosing
between it and gitui; do them first and in that order. Phases 3 and 4 can be
worked on in parallel. Each phase is UI wiring plus tests; the only new
engine work is branch rename (phase 3) and blame (phase 5).

## Checks for every phase

- Real-Git fixture tests for each new write, including the review going stale
  (file, index or HEAD changed after review is refused).
- Ratatui test-backend snapshots for new views at 80 and 120+ columns.
- `scripts/test-tui.py` extended for each new key, and run on every
  platform that has writes turned on.
- Update the README key list, the [mutation
  safeguards](knowledge/git-mutation-safeguards.md) and
  [backend contract](../src-tauri/BACKEND.md) when a guarantee changes.
