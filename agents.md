# Gitty agent guide

Gitty is a graph-first desktop Git client built with Tauri 2, Rust, React 19, TypeScript, and Vite. See [README.md](README.md) for features and setup; see [src-tauri/BACKEND.md](src-tauri/BACKEND.md) for the native Git and IPC contracts.

## Where changes belong

- `src/components/`, `src/App.tsx`, and `src/styles.css`: client-side workspace, graph, inspection, and UI. Keep interactions keyboard-accessible and responsive.
- `src/model/` and `src/graph/`: shared types, typed Tauri IPC helpers, demo behavior, and graph layout. Keep the frontend/backend data contracts aligned when changing commands or DTOs.
- `src-tauri/src/`: native repository reads and mutations. Keep Git and filesystem work in Rust, use explicit shell-free Git arguments, and preserve cross-platform native/WSL behavior where applicable.
- The browser preview (`npm run dev`) uses synthetic repositories and simulated writes. Real repository access and Git mutations require the Tauri desktop app (`npm run desktop`).

## Invariants

- Repository browsing and refresh do not make network requests. Only explicit user-initiated clone, fetch, pull, and push operations contact remotes; bundle fonts and icons locally.
- Keep Git writes explicit and guarded against stale state; preserve working files and unrelated staged changes. Consult the backend contract before changing staging, commits, or graph operations.
- Treat demo and native flows distinctly; test the appropriate path rather than assuming mocked browser IPC validates native behavior.
- Use Conventional Commits for commits when asked to create one.

## Checks

- Frontend: `npm test` (Vitest) and `npm run build` (TypeScript + Vite).
- Rust or IPC changes: `npm run check:rust` and `npm run test:rust`; run `cargo fmt --manifest-path src-tauri/Cargo.toml --check` for Rust edits. The full cross-platform CI commands are in `.github/workflows/check.yml`.
- Add or update focused tests for behavior changes. Browser smoke scripts under `src/components/*.smoke.mjs` use mocked Tauri IPC and require a separate Playwright/Chromium installation; see the README for invocation.
