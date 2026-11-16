---
type: Reference
title: Design family icons
description: How every in-app icon switches between Lucide and animated Material-style glyphs for the Material Google design family.
status: draft
sources:
  - id: registry
    resource: ../../src/components/icons.tsx
  - id: styles
    resource: ../../src/styles/material.css
  - id: settings
    resource: ../../src/model/settings.tsx
  - id: themes
    resource: ../../src/model/themes.ts
---

# Design family icons

## Registry

All in-app icons are imported from `src/components/icons.tsx` as `Icons.<LucideName>`.
The registry keeps the Lucide component under its original name, so call sites keep
the same props (`size`, `className`, `strokeWidth`, `data-*`, `aria-label`) and can
pass `animated` to force the Material glyph in any design.
`src/components/icons.tsx` is the only module that imports `lucide-react`. The brand
mark (`AppMark.tsx`) and decorative SVG art (welcome graph, settings theme preview)
stay inline SVG, not registry icons.

## Which glyph renders

`Icons.X` reads `document.documentElement.dataset.design` at render time. That
attribute is written by the settings provider's layout effect from
`theme.design ?? 'default'`, so no icon needs a settings hook and components rendered
outside `SettingsProvider` still work.

- `material` (or `animated`) renders a 24x24 stroked SVG built from `PARTS`.
- anything else renders the Lucide SVG component.

`MATERIAL` maps each Lucide name to a glyph in `PARTS`; names without a mapping keep
their Lucide icon. Adding a glyph means adding its 24x24 inner markup to `PARTS`,
tagging moving parts with `ai-*` classes, and mapping the Lucide name in `MATERIAL`.

## Motion

Icons are inline SVG, not a font, so individual parts animate: a branch curve draws
itself, an arrow lifts, a gear turns, a tag tilts, a cloud bounces, a magnifier
wobbles. The rules in `material.css` (all under `html[data-design='material']`) trigger
on `:hover`/`:focus-visible` of the nearest button, summary, menu item, option, palette
item, reference row, file row, tab or start item, so the icon reacts to the whole
control it belongs to. Carets also flip for `aria-expanded`/`open` disclosures.
Classed parts use `transform-box: fill-box` so SVG parts rotate and scale around
themselves. Busy icons (`className="spin"`) turn continuously. Everything is disabled
under `prefers-reduced-motion: reduce`.

No icon font or extra asset is shipped; the glyphs are drawn by the app.

## Verification

`npm test` and `npm run build` cover the swap; `settings.smoke.mjs` selects both Material
presets and asserts paint. Per-icon animation is CSS only and not covered by unit tests,
so check a Material preset and hover the toolbar and sidebar in `npm run dev`.
