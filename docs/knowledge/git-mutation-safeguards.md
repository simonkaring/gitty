---
type: Engineering Invariant
title: Git mutation safeguards
description: Explicit write scope, stale-review checks, and reconciliation after uncertain outcomes.
status: draft
sources:
  - id: contract
    resource: ../../src-tauri/BACKEND.md
  - id: locking
    resource: ../../src-tauri/src/repository.rs
  - id: writes
    resource: ../../src-tauri/src/mutate.rs
  - id: workflow
    resource: ../../src/model/workflow.ts
  - id: hunk-tests
    resource: ../../src-tauri/src/hunk_tests.rs
  - id: workflow-tests
    resource: ../../src/model/workflow.test.ts
  - id: branch-delete
    resource: ../../src-tauri/src/branch_delete.rs
  - id: branch-delete-ui
    resource: ../../src/model/branchDelete.ts
  - id: operations
    resource: ../../src-tauri/src/operations.rs
  - id: operation-tests
    resource: ../../src-tauri/src/operation_tests.rs
  - id: operation-dialog
    resource: ../../src/components/OperationDialog.tsx
  - id: stashes
    resource: ../../src-tauri/src/stash.rs
  - id: stash-dialog
    resource: ../../src/components/RemoteStashDialog.tsx
  - id: origin-reset-dialog
    resource: ../../src/components/OriginResetDialog.tsx
  - id: graph-drops
    resource: ../../src/components/HistoryGraph.tsx
  - id: graph-drop-tests
    resource: ../../src/components/HistoryGraph.ui.test.tsx
  - id: remote-writes
    resource: ../../src-tauri/src/remote.rs
  - id: remote-dto
    resource: ../../src-tauri/src/remote_dto.rs
  - id: remote-tests
    resource: ../../src-tauri/src/remote_tests.rs
  - id: remote-model
    resource: ../../src/model/remote.ts
  - id: branch-menu
    resource: ../../src/components/GraphContextMenu.tsx
  - id: merge-menu-tests
    resource: ../../src/components/GraphContextMenu.merge.test.tsx
  - id: operation-ui
    resource: ../../src/model/operationUi.ts
  - id: operation-smoke
    resource: ../../src/components/operations.smoke.mjs
  - id: branch-push-tests
    resource: ../../src/components/RepositoryPane.push.test.tsx
---

# Git mutation safeguards

File staging/unstaging takes explicit, validated, literal paths; an empty list
never means all changes. New commits consume the index, not unstaged content.
Ordinary writes reject unsupported operation/conflict states and respect Git's
locks, hooks, and signing. The common-directory mutation lock serializes Gitty
sessions, including linked worktrees; it cannot serialize external Git.[^writes][^locking]

