---
type: Architecture
title: Snapshot and refresh coherence
description: How repository snapshots, pinned history, and session-aware refresh fit together.
status: draft
sources:
  - id: snapshot
    resource: ../../src-tauri/src/operations.rs
  - id: history
    resource: ../../src-tauri/src/repository.rs
  - id: loader
    resource: ../../src/model/native.ts
  - id: pane
    resource: ../../src/components/RepositoryPane.tsx
  - id: tests
    resource: ../../src/model/native.integration.test.ts
  - id: contract
    resource: ../../src-tauri/BACKEND.md
  - id: pane-refresh
    resource: ../../src/components/RepositoryPane.tsx
  - id: working
    resource: ../../src/components/WorkingChanges.tsx
  - id: watcher
    resource: ../../src-tauri/src/watcher.rs
  - id: policy
    resource: ../../src/model/autoFetch.ts
---

# Snapshot and refresh coherence

`Repository::snapshot_with_history` shares state/status with operation-state construction,
checks HEAD/ref agreement, and rechecks the state fingerprint. It retries up to
three times before `unstable`. This is a best-effort read across external
changes, not a transactional filesystem snapshot. Its first read may consume the
server-owned opening state, still verified at the end.[^snapshot][^contract]
Operation preflight builds its reviewed fingerprint from the same request-local
state used for HEAD/ref validation. Index and all-ref fingerprint reads run
concurrently; neither is omitted, and post-write operation/HEAD reads remain.[^snapshot]

History generations pin concrete commit IDs and stream a walk with a replay
spool. A cursor belongs to that walk; its generation is opaque, not a state
fingerprint. In `readNativeSnapshot`, unchanged state reuses loaded history;
a changed state requests a walk from the snapshot's starting-state tips, covered by
the same final state check and returned in one IPC. Mixed
generations, nonadvancing cursors, and inconsistent ancestry are rejected before
publication.[^history][^loader]

Only one history generation per session retains a walker/spool. A new generation
explicitly expires older cursors with `staleCursor`; replay in the retained walk
never re-resolves current refs. This bounds paused native/SSH process retention,
without claiming a measured SSH MaxSessions failure.[^history]

Search is separate from history generations: a session runs one search at a time,
so a newer `repository_search` (or closing the session, or `repository_cancel_search`)
cancels the in-flight one with the silent `cancelled` code, and results are hydrated
by batched `cat-file --batch` rather than a process per result.[^history][^contract]
On WSL, the operation-metadata part of a snapshot uses one `find` existence scan
instead of one launch per file; the basic scan/snapshot path was exercised in
real Ubuntu temporary repositories, not through the packaged GUI.[^snapshot][^contract]

Automatic keep-visible IDs are filtered to the previous loaded history. After a
confirmed amend, the old HEAD can be remapped to the returned OID before paging,
only while that OID is the refreshed HEAD. Otherwise an unreachable old tip or
inspector-only orphan could cause a full-history scan. Session checks prevent
superseded asynchronous reads from publishing.[^loader][^tests]
Even a previously loaded tip can become unreachable after reset/rebase. Automatic
keep-visible stops at the deepest retained target's previous index plus 400 rows
(at least 400, backend cap 20,000), and stops earlier once targets are found. It no
longer reloads every previously loaded row on each ref change. Initial open/HEAD
movement seeks HEAD up to 2,000 rows; the cursor remains available for older history.
Selection/inspection survives, and explicit reveal remains separate.[^loader][^tests]
Initial open scrolls to HEAD. A read-only refresh follows a moved HEAD only when
the reader was still on the old HEAD and did not navigate during the read;
write completion retains its existing confirmed-outcome navigation guards.[^pane]
The pane defers its initial open to a cancellable microtask, so development
StrictMode's synchronous effect replay does not launch a discarded session.
Closing a pane still invalidates in-flight reads and closes late-opened handles.[^pane]

After a branch-deletion result, the pane removes deleted or unverified target OIDs from its
automatic selection/anchor keep-visible candidates before refreshing. Returned
history remains intact, and explicit reveal/paging behavior is unchanged.[^pane-refresh]

What triggers a routine refresh depends on the session. Native sessions call
`repository_watch` once a handle exists; while it reports active, the pane
refreshes on `repository_changed` for its handle, on focus, on activation, and
on a 60-second safety-net poll. Otherwise (WSL, a failed watcher) it polls every
five seconds; SSH every 30. Events only schedule `refresh()`, never bypass it:
an event arriving during a read or write retries after it, a hidden tab or
window keeps it pending, and bursts collapse into one read. The backend coalesces
(300 ms quiet, 2 s maximum) and drops only object-store, Git-directory lock,
access-only and Git-ignored working-path events. Gitty's own optional-lock-free
reads do not write the index, so they do not trigger events; a real-repository
test guards that.[^watcher][^policy]

`RepositoryPane` coordinates reads with write completion. File/index-only
mutations refresh status, falling back to full refresh if HEAD/ref moved;
commit/amend use full refresh. A failed post-write refresh blocks further
mutations until recovery. Following an amended selection also checks that the
user has not navigated since submission.[^pane]

The working-changes sidebar reserves a single-line progress/success region so
staging feedback does not displace its file list or composer. Staging and unstaging
finish without success text, including hunk and line actions. A diff for the same
repository, file, and side remains visible during a write and revision refresh;
its hunk actions stay blocked until the current revision's diff arrives. File or
side navigation never reuses the retained preview.[^working]

Large working-file groups render measured viewport windows and retain their
offsets when a refresh preserves path order; grouping and bulk-action candidates
are memoized per status-entry array. See [working changes at scale](working-changes-at-scale.md).

For changes, inspect `readNativeSnapshot`, `refreshStatus`, and `mutate`, plus
the scripted-IPC regressions in
[native.integration.test.ts](../../src/model/native.integration.test.ts).
Despite that filename, those tests mock IPC. Backend snapshot tests live in
[operation_tests.rs](../../src-tauri/src/operation_tests.rs); real history and
fingerprint tests live in [tests.rs](../../src-tauri/src/tests.rs).

Related: [mutation safeguards](git-mutation-safeguards.md),
[verification scope](demo-and-native-verification.md), and the detailed
[read semantics](../../src-tauri/BACKEND.md#read-semantics).

[^snapshot]: `Repository::snapshot` coherence loop.
[^history]: History generations and cursor ownership.
[^loader]: Snapshot loading, ancestry validation, and amend remapping.
[^pane]: Per-tab read/write coordination and navigation guards.
[^tests]: Scripted snapshot race and keep-visible regressions.
[^contract]: Read limitations and fingerprint coverage.
[^pane-refresh]: Deletion-specific exclusion passed to `readNativeSnapshot`.
[^watcher]: `Watchers::start`, event classification, the coalescing worker, and its
  real-repository tests (edit, ref change, bursts, ignored paths, own reads, close, linked worktree).
[^policy]: `routineRefreshInterval` and `createChangeRefresher`, with
  [autoFetch.test.ts](../../src/model/autoFetch.test.ts) and
  [RepositoryPane.watch.test.tsx](../../src/components/RepositoryPane.watch.test.tsx) (mocked IPC/events).
[^working]: [WorkingChanges](../../src/components/WorkingChanges.tsx) and the
  “stable staging updates” regressions in [WorkingChanges.test.ts](../../src/components/WorkingChanges.test.ts).
