---
type: UI Behavior
title: Split diff review
description: Paired before/after rows, fixed gutters, shared horizontal scrolling, virtualized rows, roving line focus, and original line-selection identity.
status: draft
sources:
  - id: pairing
    resource: ../../src/model/splitDiff.ts
  - id: viewer
    resource: ../../src/components/DiffPreview.tsx
  - id: styles
    resource: ../../src/styles.css
  - id: contract
    resource: ../../src-tauri/BACKEND.md
  - id: tests
    resource: ../../src/components/WorkingChanges.test.ts
  - id: smoke
    resource: ../../src/components/split-diff.smoke.mjs
---

# Split diff review

`splitDiffRows` pairs removed and added lines by position within each contiguous
change block. Context appears on both sides; excess changes get blank counterpart
cells. Metadata remains a full-width row and terminates a change block. Pairing is
presentation-only and retains each line's original hunk index.[^pairing]

`DiffPreview` (re-exported from `WorkingChanges.tsx`) renders equal Before /
After columns with dedicated selection, line-number, and change-sign gutters.
One horizontal scrollbar shifts the code on both sides, leaving columns and
gutters fixed; trackpad horizontal scrolling and Shift+wheel use the same
offset without React state updates per scroll event. Wrapping hides the
horizontal scrollbar and lets each paired row grow to its taller cell. Resize
and preference observers recalculate overflow when viewport size, wrapping, or
editor font preferences change.[^viewer][^styles]

`diffRows` flattens hunks into one list of header and line (or paired) rows.
Above `DIFF_VIRTUALIZE_ABOVE` rows, the `.native-diff` scroller renders only the
viewport plus overscan between two spacers; hunk headers are ordinary rows, so
their actions appear when scrolled to. Offsets are prefix sums of measured
heights for rendered rows and per-class measured averages (or fixed estimates)
for the rest, so wrapped rows get variable heights; height changes keep the
first visible row anchored. Wrapping, font, or wrapped-width changes discard
measurements. Horizontal overflow is measured only on rendered rows, coalesced
per frame, and keeps the widest overflow seen until the diff or preferences
change.[^pairing][^viewer]

Line toggles are `tabIndex=-1`. The diff surface is one tab stop
(`role="group"`) exposing an active line via `aria-activedescendant`:
ArrowUp/Down/Home/End move it and scroll it into view, ArrowLeft/Right pick the
split side, and Space/Enter on the surface toggle the active changed line
through the same handler as the buttons.[^viewer]

Line selection submits original zero-based diff indices, never paired row
indices. Busy/unavailable guards and fingerprint-scoped selection are shared
with unified mode; Git write semantics remain defined by the backend.[^viewer][^contract]

Tests cover paired replacement selection, exact original-index requests from
deep virtualized rows in both layouts, bounded row counts and spacer totals,
roving keyboard selection, and the shared scroll offset; jsdom has no layout,
so these use stubbed scroll metrics and estimated heights. The focused
Chromium fixture covers rendering, wrapping, both themes, narrow layouts,
shared scrolling, mocked selection requests, and a 20,000-line diff in both
layouts (bounded DOM, wrap anchoring, keyboard reveal). It does not establish
native Git patch correctness.[^tests][^smoke]

[^pairing]: Presentation pairing, flattened rows, and window math, with retained source indices.
[^viewer]: DiffPreview rows, virtual window, selection, roving focus, measurement, and scroll handlers.
[^styles]: Split content grid, gutters, and wrapping rules.
[^contract]: Hunk and selected-line write contracts.
[^tests]: Paired replacement selection and `virtualized diff rows` regressions; `splitDiff.test.ts` covers row flattening and window math.
[^smoke]: Real diff component with synthetic hunks, a `?large` virtualized fixture, and mocked writes.
