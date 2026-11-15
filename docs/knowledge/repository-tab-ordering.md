---
type: UI Behavior
title: Repository tab ordering
description: Drag and keyboard tab reordering, active identity, and persisted repository order.
status: draft
sources:
  - id: strip
    resource: ../../src/components/RepositoryTabs.tsx
  - id: workspace
    resource: ../../src/components/NativeWorkspace.tsx
  - id: model
    resource: ../../src/model/tabs.ts
  - id: model-tests
    resource: ../../src/model/tabs.test.ts
  - id: ui-tests
    resource: ../../src/components/RepositoryTabs.ui.test.tsx
  - id: lazy-tests
    resource: ../../src/components/NativeWorkspace.lazyTabs.test.tsx
---

# Repository tab ordering

Dragging a tab label past another tab's midpoint reorders the strip in place.
A five-pixel threshold separates a drag from an ordinary click. Pointer capture
starts on the label to preserve clicks, then transfers to the stable strip
before reordering; release, cancellation, and lost strip capture clear drag
styling. Close buttons remain separate. Alt+Left/Right
moves the focused tab one position without wrapping; ordinary arrows and
Home/End retain tab navigation behavior.[^strip][^ui-tests]

The reducer's `move` action preserves tab records, active identity, and notices;
busy and start tabs can move. Missing source/destination IDs are no-ops, allowing
for tabs closing or deduplicating during a gesture. Keyed panes retain their
state while their order changes.[^model][^workspace][^model-tests]

The existing workspace persistence effect saves repository locations in their
new order and restores them with the active ID. Restoration drops a record whose id
was already restored (every tab action addresses tabs by id, so a duplicate would
close or update both) and keeps at most 32 records, matching the backend's
open-session cap, so a corrupted or oversized stored list cannot fill the strip. Start tabs are omitted and demo
order is session-only. UI tests use jsdom pointer-capture stubs; they do not
establish native webview drag behavior.[^workspace][^model][^ui-tests]

Restored tabs mount lazily. `NativeWorkspace` records each tab id once it has
been active in this app run (derived during render, so a pane mounts already
active) and renders a `RepositoryPane` only for recorded tabs; a recorded pane
then stays mounted, keeping its state and refreshing on re-activation. An
unloaded tab still renders its `tabpanel` shell (empty and hidden) and a tab
labelled from `locationLabel`, and can be selected, reordered, closed and
persisted without opening a session, so startup opens one session instead of
one per saved tab and StrictMode replays cannot open inactive ones. Branch and
dirty badges are empty until the first activation. Reopening an unloaded tab's
location dedupes by raw location and focuses it (which then mounts it). Session
identity dedupe (`sessionKey`) only knows loaded tabs, so two different paths
to one worktree are merged when the second tab first loads, not at open
time.[^workspace][^lazy-tests]

Secondary views (operation, conflict, pull-request, stash, branch-delete,
origin-reset, activity-log, command-palette, settings dialogs, and the
account repository browser) are code-split in `lazyDialogs.tsx` and preloaded
after two idle seconds; the entry chunk shrank from 582 kB to 276 kB, with
React in a separate vendor chunk.[^workspace]

[^strip]: RepositoryTabs pointer and keyboard handlers.
[^workspace]: NativeWorkspace keyed panes and persistence effect.
[^model]: tabsReducer, loadPersistedTabs, and savePersistedTabs.
[^model-tests]: Move safeguards and reordered persistence tests.
[^ui-tests]: Pointer gestures, selection, cancellation, and keyboard tests.
[^lazy-tests]: jsdom tests with a probe pane: inactive restored tabs open nothing (also under StrictMode), first selection mounts once and stays mounted, keyboard reorder/close/select and reopen-focus on unloaded tabs.
