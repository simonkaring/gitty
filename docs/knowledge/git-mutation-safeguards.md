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

When changing this area, inspect `Service::mutate`, the action's Rust preflight,
and `writeAndRefresh`. Existing regression entry points include
`stage_and_commit_only_selected_hunk_preserves_worktree_and_other_staged_edits`
and the workflow test “always refreshes after a failed write, without retrying
an ambiguous commit.” These are source pointers, not a report of a test run.

Related: [refresh coherence](snapshot-and-refresh-coherence.md) and
[verification scope](demo-and-native-verification.md).

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
