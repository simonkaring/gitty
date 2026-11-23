---
type: Concept
title: Theme palettes and contrast
description: How preset palettes become CSS tokens, which colors are derived for readability, and what the contrast guard covers.
status: draft
sources:
  - id: themes
    resource: ../../src/model/themes.ts
  - id: settings
    resource: ../../src/model/settings.tsx
  - id: tokens
    resource: ../../src/styles/tokens.css
  - id: material
    resource: ../../src/styles/material.css
  - id: apple
    resource: ../../src/styles/apple.css
  - id: theme-tests
    resource: ../../src/model/settings.test.ts
  - id: style-tests
    resource: ../../src/styles.test.ts
---

# Theme palettes and contrast

A theme is a fixed set of color keys (`COLOR_KEYS`) plus an optional design
family. The settings provider writes each key to the root element as a
`--kebab-case` custom property, so styles read tokens and never a preset's
values. Custom themes must carry every key; adding a key would invalidate
stored and exported themes.[^themes][^settings]

## Presets

Gitty, Material and Apple presets are hand-tuned. Gruvbox, Dracula, Nord and
Catppuccin come from `family()`, which takes a palette's surfaces, text, accent,
red and green and derives the rest. The palette's own accent, red and green stay
on fills, focus rings and graph lanes 1 to 3. The text tokens (`accentText`,
`red`, `green`) are the same hues moved toward the text color, only as far as
WCAG AA (4.5:1) needs on the surfaces and washes they label; a hue that already
passes is unchanged.[^themes]

## Warning color

There is no warning color key. `--amber` is graph lane 5, which the default
family tunes as an amber; on light themes it is mixed toward the text color so
it reads as text. Material lanes rotate around the seed hue and Apple's lane 5 is
the system green, so those two families set their own `--amber` per mode
instead.[^tokens][^material][^apple]

## What the guard covers

One test holds every built-in theme to 4.5:1 for `text`, `secondary`, `muted`,
`accentText`, `green` and `red` on `bg`, `chrome`, `sidebar`, `raised` and
`subtle`, and for accent and diff text on their washes and the selection
fill.[^theme-tests] It does not cover:

- Apple's filled controls (white on the system blue, 4.0:1 light and 3.7:1
  dark), kept to match the platform.
- Tints mixed in CSS (section count pills, the current-worktree row), where
  small secondary labels sit at 3.9 to 4.4:1 in Gruvbox Light and Catppuccin
  Latte.
- Non-text contrast: control borders, graph lanes and focus rings.
- Custom themes, where the editor's contrast feedback is guidance only.

A second test fails when a stylesheet reads a custom property that nothing
defines, and when a `Dialog` `size` used by a component has no width
rule.[^style-tests]

## Verification

On November 23, 2026, on Windows, headless Chromium rendered the demo workspace
in all twelve presets across history, diffs, working changes, menus, the command
palette, settings and dialogs. Rendered text contrast was computed from the DOM
with translucent layers composited, and a sample of screenshots was inspected.
`npm run build` passed; `npm test` passed except one date-label test that
assumes a US locale. Packaged webviews, real repositories and forced-colors
mode were not exercised. See [verification guidance](demo-and-native-verification.md).

[^themes]: Color keys, presets, `family()` derivation and `contrastRatio`.
[^settings]: Root custom properties, `data-theme` and `data-design`.
[^tokens]: Fallback tokens and the default `--amber`.
[^material]: Material `--amber` per mode.
[^apple]: Apple `--amber` per mode.
[^theme-tests]: Built-in theme contrast and derived-preset tests.
[^style-tests]: Undefined custom property and dialog size guards.
