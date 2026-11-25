---
type: Concept
title: History column sizing
description: History column resizing, initial message fill, graph alignment after reordering, and narrow-pane layout.
status: draft
sources:
  - id: graph
    resource: ../../src/components/HistoryGraph.tsx
  - id: smoke
    resource: ../../src/components/history-columns.smoke.mjs
  - id: workspace
    resource: ../../src/components/NativeWorkspace.tsx
  - id: panes
    resource: ../../src/model/paneLayout.ts
  - id: styles
    resource: ../../src/styles.css
  - id: pane-tests
    resource: ../../src/model/paneLayout.test.ts
---

# History column sizing

History headers expose resize buttons for pointer dragging and Left/Right
arrow keys. Column widths are local to the mounted history component; they
are not persisted preferences. Visibility and order are persisted separately.
The commit-message column initially fills spare viewport width. Its first
resize starts from its actual rendered width and switches it to a fixed-width
grid track, so shrinking and growing move the visible boundary immediately.
The header and commit rows share the grid template. When columns are reordered,
canvas positioning (inside the scrolled content, at the graph column's offset) accounts for message fill only before manual resizing.
Showing the Graph column mounts and repaints its canvas without requiring a
commit selection change, even when the Branch / tag column is hidden.[^graph]
Message widths are bounded from 100px to the greater of 600px or the viewport
width. Until its handle is used, the Date column measures the widest rendered
date and grows (never shrinks, capped at 320px) so no date is ellipsized; a
manual resize ends the auto-fit.[^graph]

Narrow windows shrink the history pane instead of covering it: side panes stay
in the workspace flow rather than becoming overlays. At or below 1100px the
sidebar is capped to `min(var(--sidebar-width), 40vw)` and the inspector to
`min(var(--inspector-width), 42vw)`; at or below 800px the resizer is hidden and
the inspector keeps a border. The history pane scrolls horizontally, keeping the
Branch/tag and Graph columns at the visible left edge. At or below 1000px only
one side pane is open at a time: opening one closes the other, and resizing down
with both open closes the inspector. Persisted pane widths are unchanged; the
clamps and the single-pane rule are layout-only.[^workspace][^panes][^styles][^pane-tests]

The Chromium demo smoke verifies pointer shrinking, keyboard growing, equal
header/row widths, and graph alignment after moving the message ahead of the
graph. It checks that branch lines repaint when Graph is hidden and shown in
every built-in theme, without clicking a row. Browser checks use synthetic
history rather than the packaged desktop app or native Git.[^smoke]

[^graph]: Resize handlers, message grid track, graph offset, and canvas repaint effect.
[^smoke]: Message resizing, history-column layout, and canvas line pixel assertions.
[^workspace]: Narrow-pane state coordination in NativeWorkspace.
[^panes]: `setPaneOpen` and `settleSidePanes` narrow-window rules.
[^styles]: Responsive sidebar and inspector sizing.
[^pane-tests]: Unit regressions for narrow single-pane behavior.