Freshness checks depend on the action: amend checks HEAD/ref/status, discard
checks reviewed status, hunk/line staging checks the displayed diff, and graph
actions/conflict resolution check their own expectations. Do not turn UI
eligibility into write authority or assume every write has the same preflight.
See the [write contract](../../src-tauri/BACKEND.md#write-semantics) and
[graph/conflict contract](../../src-tauri/BACKEND.md#operation-safety-and-semantics)
for exact requirements.[^contract]

Preserve working files and unrelated index entries when staging/unstaging hunks.
Discard deliberately destroys selected unstaged content; tracked files restore
from the index. Message-only amend preserves the old tree; ordinary amend folds
in staged content. Remote-tracking refs are local evidence, not proof of the
remote's current state.[^contract][^hunk-tests]

Branch drops in the graph/sidebar capture the dragged ref as merge source and
the receiving local branch as explicit destination. Local and remote-tracking
branch sources share this flow; full `refs/remotes/<remote>/<branch>` refs keep
same-named remotes distinct. Review precedes execution; the backend switches to
the destination if needed and never moves the source ref. Self-drops, tag/remote
destinations and mixed payloads are rejected; commit drops remain cherry-picks
onto the current local branch only. A checked-out branch is required.[^graph-drops][^graph-drop-tests][^operations]

Branch context actions (including right-click and Shift+F10) merge a local or
remote-tracking source into the current local branch. They never offer a remote
destination, and review rejects non-local destination refs. The same captured
operation request, freshness checks and merge-message/stash handling apply as
for local-source menus.[^branch-menu][^merge-menu-tests][^operation-ui]

Relation reads ignore responses for a superseded menu target. Focused Chromium
coverage (`GITTY_REMOTE_MERGE_SMOKE=1` with the operations smoke script) exercises
actual graph/sidebar remote drag starts, local destinations and right-click /
Shift+F10 review entry; its IPC is mocked, not native Git. Real-Git regressions
cover full-ref disambiguation, changed remote-tip review refusal and invalid
destinations before stashing.[^merge-menu-tests][^operation-smoke][^operation-tests]

Branch-menu push reuses the ordinary single-branch, no-force remote write. A
non-current local branch is eligible only after an offline per-branch read shows
its same-name `origin/<branch>` upstream and commits ahead; the request pins that
branch as both source and destination, while the backend re-resolves the named
source and reads its upstream configuration instead of the checked-out branch's.
Explicit per-branch metadata reads reject missing or invalid local branches.
The checked-out branch keeps the existing push/publish flow. Local ahead metadata
is a review signal, not proof of the remote's current state.[^remote-writes][^remote-dto][^remote-model][^branch-menu][^branch-push-tests][^remote-tests]

Merge review includes a dedicated editable commit message and defaults to
`--no-ff`, creating a merge commit even when fast-forward is possible. Users can
explicitly allow fast-forward by unchecking the option. Supplied messages are
validated before switching destinations and sent through a native temporary file
or WSL stdin rather than message-sized command arguments; fast-forward
merges create no commit. Git retains the chosen message for conflict continuation
and session restart. Omitted messages preserve Git's default, and hooks, cleanup,
and signing still apply.[^operations][^operation-tests][^operation-dialog]

An explicit merge `stashChanges` option saves staged, unstaged and untracked work
before merging, then restores its index with the pinned stash OID after a clean
merge. Failed or conflicted merges retain a uniquely labeled recovery stash;
Continue/Abort leave it for manual recovery once the operation finishes. Failed
restoration does not drop it or retry the merge. The stash dialog defaults to
restoring staging and offers a worktree-only opt-out. Ignored files remain subject
to the existing obstruction checks.[^operations][^operation-tests][^stashes][^stash-dialog]

Attempt a mutation once. An error can follow a partial or completed write;
`mutationUnverified` requires refresh and review, not automatic retry.[^contract]
`writeAndRefresh` distinguishes write and refresh errors and reconciles both
success and failure while the session is current. A superseded session must not
publish into its replacement.[^workflow][^workflow-tests]

Branch deletion is a dedicated locked mutation with exact reviewed target OIDs
and, for origin, the effective push URL. It uses safe local `-d` first; a
separate `-D` request is enabled only after a failed safe delete, unchanged target,
unmerged upstream/HEAD ancestry, and clear lock/worktree checks.
Origin deletion uses one same-name refspec and an expected-OID lease. Local
failure/uncertainty prevents the remote attempt; partial target outcomes remain
structured for the UI. Deletion refresh excludes removed target tips from
automatic keep-visible paging while leaving explicit navigation unchanged.[^branch-delete][^branch-delete-ui]

Origin reset is an explicitly confirmed destructive graph action for the
checked-out same-named local branch. Review shows the fetched tip, local-only
commit count and tracked change count. Execution pins HEAD/ref, operation/content
fingerprint and origin OID; it discards staged/unstaged tracked work, while
untracked/ignored target obstructions are refused before `reset --hard`. It does
not fetch or push, and failures require refresh and an explicit new review rather
than retry. See `operations_reset_origin_*` real-Git regressions and the dialog
tests for source-backed entry points.[^operations][^operation-tests][^origin-reset-dialog]

When changing this area, inspect `Service::mutate`, the action's Rust preflight,
and `writeAndRefresh`. Existing regression entry points include
`stage_and_commit_only_selected_hunk_preserves_worktree_and_other_staged_edits`
and the workflow test “always refreshes after a failed write, without retrying
an ambiguous commit.” These are source pointers, not a report of a test run.

Related: [refresh coherence](snapshot-and-refresh-coherence.md) and
[verification scope](demo-and-native-verification.md).

[Worktree management](worktree-management.md) adds reviewed create/move/remove,
lock/unlock, and prune. Move/remove refuse open targets and require explicit
unlocking; forced removal has separate data-loss acknowledgement. Session
publication shares the mutation lock, and queued writes recheck handle validity.

[^contract]: Detailed backend semantics.
[^locking]: `Service::mutation_lock` and `Service::mutate`.
[^writes]: Ordinary mutation validation and outcome handling.
[^workflow]: Frontend single-attempt write lifecycle.
[^hunk-tests]: Real-repository hunk preservation regressions.
[^workflow-tests]: Mocked write/refresh lifecycle regressions.
[^branch-delete]: Dedicated branch deletion preflight and remote/local outcomes.
[^branch-delete-ui]: Branch target resolution and confirmation request construction.
[^operations]: Merge message validation, bounded delivery and Git-based continuation.
[^operation-tests]: Custom merge message, fast-forward, conflict restart and invalid-input regressions.
[^operation-dialog]: Editable merge message and captured review display.
[^stashes]: Unique merge-work stash identity, index restoration and OID-pinned apply/drop.
[^stash-dialog]: Explicit staging restoration choice for manual recovery.
[^origin-reset-dialog]: Captured origin reset review, destructive confirmation and no automatic retry.
[^graph-drops]: Shared graph/sidebar drop eligibility and source/destination construction.
[^graph-drop-tests]: Branch direction, destination eligibility and current-target cherry-pick regressions.
[^remote-writes]: Explicit push source/destination resolution and existing no-force preflight.
[^remote-dto]: Push source contract and optional per-branch sync metadata.
[^remote-model]: Branch push eligibility helper and pinned request shape.
[^branch-menu]: Branch-menu push and local/remote merge entry construction.
[^merge-menu-tests]: Remote-tracking source merge and non-local destination regressions.
[^operation-ui]: Reviewed merge source/destination eligibility, including local-only destinations.
[^operation-smoke]: Focused real-browser remote-source drag and context-menu review checks with mocked IPC.
[^branch-push-tests]: Non-current branch payload and menu eligibility regressions.
[^remote-tests]: Real-Git source push and per-branch sync metadata regressions.
