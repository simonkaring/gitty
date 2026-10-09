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
new order and restores them with the active ID. Start tabs are omitted and demo
order is session-only. UI tests use jsdom pointer-capture stubs; they do not
establish native webview drag behavior.[^workspace][^model][^ui-tests]

[^strip]: RepositoryTabs pointer and keyboard handlers.
[^workspace]: NativeWorkspace keyed panes and persistence effect.
[^model]: tabsReducer, loadPersistedTabs, and savePersistedTabs.
[^model-tests]: Move safeguards and reordered persistence tests.
[^ui-tests]: Pointer gestures, selection, cancellation, and keyboard tests.
