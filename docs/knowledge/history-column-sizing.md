---
type: Concept
title: History column sizing
description: History column resizing, initial message fill, and graph alignment after reordering.
status: draft
sources:
  - id: graph
    resource: ../../src/components/HistoryGraph.tsx
  - id: smoke
    resource: ../../src/components/history-columns.smoke.mjs
---

# History column sizing

History headers expose resize buttons for pointer dragging and Left/Right
arrow keys. Column widths are local to the mounted history component; they
are not persisted preferences. Visibility and order are persisted separately.
The commit-message column initially fills spare viewport width. Its first
resize starts from its actual rendered width and switches it to a fixed-width
grid track, so shrinking and growing move the visible boundary immediately.
The header and commit rows share the grid template. When columns are reordered,
canvas positioning accounts for message fill only before manual resizing.
Message widths are bounded from 100px to the greater of 600px or the viewport
width.[^graph]

The Chromium demo smoke verifies pointer shrinking, keyboard growing, equal
header/row widths, and graph alignment after moving the message ahead of the
graph. Browser checks use synthetic history rather than native Git.[^smoke]

[^graph]: Resize handlers, message grid track, and graph offset calculation.
[^smoke]: Message resizing and history-column layout assertions.
