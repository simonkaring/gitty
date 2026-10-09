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
  - id: settings-tests
    resource: ../../src/model/settings.test.ts
  - id: graph-tests
    resource: ../../src/components/HistoryGraph.ui.test.tsx
  - id: browser-smoke
    resource: ../../src/components/graph-avatars.smoke.mjs
---

# History avatar preferences

Settings → Appearance persists `authorAvatarMode` (Gravatar by default, or
network-free initials) and the independent `graphAuthorAvatars` toggle (off by
default). Older stored preferences missing the toggle migrate to off without
resetting other preferences. Demo and desktop workspaces use the same frontend
settings provider.[^settings][^controls]

When enabled, visible, laid-out commit rows render 22px `AuthorAvatar`
elements (the author-column size) centered on 30px-spaced graph lanes above
canvas connections. Dot mode retains 18px lane spacing. The graph column's
minimum width expands to fit three avatar lanes. Horizontal
graph panning shifts their positions; row virtualization limits rendered
avatars. Search-dimmed rows also dim their avatar nodes. Branch-colored borders
identify lanes; merges use double borders and retain the message merge icon.
The working tree keeps its canvas square. Pending layouts show rows without
inventing avatar positions.[^graph]

Graph avatars follow `authorAvatarMode` and reuse the initials fallback,
asynchronous stale-response protection, and image-failure behavior used by
author-column and commit-detail avatars.[^avatar]

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
[^settings-tests]: Graph avatar migration and persistence test.
[^graph-tests]: Graph-node mode, fallback, and panning test.
[^browser-smoke]: Synthetic-history browser verification with intercepted avatar images.
