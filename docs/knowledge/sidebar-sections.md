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

The repository sidebar renders six sections: Worktrees, Local branches, Remote
branches, Tags, Stashes and Remotes. The gear in the sidebar header opens an
options menu (the same `OrderMenu` the history columns use) to show/hide and move
sections, or reset them. Order and visibility persist as `sidebarSections` in
settings; an older stored object backfills a missing key from its default, and a
list saved before the Stashes section existed gains it once when read. Validation
requires every section exactly once. Unlike history columns, every section may be
hidden.[^sidebar][^menu][^settings]

The Stashes section lists the single `refs/stash` tip (labeled by its
`git stash list` message without the `On <branch>: ` prefix); its row's button
reveals the stash commit and its two icon buttons pop or drop it.[^stash]

Each section sets `--section` from a theme graph lane color (`data-section` on
its `<details>`): the icon tile, count pill, branch/folder icons, and the current
row's tint and left bar all derive from it, so custom themes recolor them. The
worktrees section is rendered by its own component but takes the same attribute.
Rows share one geometry: 8px horizontal padding, 8px icon gap, 28px minimum
height (two-line worktree rows add vertical padding), and the current-branch
check sits in the icon slot rather than outside it.[^styles]

Under the Apple design the list behaves like a macOS source list
(`src/styles/apple.css`). Rows have no hover fill; a clicked reference becomes the
selected row (accent fill, white content) only while its commit is still the
graph's `selectedId`. HEAD keeps a trailing check beside the branch's graph-colored
icon. Group headers show Finder-style "Hide"/"Show" on hover or focus in place of
the count. Up/Down move between visible rows and Right/Left expand or collapse the
focused group or folder; this handler is in `NativeSidebar` and runs in every
design.[^sidebar]

Tests cover ordering, hiding, the menu callbacks, settings validation and the
stash row's message label. Visual spacing was last checked in a Chromium demo;
the stash section's own spacing is unverified visually.[^tests]

[^sidebar]: Section nodes, ordering and the options button.
[^menu]: Shared show/hide and reorder popover.
[^settings]: Defaults, validation and migration of `sidebarSections`.
[^styles]: Section colors, tiles and row spacing.
[^tests]: Section order/hide and menu behavior.
[^stash]: `refs/stash` is listed by `repository_state` as kind `stash` so the same ref drives the section and the history row.
