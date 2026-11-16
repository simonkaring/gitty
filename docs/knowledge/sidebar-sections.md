---
type: Concept
title: Sidebar sections
description: Colorized, reorderable and hideable repository sidebar sections and the shared options menu.
status: draft
sources:
  - id: sidebar
    resource: ../../src/components/NativeSidebar.tsx
  - id: menu
    resource: ../../src/components/OrderMenu.tsx
  - id: settings
    resource: ../../src/model/settings.tsx
  - id: styles
    resource: ../../src/styles/shell.css
  - id: tests
    resource: ../../src/components/NativeSidebar.ui.test.tsx
---

# Sidebar sections

The repository sidebar renders five sections: Worktrees, Local branches, Remote
branches, Tags and Remotes. The gear in the sidebar header opens an options menu
(the same `OrderMenu` the history columns use) to show/hide and move sections, or
reset them. Order and visibility persist as `sidebarSections` in settings; an
older stored object without the key backfills the default, and validation
requires every section exactly once. Unlike history columns, every section may be
hidden.[^sidebar][^menu][^settings]

Each section sets `--section` from a theme graph lane color (`data-section` on
its `<details>`): the icon tile, count pill, branch/folder icons, and the current
row's tint and left bar all derive from it, so custom themes recolor them. The
worktrees section is rendered by its own component but takes the same attribute.
Rows share one geometry: 8px horizontal padding, 8px icon gap, 28px minimum
height (two-line worktree rows add vertical padding), and the current-branch
check sits in the icon slot rather than outside it.[^styles]

Tests cover ordering, hiding, the menu callbacks and settings validation. Visual
spacing was checked in a Chromium demo only.[^tests]

[^sidebar]: Section nodes, ordering and the options button.
[^menu]: Shared show/hide and reorder popover.
[^settings]: Defaults, validation and migration of `sidebarSections`.
[^styles]: Section colors, tiles and row spacing.
[^tests]: Section order/hide and menu behavior.
