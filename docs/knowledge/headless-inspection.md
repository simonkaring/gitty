---
type: Verification Guide
title: Headless inspection
description: Headless CLI and stdio repository API, conditional host discovery, and real-Git browser test bridge.
status: draft
sources:
  - id: cli
    resource: ../../crates/gitty-cli/src/main.rs
  - id: cli-tests
    resource: ../../crates/gitty-cli/src/main.rs
  - id: service
    resource: ../../crates/gitty-core/src/repository.rs
  - id: dto
    resource: ../../crates/gitty-core/src/dto.rs
  - id: readme
    resource: ../../README.md
  - id: matrix
    resource: agent-command-matrix.md
  - id: dispatcher
    resource: ../../crates/gitty-core/src/agent.rs
  - id: bridge
    resource: ../../scripts/e2e/viteBridge.mjs
  - id: harness
    resource: ../../scripts/e2e/harness.mjs
  - id: e2e
    resource: ../../tests/e2e/real-git.spec.ts
---

# Headless inspection

`gitty-cli` provides native-local one-shot status/history/stage/unstage/commit,
guarded JSON requests, doctor/capability discovery, and a version-1
line-delimited stdio API with structured errors and bounded concurrent dispatch.
Request DTO validation is shared with published schemas, including nested
unknown-field rejection. Requests are strict UTF-8 and capped at 1 MiB. With
explicit `--accounts-file`, stdio supports provider token/device-OAuth and
account-backed operations; token input is JSON-only, OAuth does not open its
verification URL, and account access is disabled by default. SSH discovery uses
the shared validated API; WSL discovery is Windows-only and reports missing
`wsl.exe` structurally. Native mutations use a
nonblocking advisory lock in the Git common directory and fail with
`repositoryBusy` on contention; WSL/SSH cross-process locking is unsupported.
The CLI uses the standalone `gitty-core` and does not build the Tauri host.
Versioned events, clone progress, and opt-in prompt transport are supported;
dialogs and OS shell actions remain host-only. See the
[command matrix](agent-command-matrix.md)
for every registered desktop operation and its current headless disposition.

`npm run test:e2e` runs the rendered React workspace against a disposable real
Git fixture through a dev-only authenticated Vite bridge and CLI child process.
The Playwright slice verifies stage/commit, stale discard, partial-line staging,
stale hunk refusal, exact index/worktree bytes, and bridge rejections; the
environment test poisons inherited Git variables. Traces are disabled because
they retain authorization headers; this does not establish Tauri webview or
native runtime behavior.

For `serve --stdio`, EOF or broken output stops admission and discards queued
requests before shutdown cancels active clone/search/prompt work and closes
sessions. Cancellation/cleanup repeats every 25 ms while workers remain, catching
work admitted just before shutdown; already-started writes are not promised to
roll back.
See [verification boundaries](demo-and-native-verification.md).[^cli][^cli-tests][^service][^dispatcher][^bridge][^harness][^e2e]

[^cli]: CLI commands, protocol methods and lifecycle.
[^cli-tests]: Bounded queue discard after EOF and response correlation.
[^service]: Repository session ownership and history cursors.
[^dispatcher]: Supported agent methods and per-request deadline boundary.
[^bridge]: Fixture authorization, method restrictions, and child protocol.
[^harness]: Disposable repository setup, isolated environment, and cleanup.
[^e2e]: Rendered mutation workflows and independent Git/file assertions.
