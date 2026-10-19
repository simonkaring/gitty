---
okf_version: "0.2"
---

# Repository behavior

- [Git mutation safeguards](git-mutation-safeguards.md) - Explicit write scope, stale-review checks, and reconciliation after uncertain outcomes.
- [Snapshot and refresh coherence](snapshot-and-refresh-coherence.md) - How repository snapshots, pinned history, and session-aware refresh fit together.
- [Native and WSL boundaries](native-and-wsl-boundaries.md) - Where Git and filesystem work execute and which platform capabilities differ.
- [Repository cloning and accounts](repository-cloning-and-accounts.md) - Connected-account repository browsing, clone credential scope, and native/WSL limits.
- [History avatar preferences](history-avatar-preferences.md) - Persisted author avatar choices and optional avatar nodes in the history graph.
- [History column sizing](history-column-sizing.md) - History column resizing, initial message fill, and graph alignment after reordering.
- [Repository tab ordering](repository-tab-ordering.md) - Drag and keyboard tab reordering, active identity, and persisted repository order.
- [Worktree management](worktree-management.md) - Sidebar discovery, reviewed worktree mutations, and open-session safeguards.
- [Action notifications](action-notifications.md) - Remote and stash success summaries and merge-work recovery notices in the bottom-left toast region.
- [History search and workspace entry points](history-search.md) - Search result inspection, graph reveal, footer commands, and settings-based demo switching.
- [Split diff review](split-diff-review.md) - Paired before/after rows, fixed gutters, shared horizontal scrolling, virtualized rows, roving line focus, and original line-selection identity.
- [Working changes at scale](working-changes-at-scale.md) - Memoized working-file data, measured viewport-only rows, and targeted native patch reads.

# Verification and upkeep

- [Demo and native verification](demo-and-native-verification.md) - Which checks exercise simulated IPC, real Git, or platform runtime behavior.
- [Knowledge maintenance](maintenance.md) - How to keep this small source-backed OKF bundle aligned with code and tests.
