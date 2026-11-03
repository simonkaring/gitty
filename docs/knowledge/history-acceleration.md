---
type: Engineering Invariant
title: History acceleration
description: Explicit commit-graph writes, object-store-only scope, and dismissible slow-history advice.
status: draft
sources:
  - id: backend
    resource: ../../src-tauri/src/commit_graph.rs
  - id: contract
    resource: ../../src-tauri/BACKEND.md
  - id: advice
    resource: ../../src/model/commitGraph.ts
  - id: pane
    resource: ../../src/components/RepositoryPane.tsx
  - id: timing
    resource: ../../src/model/native.ts
  - id: ui-tests
    resource: ../../src/components/RepositoryPane.commitGraph.test.tsx
  - id: model-tests
    resource: ../../src/model/commitGraph.test.ts
---

# History acceleration

Commit-graph maintenance is explicit, never part of opening or reading a
repository. Status checks effective configuration, Git-resolved primary paths,
and alternates, without walking commits; SSH/WSL file tests run where Git runs.
Presence is metadata evidence, not graph validation or filter coverage.[^backend]

The write rechecks `core.commitGraph=false` under the common-directory mutation
lock and uses the logged mutation command contract with a 15-minute deadline.
`--reachable --changed-paths --split` writes only object-store graph metadata;
refs, index and working files remain untouched. Repeated writes reuse split
layers, whose old Bloom-filter coverage may remain. Bare repositories and
in-progress working-tree operations need no content preflight because no user
content or refs can be overwritten.[^backend][^contract]
Shallow repositories are explicitly refused because Git cannot use commit-graphs
with shallow boundaries; the action never fetches to remove those boundaries.[^backend]

The active pane offers dismissible advice only for a missing graph after a first
history page IPC duration of at least 300 ms (not snapshot/open duration).
Dismissals persist per canonical repository identity. The command palette always
offers the same explicit action, subject to ordinary UI mutation blocking.
Progress and success use the toast region; write reconciliation starts fresh
history even if refs did not change, and errors never retry the write.[^advice][^timing][^pane]

Real temporary-repository regressions in `commit_graph::tests` cover missing →
present, disabled refusal, repeated writes, Bloom index creation, linked
worktrees, alternates/bare repositories, and byte-for-byte index / working-file
and ref preservation. Model and mocked-IPC UI tests cover advice, persistent
dismissal, palette execution, progress and unchanged-ref history reload. These
do not establish live SSH or Windows/WSL runtime correctness.[^backend][^model-tests][^ui-tests]

## Local verification (2026-11-03)

On macOS, frontend build and `npm run check:rust` passed; `npm test --
--maxWorkers=2` passed 470 tests. `CARGO_BUILD_JOBS=4 cargo test` encountered an
unrelated invalid empty `gpg.format` in the user's global Git config. Repeating
with `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1` passed 312 tests with two
ignored; Rust formatting passed. This is host testing, not live SSH/WSL evidence.

On an APFS copy of the git/git benchmark fixture (85,977 commits, Apple Git
2.54.0), five raw `rev-list --date-order --stdin` runs over all ref tips read
the first 200 OIDs in median **591.04 ms without a graph → 93.25 ms with a
split graph**. The initial `--reachable --changed-paths --split` write took
8.069 s and its repeat 0.024 s. Before samples ranged 570–805 ms; after samples
86–220 ms. The original fixture was not modified. These measurements exclude
Service/IPC/rendering and were repeated without this task's test/build load.

Related: [mutation safeguards](git-mutation-safeguards.md),
[action notifications](action-notifications.md), and
[verification scope](demo-and-native-verification.md).

[^backend]: Status, locked write, transport checks and real-Git regressions.
[^contract]: Explicit history acceleration command contracts and scope.
[^advice]: Suggestion threshold, dismissal identity and palette command.
[^pane]: Mutation lifecycle and fresh history installation.
[^timing]: First history page duration observer.
[^ui-tests]: Mocked palette, progress and unchanged-ref reload regression.
[^model-tests]: Suggestion boundaries, persisted dismissal and demo behavior.
