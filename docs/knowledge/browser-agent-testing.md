---
type: Verification Guide
title: Real-Git browser agent testing
description: Fixture-bounded Playwright access to real Git mutations and its desktop verification limits.
status: draft
sources:
  - id: bridge
    resource: ../../scripts/e2e/viteBridge.mjs
  - id: harness
    resource: ../../scripts/e2e/harness.mjs
  - id: scenarios
    resource: ../../tests/e2e/real-git.spec.ts
---

# Real-Git browser agent testing

The Playwright browser host is enabled only by the development build flag and the E2E server environment. Each browser session receives a bounded, registered fixture sandbox (`repo/`, `worktrees/`, `remotes/`, and `clones/`) and a fixture-specific bearer token. Invoke and event requests are same-origin checked and bound to that fixture; release blocks new fixture work, waits up to the request deadline for tracked requests, closes repository handles/watchers, then removes the canonical sandbox and registry entries. The bridge allows a fixed CLI method set, bounds request bodies, concurrent fixtures/requests/event queues, and protocol wait time, and rejects unregistered repositories, remotes, worktrees, and cross-fixture handles.

The test host forwards version-1 stdio `repository_changed`, `repository_clone`, `git_command`, and `events_dropped` frames to authenticated browser fetch streams. Subscription resolves only after the response headers establish the stream; the UI awaits that before starting the repository watcher. Reconnect and queue loss request a refresh of the fixture's open handles. Repository changes are routed through the handle's actual root and fixture owner; clone progress is routed only to the fixture owning its `operationId`. `git_command` has no handle in its DTO, so it is forwarded only when a single fixture is registered. Prompt listeners remain disabled. Test-host cloning accepts only a registered local bare remote and a destination under that fixture's `clones/`; progress and cancellation use the backend operation ID. Each registered root is paired with its exact expected Git common directory, including independent clones and their linked worktrees. Real repository mutations are checked with raw Git in the Playwright tests; mocked browser tests do not verify native backend behavior.

Run `npm run build`, `npm test`, and `npm run test:e2e` for the corresponding frontend and real-Git coverage. E2E builds the extracted CLI first. Verification on 2026-11-15: Windows frontend build passed, all 501 Vitest tests passed, and the full real-Git suite passed 15/15, including fixture-restricted clone, merge continuation, worktree removal, and teardown.
