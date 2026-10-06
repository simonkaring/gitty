---
type: Verification Guide
title: Demo and native verification
description: Which checks exercise simulated IPC, real Git, or platform runtime behavior.
status: draft
sources:
  - id: dispatch
    resource: ../../src/model/native.ts
  - id: demo
    resource: ../../src/model/demoBackend.ts
  - id: scripts
    resource: ../../package.json
  - id: readme
    resource: ../../README.md
  - id: rust-tests
    resource: ../../src-tauri/src/tests.rs
  - id: wsl-tests
    resource: ../../src-tauri/src/wsl_tests.rs
---

# Demo and native verification

The browser preview shares the workspace but routes `demo:` handles to an
in-memory backend. Handle-less calls use the current mode; session calls route
by handle even after a mode switch. Demo staging, discard, and new commits
operate on fixtures. Synthetic history/diffs and simulated remote responses
cannot establish native Git correctness.[^dispatch][^demo]

## Choose evidence for the boundary changed

| Boundary | Checks / entry points | What the evidence covers |
| --- | --- | --- |
| Frontend models and UI | `npm test`; `npm run build` | Vitest behavior and TypeScript/Vite compilation; inspect each test's mocks. |
| Native Git or IPC | Build frontend first, then `npm run check:rust`, `npm run test:rust`; Rust edits also need `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | Host compilation and Rust tests, including real temporary repositories; platform gates still apply. |
| Browser smoke | `src/components/*.smoke.mjs`, using the README's separate Playwright/Chromium setup | Mocked Tauri interactions; historical scripts may need current-UI updates. |
| Windows/WSL | On Windows, set `GITTY_WSL_TEST_DISTRO` and run `cargo test --manifest-path src-tauri/Cargo.toml wsl_tests` | Real distribution tests only when enabled; without the variable they return immediately. |
| Packaged desktop | Build and exercise on the target platform using README procedures | Native GUI, authentication, process cleanup, and installation require their own observations. |

Commands and test scope come from the package scripts, README, and Rust
fixtures.[^scripts][^readme][^rust-tests][^wsl-tests] A host test pass does not
establish Windows/WSL/Linux runtime support or signed-artifact readiness.

For a docs-only patch, parse frontmatter, validate relative source/navigation
links and reserved index structure, and check whitespace; application tests
are unnecessary. See [maintenance](maintenance.md) for the documentation rules.

Report actual commands, platform, outcome, and skipped/conditional coverage.
Distinguish inspecting a test from running it. Do not copy historical test
counts into current evidence or mark concepts human-reviewed because an agent
wrote them. This pilot records source pointers, not a fresh application test run.

Related: [platform boundaries](native-and-wsl-boundaries.md) and
[mutation safeguards](git-mutation-safeguards.md).

[^dispatch]: Native/demo dispatch by handle and mode.
[^demo]: Simulated commands and unsupported operations.
[^scripts]: Current npm command definitions.
[^readme]: Setup, checks, smoke prerequisites, and runtime gaps.
[^rust-tests]: Real Git repository fixtures and platform-specific tests.
[^wsl-tests]: Conditional real-WSL test setup.
