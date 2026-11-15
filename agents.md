# Gitty agent guide

Gitty is a graph-first desktop Git client built with Tauri 2, Rust, React 19, TypeScript, and Vite. See [README.md](README.md) for features and setup; see [src-tauri/BACKEND.md](src-tauri/BACKEND.md) for the native Git and IPC contracts.

## Where changes belong

- `src/components/`, `src/App.tsx`, and `src/styles.css`: client-side workspace, graph, inspection, and UI. Keep interactions keyboard-accessible and responsive.
- `src/model/` and `src/graph/`: shared types, typed Tauri IPC helpers, demo behavior, and graph layout. Keep the frontend/backend data contracts aligned when changing commands or DTOs.
- `crates/gitty-core/src/`: shared repository reads, mutations, protocols, and process safeguards. Keep Git and filesystem work in Rust, use explicit shell-free Git arguments, and preserve native/WSL/SSH boundaries.
- `crates/gitty-cli/`: console commands, stdio transport, and process-level agent checks. `src-tauri/src/` hosts desktop commands and prompt/window adapters over the same engine.
- The browser preview (`npm run dev`) uses synthetic repositories and simulated writes. `npm run test:e2e` is a separate dev-only path to a disposable real-Git fixture; it does not use or fake Tauri internals.

## Invariants

- Keep Git writes explicit and guarded against stale state; preserve working files and unrelated staged changes. Consult the backend contract before changing staging, commits, or graph operations.
- Treat demo, native, and real-backend test flows distinctly; mocked IPC does not validate native behavior.
- Use Conventional Commits for commits when asked to create one.
- Don't include co authors/assisted when committing.
- No need to test before committing.

## Knowledge maintenance

- At task start, open [the knowledge index](docs/knowledge/index.md), inspect concepts relevant to the task, and verify their claims against linked implementation and tests before relying on them.
- Assess knowledge impact on every code change. Update affected concepts in the same patch when behavior, contracts, invariants, platform boundaries, verification procedures, or architecture change. Cosmetic or unrelated edits need no knowledge churn.
- Correct stale claims discovered during work. Code and tests are authoritative; reconcile affected summaries with `src-tauri/BACKEND.md` and `README.md`, preserving unrelated edits. If a discrepancy cannot be resolved, record it explicitly with source links rather than presenting a guess as a contract.
- Keep concepts short and source-linked; detailed IPC contracts belong in `src-tauri/BACKEND.md`, user setup and features in `README.md`. Keep the index in sync when adding, renaming, or retiring concepts.
- Follow [the maintenance workflow](docs/knowledge/maintenance.md), including OKF reserved-file rules. Do not bump freshness dates without substantive source revalidation. Record verification only for checks actually performed, with scope/platform/outcome; never infer human review or runtime coverage from authorship, mocked IPC, or historical results.

## Checks

- Frontend: `npm test` (Vitest) and `npm run build` (TypeScript + Vite).
- Rust or IPC changes: `npm run check:rust` and `npm run test:rust` cover the workspace; run `cargo fmt --all -- --check` for Rust edits. Build the frontend first with `npm run build` for desktop checks.
- Standalone engine/CLI checks are `npm run check:headless` and `npm run test:headless`, with no frontend or desktop build requirement. Playwright's real-Git fixture suite is `npm run test:e2e` after installing Chromium with `npx playwright install chromium`; it is not packaged-desktop coverage.
- Add or update focused tests for behavior changes. Browser smoke scripts under `src/components/*.smoke.mjs` use mocked Tauri IPC and require a separate Playwright/Chromium installation; see the README for invocation.
