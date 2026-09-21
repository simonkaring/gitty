# Milestone 2 — real repository exploration

## Scope

Implemented: native/recent repository opening, linked-worktree detection, real paged
history and refs, staged/unstaged/untracked/conflicted status, Git diffs in unified
and side-by-side presentations, arbitrary commit comparison, message/author/hash/ref
search, branch/date/path match filters, automatic polling/focus/manual refresh, and
a Windows/WSL transport and distribution-aware picker. The synthetic browser demo
remains available. All repository operations in this milestone are read-only.

Platform release validation remains open; implemented WSL code is not a claim of
tested Windows/WSL support.

## Data and process boundary

`src/model/repository.ts` defines the IPC contract. The workspace owns selection,
query state, and scroll anchors. Commit summaries, commit details, file lists, and
patches load independently. `Commit.branch` and eager mock contents remain only in
the demo/renderer adapter; the native model does not assign commits to one branch.

Rust resolves locations to opaque session handles. A short registry lock protects
session lookup; only history operations share a per-session walk lock. Slow search,
diff, and status commands do not hold a global repository lock. Blocking workers
run Git with argument arrays, bounded output, deadlines, and process cleanup.
Installed Git configuration is honored with targeted read-only overrides. See
[`src-tauri/BACKEND.md`](../src-tauri/BACKEND.md) for limits and unsupported cases.

Recent locations are persisted in app data, up to 20 entries. Repository data is not
persistently indexed. A temporary file stores visited walk IDs for cursor replay;
closing the session releases its walkers and spool files.

## History and graph correctness

Each generation captures concrete local/remote/tag tips and HEAD, then starts one
`rev-list --topo-order` walk. Pages consume up to 200 IDs with bounded read-ahead,
then retrieve commit objects through one `cat-file --batch` subprocess. Loading a
page does not re-resolve branch names. Raw commit objects retain original parents,
including shallow/unavailable parents. Existing layout invariants remain in force.

Search matches messages, authors/emails, reference labels, and full/prefix hashes.
Ref matches select pointed-to commits rather than claiming every ancestor belongs
exclusively to that branch. Branch/date/path conditions constrain matching commits;
the graph dims nonmatches and retains actual ancestry. It does not rewrite parent
edges or silently remove intermediary commits. Search caps results at 500 with an
explicit truncation notice. Boundary labels distinguish unfinished paging from
shallow/unavailable ancestry; boundary classification is currently repository/page
level rather than a separate reason per missing parent.

An immutable interval index finds viewport-crossing edges without scanning every
edge each frame. DOM rows and canvas remain viewport bounded. Prefix layout still
runs on the main thread, and revealing a distant result loads intervening pages.

## Working changes and comparisons

A square working-changes node is connected to HEAD, or parentless on an unborn
branch. Categories are separate comparisons: staged is HEAD → index, unstaged is
index → working tree, untracked is a new-file preview, and conflict preview compares
the working file with stage 2 (ours). Full conflict resolution is later work.

Commit inspection compares the selected parent → commit, defaulting to first
parent. Roots compare with the computed empty tree without writing an object.
Explicit comparisons show base → target and support swapping endpoints. Selecting
working changes takes precedence over a saved commit comparison.

Both diff presentations use the same structured Git hunks. Side-by-side mode leaves
the opposite cell blank for inserted/deleted lines; intraline highlighting and
replacement-line pairing are not implemented. Binary, mode-only, rename, and
truncated previews are labeled rather than represented as empty ordinary changes.

## Refresh and request lifetime

Refresh runs every five seconds while visible, on focus, or on request. There is no
filesystem watcher yet. State reads bracket history/status acquisition; inconsistent
HEAD/ref snapshots retry up to three times before retaining the previous snapshot
and showing an error. Status fingerprints include content changes, not only porcelain
status letters. Deepened shallow boundaries and remote changes invalidate history.

Selection uses object IDs; the viewport uses a commit ID and pixel offset. Refresh
loads additional pages to preserve these anchors when possible, and explicitly
retains an unreachable inspected commit instead of switching silently to HEAD.
External mutation is not transactional: individual diff reads can still observe
new working changes between requests. Polling reconciles subsequent updates.

Stale IPC results are ignored. Session close invalidates future lookups and releases
history resources once acquired requests finish. The UI does not yet expose physical
request cancellation; deadlines bound backend reads. WSL launcher termination does
not guarantee termination of every Linux descendant.

## WSL and platform validation

WSL distribution discovery and UTF-16 decoding happen on Windows. Directory browsing
runs Linux `find` inside the selected distribution. Git uses `wsl.exe --distribution
… --exec env … git -C …` rather than Windows Git over a UNC path. Locations and recent
entries carry the distribution name. Error/retry and periodic refresh support
reopening/reconnecting after failures, but stop/restart behavior needs real testing.

Before declaring the milestone release-ready:

- Exercise the packaged native picker, opening, real diffs, and terminal refresh on
  macOS, Windows, and Linux; verify keyboard navigation, high-DPI, and screen readers.
- On Windows/WSL, test distribution selection, paths with spaces/Unicode, symlinks,
  worktrees, missing Git, stop/restart, and process timeout/cleanup.
- Profile a real 100k+ merge-heavy repository, including search, many untracked files,
  large patches, distant jumps, and refresh after rewritten history.
- Validate native menus, release installers, signing/notarization, and supported Git
  versions (Git 2.37+ is required by timestamp-correct date search).

## Verification recorded locally

- 22 frontend tests: graph/diff invariants, status grouping, async snapshot races,
  pagination preservation, cancellation guards, bare repos, comparison modes.
- 30 Rust tests on macOS: real temporary Git repositories, 100,005-commit walk,
  search combinations, topology, worktrees, conflicts, batch framing, process bounds,
  cursor replay, configuration, concurrent reads, and index preservation.
- Production frontend build, Rust check and format checks passed.
- Mocked-IPC Chromium smoke passed. To repeat with an existing Playwright install:
  `PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node src/components/native.smoke.mjs`.
- `npm run desktop:build -- --debug --bundles app` produced a macOS `Gitty.app`.
  This is build verification, not an automated native GUI end-to-end test.
- Single-run macOS backend timing on the 100,005-commit fixture: first 200-commit page
  approximately 530 ms; next page 17 ms. These are observations, not performance guarantees.

## Following milestone

Staging (files, hunks, lines), commits/amend/signing, branch operations, fetch/pull/push,
stashes, and cloning. Mutations need separate command contracts and operation state;
reuse the environment-aware Git transport and read models. Recovery/conflicts,
advanced navigation/rebase/worktree management, and optional hosting integrations
follow the roadmap discussed for this release.
