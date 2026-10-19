---
type: UI Behavior
title: Stash workflow
description: Immediate save, selected-stash pop, graph/sidebar entries, and recoverable message edits.
status: draft
sources:
  - id: pane
    resource: ../../src/components/RepositoryPane.tsx
  - id: toolbar
    resource: ../../src/components/RepositoryToolbar.tsx
  - id: graph
    resource: ../../src/components/HistoryGraph.tsx
  - id: sidebar
    resource: ../../src/components/NativeSidebar.tsx
  - id: menu
    resource: ../../src/components/StashContextMenu.tsx
  - id: editor
    resource: ../../src/components/StashMessageDialog.tsx
  - id: native
    resource: ../../src-tauri/src/stash.rs
  - id: native-tests
    resource: ../../src-tauri/src/operation_tests.rs
  - id: menu-tests
    resource: ../../src/components/StashContextMenu.test.tsx
  - id: editor-tests
    resource: ../../src/components/StashMessageDialog.test.tsx
  - id: refresh-tests
    resource: ../../src/components/RepositoryPane.search.test.tsx
---

# Stash workflow

**Stash** immediately saves staged, unstaged, and untracked changes with Git's
default WIP message; ignored files remain. **Pop** targets the selected stash,
restores its index state, and requires no staged, unstaged, or untracked changes.
The command palette retains **Manage stashes…** for the full save/apply/pop/drop
dialog and its staging-restoration opt-out.[^pane][^toolbar]

Local stash reads refresh with repository revisions and every successful full
refresh, even when history/status fingerprints are unchanged. Polling, focus,
manual refresh, and tab activation therefore discover stash-only changes from
other terminals or linked worktrees without rewalking history.[^pane][^refresh-tests]
Entries appear newest-first
in the sidebar and as archive-node graph rows between working changes and history,
connected only to their first parent (base). Graph rows deduplicate OIDs, preferring
an existing history row or the newest stash entry. Stash rows stay outside search
results, commit actions, cherry-pick selection, and commit dragging.[^pane][^graph][^sidebar]

Right-click or **Shift+F10** opens the shared stash menu: Pop, two-step Delete /
Confirm delete, and Edit stash message. The editor trims nonempty input and keeps
the draft open on failure.[^menu][^editor][^menu-tests][^editor-tests]

Mutations resolve full OIDs against the current reflog under the shared write lock;
missing or duplicate OIDs are refused. Pop applies the pinned object, then
re-resolves its selector before dropping it, and never drops after conflicts.
Message edits first pin the object under `refs/gitty/stash-recovery/<token>`, then
drop and re-store it with a new reflog message, moving
it to `stash@{0}` without rewriting saved content. Identical messages are a no-op.
On store failure, Gitty attempts restoration with the original message; if that
also fails, the recovery ref still protects the saved content from garbage
collection. Errors retain that ref and include restore/cleanup commands; success
removes it with an expected-OID check. After an interrupted process, discover
backups with `git for-each-ref refs/gitty/stash-recovery/` and inspect Stashes
before restoring to avoid duplicate entries.
This is not an atomic reflog rewrite against external Git writers.[^native]

Regression pointers (not a test-run report):
`stash_edit_message_re_stores_the_same_object_under_the_new_message` checks object
identity and ordering in real Git; `stash_edit_message_protects_work_during_pruning_and_failed_recovery`
exercises pruning in the drop/store gap and failed store/restoration on Unix.
Menu/editor tests cover confirmation and failed
saves. See the [backend contract](../../src-tauri/BACKEND.md#stashes) and
[mutation safeguards](git-mutation-safeguards.md).[^native-tests][^menu-tests][^editor-tests]

[^pane]: `stashNow`, `popStash`, `stashRows`, and palette commands.
[^toolbar]: Immediate save and selected-stash/clean-worktree eligibility.
[^graph]: Archive nodes and stash-specific action routing.
[^sidebar]: Stash selection and keyboard/context-menu entry points.
[^menu]: Shared actions and two-step deletion.
[^editor]: Message editing and failure handling.
[^native]: Stable identity, apply/drop, validation, and recovery semantics.
[^native-tests]: Real-repository message-edit regression.
[^menu-tests]: Pop eligibility and deletion confirmation regression.
[^editor-tests]: Trimmed submission and retained dialog on failure.
[^refresh-tests]: Stash-only manual/focus/tab refresh with unchanged history and status.
