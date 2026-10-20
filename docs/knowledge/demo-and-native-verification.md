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
  - id: ssh-tests
    resource: ../../src-tauri/src/ssh_tests.rs
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
| SSH transport | `npm run test:rust` on Unix runs `ssh_tests`, which substitute a shell double for the `ssh` client | Quoting, remote environment and stdin framing through a real shell; no authentication, host keys, network, Windows client or real remote host. Use the connect form's **Test connection** (`ssh_test`) for a real host and record its scope. |
| Packaged desktop | Build and exercise on the target platform using README procedures | Native GUI, authentication, process cleanup, and installation require their own observations. |

Commands and test scope come from the package scripts, README, and Rust
fixtures.[^scripts][^readme][^rust-tests][^wsl-tests][^ssh-tests] A host test pass does not
establish Windows/WSL/Linux runtime support or signed-artifact readiness.
For latency diagnostics, `GITTY_TRACE_PROCESS=1` prints captured subprocess spawn
and total durations plus mutation-lock waits to the desktop terminal. It omits
arguments, stdin and environment values. Run WSL timing tests serially with
`--nocapture --test-threads=1`; elapsed times vary with machine load, while spawn
counts provide deterministic regression limits.[^readme][^wsl-tests]
The latency change was checked on Windows with real Ubuntu temporary
repositories: open (including newline paths), status/content fingerprints,
stage/commit, fetch/pull/push, metadata scan/snapshot, lock refusal, and reset
freshness/untracked preservation passed. This does not cover live credentials,
packaged GUI behavior, all WSL distributions, or metadata symlink/race cases.[^wsl-tests]

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
[^ssh-tests]: SSH shell-double suite and what it deliberately does not exercise.
