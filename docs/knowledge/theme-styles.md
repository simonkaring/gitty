---
type: UI Behavior
title: Theme styles
description: Built-in themes that change type, shape, icons and graph drawing, not only colors; custom themes stay color-only.
status: draft
sources:
  - id: themes
    resource: ../../src/model/themes.ts
  - id: settings
    resource: ../../src/model/settings.tsx
  - id: editorial
    resource: ../../src/styles/themes/editorial.css
  - id: graph
    resource: ../../src/components/HistoryGraph.tsx
  - id: settings-ui
    resource: ../../src/components/Settings.tsx
  - id: tests
    resource: ../../src/model/settings.themeStyle.test.tsx
  - id: graph-tests
    resource: ../../src/components/HistoryGraph.ui.test.tsx
---

# Theme styles

A built-in `ThemeDefinition` may carry `style` and `monoFont` besides its
colors. `SettingsProvider` writes `style` to `data-theme-style` on `<html>` and
uses `monoFont` for `--mono` in place of the user's code-font preference, which
is kept and returns with other themes; the Editor settings disable the code-font
picker while a theme sets it.[^themes][^settings][^settings-ui][^tests]

Each style has a stylesheet scoped to `[data-theme-style='…']` that overrides
tokens (fonts, radii, shadows, motion) and a few component rules. Gitty
Editorial Dark uses `editorial.css`: Instrument Serif display titles, Fraunces
working headings and tab titles, IBM Plex Mono code, small-caps labels, hairline
rules, thinner Lucide strokes, and an accent underline for the active
tab.[^editorial]

`GRAPH_STYLES` sets canvas line width, node radius and rail corner radius per
style (`default` for every other theme). Edges are drawn as rails: vertical at
nodes, changing lanes halfway between rows with `arcTo` corners. Stroke width is
rounded to whole device pixels and coordinates are snapped to the pixel grid
(including the preview's CSS zoom), and the canvas CSS size is derived from its
backing-store pixels and, after each render, the canvas is nudged by its
sub-pixel remainder (CSS `translate`) so it starts on a whole device pixel at
fractional scaling; otherwise the browser resamples the bitmap. Nodes erase a small ring
of line around themselves (`destination-out`, so row tints show through); merges
and the working tree are hollow and HEAD gets a thin concentric ring. Until the
graph column is resized it fits its lanes up to 200px.[^graph][^graph-tests]

Custom theme files remain colors-only: `validateTheme` rejects `style` and
`monoFont`, and duplicate/export build colors-only definitions.[^themes][^settings-ui]
Tests run under jsdom with a mocked canvas; rendered appearance was checked in
the browser demo only, not in the packaged desktop app.

[^themes]: ThemeDefinition, GRAPH_STYLES, BUILTIN_THEMES and validateTheme.
[^settings]: SettingsProvider layout effect applying theme tokens.
[^settings-ui]: Code-font picker, Duplicate & customize, export, and ThemePreview.
[^editorial]: Editorial token and component overrides.
[^graph]: HistoryGraph canvas draw effect.
[^tests]: Style hook and theme code-font override, restored for plain themes.
[^graph-tests]: Node radii and rail corners per graph style.
