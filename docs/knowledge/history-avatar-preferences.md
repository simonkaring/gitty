---
type: Concept
title: History avatar preferences
description: Persisted author avatar choices and optional avatar nodes in the history graph.
status: draft
sources:
  - id: settings
    resource: ../../src/model/settings.tsx
  - id: controls
    resource: ../../src/components/Settings.tsx
  - id: graph
    resource: ../../src/components/HistoryGraph.tsx
  - id: avatar
    resource: ../../src/components/AuthorAvatar.tsx
  - id: gravatar
    resource: ../../src/model/gravatar.ts
  - id: settings-tests
    resource: ../../src/model/settings.test.ts
  - id: graph-tests
    resource: ../../src/components/HistoryGraph.ui.test.tsx
  - id: browser-smoke
    resource: ../../src/components/graph-avatars.smoke.mjs
---

# History avatar preferences

Settings → Appearance persists `authorAvatarMode` (network-free initials by
default, or opt-in Gravatar) and the independent `graphAuthorAvatars` toggle
(off by default). Gravatar discloses the viewer's IP address and a SHA-256 hash
of each displayed author email to gravatar.com, so new settings default to initials.
A stored `gravatar` value is preserved, including values saved under the old
default; storage does not distinguish those from an explicit choice. An object that predates the
`authorAvatarMode` key never opted in and migrates to the `initials` default,
and a missing graph toggle migrates to off, without resetting other
preferences. Unknown keys are ignored on read and preserved through a save, so a
blob written by a newer build (one added preference) does not reset the rest. Demo and desktop workspaces use the same frontend settings
provider.[^settings][^controls]

When enabled, visible, laid-out commit rows render 22px `AuthorAvatar`
elements (the author-column size) centered on 30px-spaced graph lanes above
canvas connections. Dot mode uses 24px lane spacing and 40px rows (44px under the Apple design, 52px under Material). The graph column's
minimum width expands to fit three avatar lanes. Horizontal
graph panning shifts their positions; row virtualization limits rendered
avatars. Search-dimmed rows also dim their avatar nodes. Avatars are filled with
the branch color and ringed in the background color; the selected node grows 1.2x.
Merges use double borders and retain the message merge icon.
The working tree keeps its canvas square, now dashed and hollow. Pending layouts show rows without
inventing avatar positions.[^graph]

In both modes the canvas draws 2.5px opaque branch lines (the working tree hangs
off HEAD by a dotted line), a `graphHead` ring around the HEAD commit, and, when
the refs column sits directly before the graph, a connector from each ref pill to
its node (the pill's CSS line runs flush to the column edge and the canvas line continues from it, so they read as one). Dot mode draws solid dots (smaller for merges) with a 3px gap erased
from the canvas (and the working square is erased before its dashed outline), so
whatever row fill sits beneath shows through. The Apple design draws its hover and
selection fills under the canvas (`.history-hover`, `.history-selection`) and
repaints lines, the selected node and HEAD ring in white inside the selected row. Each message cell carries a branch-colored tick, replaced by the
`graphSelection` color on the selected row.[^graph]

The canvas is a buffered window (viewport plus 10 rows above and 20 below, snapped
to 10-row steps) positioned inside the scrolled content, so it moves natively with
the rows and only repaints when scrolling leaves the window. Hovering or focusing a
branch or tag in the sidebar passes `highlightRef` to the graph: commits owned by
that branch (per `assignBranchColors().owned`) stay lit, everything else dims, and
its lines draw on top. This overrides search dimming while it lasts.[^graph]

Graph avatars follow `authorAvatarMode` and reuse the initials fallback,
asynchronous stale-response protection, and image-failure behavior used by
author-column and commit-detail avatars.[^avatar] Failed or missing Gravatar
images (404) are remembered in a bounded in-memory cache for 10 minutes so
virtualized rows remounting while scrolling do not re-request them; an email
that fails hashing is retried only after the same interval.[^gravatar]

History rows are `role="option"` entries in a single-tab-stop listbox: ref
pills, the "+N" button, the pick checkbox and the "…" actions button are all
`tabIndex=-1` (still clickable, draggable and labelled). ArrowRight/ArrowLeft
move an active control through the selected row (wrapping through the row
itself), reflected in `aria-activedescendant` and a `.row-control-active` ring;
Enter/Space activates it, Shift+F10 on a highlighted pill opens its branch
menu, and Escape, vertical movement, or a selection change resets it. Branch menus
return focus to the listbox on Escape so arrow navigation resumes.[^graph][^graph-tests]

Focused model tests cover migration, validation, and persistence. Mocked DOM
and canvas tests cover mode switching, fallback, pending layouts, and graph
panning; these are not evidence of desktop image loading or visual rendering.
See [verification guidance](demo-and-native-verification.md).[^settings-tests][^graph-tests]

The focused Chromium smoke script exercises the Appearance controls, saved
toggle after reload, initials, mocked Gravatar image loading, compact vertical
alignment, scrolling, narrow layouts, and returning to dots. It uses synthetic
demo history and intercepted image responses. On macOS, `npm test` (301 tests),
`npm run build`, and this smoke script passed again on October 9, 2026 after
increasing avatars to 22px and lane spacing to 30px; the desktop-size
browser screenshot was inspected for node/connection alignment. Real Gravatar and
packaged desktop loading were not exercised.[^browser-smoke]

[^settings]: Settings defaults, validation, migration, and shared provider.
[^controls]: Appearance controls with immediate persistence.
[^graph]: Canvas connections and virtualized avatar node rendering.
[^avatar]: Shared initials and Gravatar rendering behavior.
[^gravatar]: Gravatar URL hashing and bounded success/failure caches.
[^settings-tests]: Graph avatar migration and persistence test.
[^graph-tests]: Graph-node mode, fallback, and panning test.
[^browser-smoke]: Synthetic-history browser verification with intercepted avatar images.
