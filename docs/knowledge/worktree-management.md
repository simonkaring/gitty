---
type: Architecture
title: Worktree management
description: Sidebar discovery, reviewed worktree mutations, and open-session safeguards.
status: draft
sources:
  - id: backend
    resource: ../../src-tauri/src/worktrees.rs
  - id: sessions
    resource: ../../src-tauri/src/repository.rs
  - id: ui
    resource: ../../src/components/Worktrees.tsx
  - id: ui-tests
    resource: ../../src/components/Worktrees.test.tsx
  - id: contract
    resource: ../../src-tauri/BACKEND.md
  - id: tabs
    resource: ../../src/model/tabs.ts
---

# Worktree management

The sidebar discovers main/linked, bare/detached, locked, and prunable worktrees
using NUL-delimited Git porcelain. Opening a sibling preserves native/WSL origin
and uses existing canonical tab deduplication. Discovery refreshes with pane
revision/activation, window focus, manual refresh, and in-app worktree
notifications. Demo management is explicitly unavailable.[^backend][^ui][^tabs]

Create, move, remove (including force), lock/unlock, and prune use captured review
tokens, revalidated under the shared repository mutation lock. Removal pins
content-aware status and ignored content; force needs a separate UI acknowledgement.
Locks are never implicitly overridden, branches are retained, and main/bare
targets cannot be managed. Prune previews expiry **now**, including recently missing
registrations, while retaining locked entries and working folders. Exact command
and error semantics belong in the backend contract.[^backend][^ui][^contract]

Move/removal require closed target sessions; prune refuses open prunable targets.
Opening/publishing sessions shares the mutation lock, and queued writes recheck
handle validity. Moves update recent paths; removal/prune drop obsolete recents.
Failures may follow completed Git writes, so the pane refreshes without automatic
retry. External Git can still race preflight.[^sessions][^backend][^contract]

`worktrees.rs` contains real temporary-repository lifecycle, forced-removal,
freshness, prune, parser, and validation regressions. `Worktrees.test.tsx` exercises
mocked IPC and UI acknowledgement/review behavior. These are source entry points,
not Windows/WSL or packaged-GUI runtime evidence.[^backend][^ui-tests]

[^backend]: Native worktree discovery, review, execution, and real-Git tests.
[^sessions]: Session publication, mutation locking, open-target refusal, and recents.
[^ui]: Sidebar and management dialog.
[^ui-tests]: Mocked dialog and opening regressions.
[^contract]: Detailed worktree IPC and safety limitations.
[^tabs]: Canonical worktree tab identity.
