# Gitty - Agent Guidelines

Welcome, AI Agent! This file contains context and guidelines for working on **Gitty**, a graph-first desktop Git client.

## Project Context
- **Description:** Gitty is a graph-first desktop Git client prototype.
- **Core Value:** Providing clarity for Git history with an interactive graph and commit/file inspection.

## Tech Stack
### Frontend
- **Framework:** React 19
- **Language:** TypeScript
- **Bundler:** Vite
- **Icons:** lucide-react
- **Testing:** Vitest

### Desktop / Backend
- **Framework:** Tauri 2
- **Language:** Rust
- **Build Tool:** Cargo

## Development Guidelines

### General
- **Offline First:** The application makes no external runtime network requests for assets or repository data. Fonts and icons are bundled locally.
- **TypeScript & Rust:** Maintain strict typing in both TypeScript and Rust to ensure robustness.
- **Conventional Commits:** Follow the [Conventional Commits](https://www.conventionalcommits.org/) specification (e.g., `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`) for all commit messages.

### Frontend (React & TypeScript)
- Use modern React 19 patterns (e.g., Hooks, Server Components if applicable, though primarily client-side here).
- Ensure components are accessible and responsive.
- Keep the UI clean, focusing on the three-pane workspace and graph visualization.
- Run tests using `npm run test` (Vitest).

### Backend (Tauri & Rust)
- Rust code lives in the `src-tauri` directory.
- Use Rust for system-level integrations and heavy lifting (e.g., parsing Git history, interacting with the file system).
- Communicate between the frontend and Rust backend using Tauri commands securely.
- Ensure cross-platform compatibility when writing native code.
- Check Rust code with `npm run check:rust` or `cargo check` inside `src-tauri`.

## Scripts Reference
- `npm run dev`: Start the web-based preview.
- `npm run desktop`: Start the Tauri desktop application in development mode.
- `npm run test`: Run frontend unit tests.

Please adhere to these guidelines when suggesting or implementing changes.
