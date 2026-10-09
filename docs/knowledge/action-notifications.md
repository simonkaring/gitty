---
type: UI Behavior
title: Action notifications
description: Readable remote and stash success summaries in the window's bottom-left toast region.
status: draft
sources:
  - id: summaries
    resource: ../../src/model/remote.ts
  - id: tests
    resource: ../../src/model/remote.test.ts
  - id: pane
    resource: ../../src/components/RepositoryPane.tsx
  - id: toolbar
    resource: ../../src/components/RepositoryToolbar.tsx
  - id: stash
    resource: ../../src/components/RemoteStashDialog.tsx
  - id: ui
    resource: ../../src/components/ui.tsx
  - id: styles
    resource: ../../src/styles.css
---

# Action notifications

Remote and stash success notices summarize the requested action instead of
displaying Git's terminal report. Explicit branch/remote names provide context;
configured pushes can use the initiating branch name without guessing a remote
from the upstream display label. Known English no-op reports distinguish nothing
to push/pull/stash; other successful output uses the action summary. Publishing
still reports success when only upstream configuration changes.[^summaries][^tests]

Toolbar, branch-menu, publish, and stash paths use these summaries after their
write/refresh lifecycle succeeds. Write or refresh failures continue through the
existing error path rather than a success notice.[^pane][^toolbar][^stash]

The shared notification region floats at the bottom-left of the window. Callers
own transient notice timers; error toasts remain dismissible.[^ui][^styles]

[^summaries]: `remoteSuccessMessage` and `stashSuccessMessage`.
[^tests]: Success notification regression cases using Git report fixtures.
[^pane]: Branch-menu/publish notifications and remote write lifecycle.
[^toolbar]: Toolbar and publish notifications.
[^stash]: Stash notification caller.
[^ui]: Shared toast portal and dismissal semantics.
[^styles]: `.toast-region` positioning and responsive width.
