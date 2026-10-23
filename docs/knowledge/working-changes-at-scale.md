---
type: Architecture
title: Working changes at scale
description: Memoized working-file data, measured viewport-only rows, and targeted native patch reads.
status: draft
sources:
  - id: working
    resource: ../../src/components/WorkingChanges.tsx
  - id: window
    resource: ../../src/components/WorkingFileWindow.tsx
  - id: diff
    resource: ../../src-tauri/src/diff.rs
  - id: status
    resource: ../../src-tauri/src/repository.rs
  - id: ui-tests
    resource: ../../src/components/WorkingChanges.test.ts
  - id: native-tests
    resource: ../../src-tauri/src/tests.rs
  - id: smoke
    resource: ../../src/components/working-files.smoke.mjs
  - id: contract
    resource: ../../src-tauri/BACKEND.md
---

# Working changes at scale

`WorkingChanges` derives groups, sorted unstaged/untracked rows, path sets, and
bulk-action candidates once per status-entry array. Selection and partially
staged badges use set membership rather than scans per rendered row. Bulk
actions still address the full candidate list, independent of the viewport;
native mutation limits remain defined by the backend contract.[^working][^contract]

Groups above `WORKING_FILES_VIRTUALIZE_ABOVE` use `WorkingFileWindow` inside the
sidebar's shared scroller. Prefix sums of measured variable row heights and a
measured average (initially a fixed estimate) locate a viewport plus overscan.
Spacers retain offscreen space; wrapped paths and secondary labels keep their
natural heights. Measurements anchor the first visible file; resizing discards
old widths' measurements. Width and row-height changes below
`WORKING_FILE_MEASURE_TOLERANCE` are ignored, as the diff viewer already does:
sub-pixel geometry from interface zoom, fractional fonts, and scrollbar rounding
is not a real measurement, and acting on it re-lays out on every pass and can
flip the rendered window between two ranges until React aborts with an
update-depth error. The scroll anchor also skips corrections below the tolerance,
so a fractional `scrollTop` write cannot re-trigger the pass it came from.
Tolerance cannot settle geometry that genuinely oscillates (a row whose height
depends on what is mounted, a scrollbar that toggles with it), so a layout
generation admits only `WORKING_FILE_CORRECTION_BUDGET` corrections; scrolling,
an external resize, folding, or a status refresh starts a new one. An unchanged
path order retains offsets across status refreshes. Folding a large group mounts no file rows while counts, selection,
and the preview remain; small groups retain their hidden rows.[^window][^working]

Large groups give the focused row's selection and action buttons tab stops;
otherwise the first rendered row is the entry point. ArrowUp/Down and Home/End
reveal and focus file-selection buttons without activating them. Enter/Space
retain native button activation. A focused row stays mounted outside the scroll
window until focus leaves; context menus retain their existing handlers.[^window]

For staged, unstaged, and conflict previews, `working_diff_file` validates the
selected path using raw diff metadata without repository-wide numstat. Ordinary
modifications use a path-scoped, no-rename raw read. Adds/deletes fall back to
whole-diff raw rename pairing so a destination-only pathspec does not erase the
rename source; Git may still read other rename candidates. Only the requested
patch is generated. Untracked/conflict validation scopes porcelain to the
requested literal path. Complete status refreshes and write checks remain
repository-wide. Index-before/index-after checks and byte-based hunk tokens are
unchanged; previews are not cached across revisions.[^diff][^status][^contract]

Full status retains content-aware fingerprints, not stat-only shortcuts. SSH
tracked binary patches are digested where the files live; only a bounded Git blob
digest crosses the channel, and an independently checked producer status rejects
partial reads. Local/WSL patch hashing and existing untracked hashing are unchanged.[^status][^contract]

The UI regressions use 10,000 entries with stubbed geometry and include two
windows that must settle instead of re-laying out: sub-pixel noise, which the
tolerance absorbs, and a material oscillation, which only the correction budget
can stop. The browser fixture uses real wrapped-row layout, deep selection,
simulated writes, keyboard/focus, folding, narrow resizing, and unchanged-status
refresh anchoring, and runs in Chromium or WebKit (`SMOKE_BROWSER=webkit`). The native
regression uses 2,000 partially staged files in a real temporary repository and
checks both sides, unrelated index preservation, rename metadata, and membership
errors. Browser timings are synthetic-IPC observations, not native desktop
benchmarks; Windows/WSL runtime behavior needs target-platform checks.[^ui-tests][^smoke][^native-tests]

Related: [snapshot coherence](snapshot-and-refresh-coherence.md),
[diff review](split-diff-review.md), and [verification scope](demo-and-native-verification.md).

[^working]: Memoized file model and full-list action candidates.
[^window]: Measured group windows, scroll anchoring, focus retention, and keyboard reveal.
[^diff]: `working_diff_file`, `diff_snapshot`, and `untracked_patch`.
[^status]: `status_entries_at` preserves complete status reads through `status_entries`.
[^ui-tests]: `large working file lists` regressions.
[^native-tests]: `working_file_previews_with_thousands_of_unrelated_changes` and rename/binary/conflict fixtures.
[^smoke]: Real Chromium layout with synthetic repository data and simulated IPC.
[^contract]: Native read semantics, hunk safeguards, and mutation path limits.
