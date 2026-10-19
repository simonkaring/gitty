---
type: Concept
title: History column sizing
description: History column resizing, initial message fill, graph alignment after reordering, and responsive pane stacking.
status: draft
sources:
  - id: graph
    resource: ../../src/components/HistoryGraph.tsx
  - id: smoke
    resource: ../../src/components/history-columns.smoke.mjs
  - id: styles
    resource: ../../src/styles.css
  - id: responsive_smoke
    resource: ../../src/components/responsive-layout.smoke.mjs
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

## Responsive pane layout

The sidebar and inspector stay in normal flow at intermediate zoom-adjusted
widths. The sidebar width is clamped against the zoom-adjusted window so that,
even with the narrowest inspector, at least 300px remains for history; the
inspector fits the window minus the sidebar and a 320px history reserve. Below
an 820px effective width (a container query, so interface zoom reduces the
usable width it measures) the open panes stack in DOM order — sidebar,
filters/history, inspector — and the pane resizers are hidden.

Stacked panes keep their own usable size instead of being squeezed: the sidebar
never takes more than 40% of the visible workspace height and scrolls itself,
each history/diff pane keeps a fixed 240px CSS box with its own scroll area, and
the stacked inspector gets a definite bounded height — at least 320px CSS, at
most 460px or 70vh of the zoom-adjusted viewport — so its internal scrollers
resolve against it. Those px floors stay in CSS space (only the viewport-relative
cap follows interface zoom), so the CSS-sized composer controls always fit: the
commit composer keeps at least 140px CSS and its Summary field and body stay
visible and scrollable at 200% zoom. The workspace is the single scroller: when
the stacked panes are taller than the window, the outer workspace scrolls to
reveal the rest, and history is never turned into a nested inner scroller. At
short heights the visible part of history is therefore as tall as the 40%
sidebar cap allows, and the inspector is reached by scrolling the workspace.
Graph and ref columns stay inside the history pane, and saved pane widths are
reapplied when the window widens again.[^styles][^responsive_smoke]

[^graph]: Resize handlers, message grid track, and graph offset calculation.
[^smoke]: Message resizing and history-column layout assertions.
[^styles]: Sidebar width clamp, inspector fit, and the stacked container query.
[^responsive_smoke]: Browser assertions for nonoverlapping panes, visible history, reachable graph/ref labels, outer-workspace scrolling at full and short heights, a clickable Summary field and scrollable composer at 100% and 200% zoom, and pane toggling.
