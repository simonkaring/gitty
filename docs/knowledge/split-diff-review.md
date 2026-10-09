---
type: UI Behavior
title: Split diff review
description: Paired before/after rows, fixed gutters, shared horizontal scrolling, and original line-selection identity.
status: draft
sources:
  - id: pairing
    resource: ../../src/model/splitDiff.ts
  - id: viewer
    resource: ../../src/components/WorkingChanges.tsx
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

`DiffPreview` renders equal Before / After columns with dedicated selection,
line-number, and change-sign gutters. One horizontal scrollbar shifts the code on
both sides, leaving columns and gutters fixed; trackpad horizontal scrolling and
Shift+wheel use the same offset without React state updates per scroll event.
Wrapping hides the horizontal scrollbar and lets each paired row grow to its
taller cell. A resize observer and preference observer recalculate overflow when
viewport size, wrapping, or editor font preferences change.[^viewer][^styles]

Line selection submits original zero-based diff indices, never paired row
indices. Busy/unavailable guards and fingerprint-scoped selection are shared
with unified mode; Git write semantics remain defined by the backend.[^viewer][^contract]

Tests cover paired replacement selection and exact original-index requests.
The focused Chromium fixture covers rendering, wrapping, both themes, narrow
layouts, shared scrolling, and mocked selection requests. It does not establish
native Git patch correctness.[^tests][^smoke]

[^pairing]: Presentation pairing and retained source indices.
[^viewer]: DiffPreview cells, selection, measurement, and scroll handlers.
[^styles]: Split content grid, gutters, and wrapping rules.
[^contract]: Hunk and selected-line write contracts.
[^tests]: Paired replacement selection regression.
[^smoke]: Real diff component with synthetic hunks and mocked writes.
