---
type: UI Behavior
title: History search and workspace entry points
description: Search result inspection, graph reveal, footer commands, and settings-based demo switching.
status: draft
sources:
  - id: pane
    resource: ../../src/components/RepositoryPane.tsx
  - id: results
    resource: ../../src/components/SearchResults.tsx
  - id: workspace
    resource: ../../src/components/NativeWorkspace.tsx
  - id: settings
    resource: ../../src/components/Settings.tsx
  - id: backend
    resource: ../../src-tauri/BACKEND.md
  - id: tests
    resource: ../../src/components/search.smoke.mjs
---

# History search and workspace entry points

Sidebar filters (or main-pane filters when the sidebar is hidden) debounce
full-history search. Results occupy the history area with subject, author, date,
short SHA, and reference labels. Selecting a result opens the inspector by object
ID without paging the graph; **Show in graph** uses the existing paged reveal.
**Results / Graph** preserves the query and keeps the graph's real ancestry.
Search state belongs to each mounted repository pane. Background re-searches
retain existing results while loading; responses from superseded queries are
ignored. Arrow keys and Home/End move focus between result buttons.[^pane][^results]

Native search semantics and the 500-match limit remain defined by the backend;
demo search uses simplified synthetic matches, not native Git coverage.[^backend]

The footer opens workspace/repository commands, including on the welcome screen.
Cmd/Ctrl+K remains available. Desktop demo switching lives in Settings →
About / shortcuts, closes settings before changing modes, and is blocked during
operations in any tab, cloning, or unsaved theme edits.[^workspace][^settings]

The focused browser smoke exercises synthetic result navigation, themes,
scrolling, narrow layouts, and footer commands. It does not exercise native Git
or desktop mode switching.[^tests]

[^pane]: RepositoryPane search effect, direct result selection, and graph reveal.
[^results]: SearchResults rendering and keyboard focus movement.
[^workspace]: NativeWorkspace requestDemo and footer wiring.
[^settings]: SettingsDialog demo entry point and disabled states.
[^backend]: Read architecture search semantics.
[^tests]: Optional search browser smoke.
