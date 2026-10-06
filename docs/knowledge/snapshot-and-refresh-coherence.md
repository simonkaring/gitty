---
type: Architecture
title: Snapshot and refresh coherence
description: How repository snapshots, pinned history, and session-aware refresh fit together.
status: draft
sources:
  - id: snapshot
    resource: ../../src-tauri/src/operations.rs
  - id: history
    resource: ../../src-tauri/src/repository.rs
  - id: loader
    resource: ../../src/model/native.ts
  - id: pane
    resource: ../../src/components/RepositoryPane.tsx
  - id: tests
    resource: ../../src/model/native.integration.test.ts
  - id: contract
    resource: ../../src-tauri/BACKEND.md
---

# Snapshot and refresh coherence

`Repository::snapshot` shares state/status with operation-state construction,
checks HEAD/ref agreement, and rechecks the state fingerprint. It retries up to
three times before `unstable`. This is a best-effort read across external
changes, not a transactional filesystem snapshot.[^snapshot][^contract]

History generations pin concrete commit IDs and stream a walk with a replay
spool. A cursor belongs to that walk; its generation is opaque, not a state
fingerprint. In `readNativeSnapshot`, unchanged state reuses loaded history;
a changed state triggers a walk bracketed by a live state check. Mixed
generations, nonadvancing cursors, and inconsistent ancestry are rejected before
publication.[^history][^loader]

Automatic keep-visible IDs are filtered to the previous loaded history. After a
confirmed amend, the old HEAD can be remapped to the returned OID before paging,
only while that OID is the refreshed HEAD. Otherwise an unreachable old tip or
inspector-only orphan could cause a full-history scan. Session checks prevent
superseded asynchronous reads from publishing.[^loader][^tests]

`RepositoryPane` coordinates reads with write completion. File/index-only
mutations refresh status, falling back to full refresh if HEAD/ref moved;
commit/amend use full refresh. A failed post-write refresh blocks further
mutations until recovery. Following an amended selection also checks that the
user has not navigated since submission.[^pane]

For changes, inspect `readNativeSnapshot`, `refreshStatus`, and `mutate`, plus
the scripted-IPC regressions in
[native.integration.test.ts](../../src/model/native.integration.test.ts).
Despite that filename, those tests mock IPC. Backend snapshot tests live in
[operation_tests.rs](../../src-tauri/src/operation_tests.rs); real history and
fingerprint tests live in [tests.rs](../../src-tauri/src/tests.rs).

Related: [mutation safeguards](git-mutation-safeguards.md),
[verification scope](demo-and-native-verification.md), and the detailed
[read semantics](../../src-tauri/BACKEND.md#read-semantics).

[^snapshot]: `Repository::snapshot` coherence loop.
[^history]: History generations and cursor ownership.
[^loader]: Snapshot loading, ancestry validation, and amend remapping.
[^pane]: Per-tab read/write coordination and navigation guards.
[^tests]: Scripted snapshot race and keep-visible regressions.
[^contract]: Read limitations and fingerprint coverage.
