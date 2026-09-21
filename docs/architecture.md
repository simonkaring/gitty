# Milestone 1 architecture

> Historical record of the synthetic prototype. Real repository access and WSL transport are now implemented; see [Milestone 2](milestone-2.md) for current behavior and validation status.

## Boundaries

The React workspace owns selection, search, reference navigation, loaded row count, and pane state. `Commit`, `GitRef`, `ChangedFile`, and `RepositorySnapshot` are plain data structures. `HistoryProvider` specifies an asynchronous snapshot boundary with an explicit provider kind (`demo`, `native`, or `wsl`). Only `demoProvider` exists today; the workspace constructs the same deterministic fixture synchronously to keep first paint immediate.

The native shell is Tauri 2. Its only application command, `backend_info`, reports platform and demo mode, with both native Git and WSL capabilities set to false. It is a backend scaffold, not a repository implementation. The frontend has no dependency on OS-specific APIs. The displayed `~/Developer/...` paths are illustrative labels and are never opened.

## Graph contract

`layoutHistory` accepts a **child-before-parent** ordered sequence of opaque commit IDs and parent IDs. Dates do not determine topology. Real Git input must use an appropriate topological walk rather than sorting by timestamps.

For each row:

1. Consume the lane reserved for this commit, or allocate the first free lane for a new tip.
2. Release the consumed reservation.
3. Keep the first parent in that lane unless it already has a reservation.
4. Reserve free lanes for other parents, sharing existing reservations at convergence.
5. Trim only trailing empty lanes. Do not compact occupied lanes.

Output nodes contain `row` and `lane`; edges contain source/target coordinates and a reserved routing track. A missing parent terminates at the loaded boundary, so a shallow prefix does not fabricate a commit. Invalid order, duplicate IDs, and self-cycles fail explicitly. Colors are a renderer concern, based on lanes, and are not branch identity.

### Invariants tested

- The fixture is deterministic, has unique 40-character hexadecimal IDs, and every parent follows its children.
- Every generated parent relation has an edge with the correct endpoints.
- A reserved vertical track never passes through an unrelated commit node.
- Appending older commits does not move existing nodes or change edge routing tracks. A formerly missing target can gain a real endpoint.
- Empty histories, roots, disconnected tips, missing parents, convergence, invalid order, and duplicate IDs are handled deliberately.
- Edge clipping includes long edges crossing the viewport even when both endpoints are offscreen.

## Rendering and loading

`HistoryGraph` renders fixed-height 44 px HTML rows with eight overscan rows on either side. One viewport-sized, device-pixel-ratio-aware canvas renders the visible edge segments and nodes. The canvas is decorative (`aria-hidden`); all semantic commit information is in HTML options under a keyboard-operated listbox.

The canvas sits over the scroller in the same viewport. Scroll offset is applied to both node and edge coordinates. ResizeObserver measures available height. Selection decoration, ref badges, author, and hash remain HTML. This separation allows a different renderer or a worker to consume the same graph layout.

M1 eagerly builds a 1,685-commit snapshot and its layout, then progressively reveals 240-row prefixes. Jumps reveal the page containing the target before scrolling. Search uses the entire snapshot and dims nonmatches without deleting rows or edges. Reference navigation similarly keeps topology intact. Repository changes remount the workspace, preventing stale selection or paging state from crossing repositories.

There is no worker yet. Layout is under a millisecond in local measurements at this size. For larger real histories, use a dedicated worker with repository-generation IDs and cancel/ignore stale results. Persist the reservation state across backend cursor pages; keep lane width stable across an active walk or explicitly account for horizontal growth. Index edge row intervals rather than scanning all edges on each scroll.

## Diff scope

The LCS implementation operates only on very small synthetic text files. Tests reconstruct both input sides and verify line numbering, including repeated lines, empty files, file additions, and deletions. File statistics match the demo fixtures. This is not intended as a production diff engine or a patch applicator. Real diffs should be supplied by Git with explicit binary, rename, submodule, conflict, mode-change, and large-file states.

## Native Git follow-up — macOS, Windows, Linux

Use one Rust repository service and typed IPC DTOs across all three platforms. Prefer a structured Git library or subprocesses with explicit argument arrays, no shell interpolation, and well-defined timeouts/cancellation. Keep filesystem paths and OS string conversions in Rust. Return opaque repository handles to the frontend rather than using display paths as authority.

Suggested commands:

- `open_repository(location)` → opaque handle, capabilities, canonical display path
- `read_refs(handle)` → refs plus symbolic/detached HEAD
- `read_history(handle, cursor, limit, revision)` → topological commits, stable cursor, snapshot revision
- `read_commit(handle, oid)` → full metadata
- `read_diff(handle, oid, path, options)` → structured diff hunks

Include typed errors (not found, unsafe ownership, unavailable Git, permission denied, invalid cursor, cancellation), distinguish empty and shallow repositories, and retain raw commit IDs. Reads and later mutation commands must have separate interfaces/capabilities. Watching refs invalidates the walk revision instead of silently mixing two histories.

Cross-platform CI includes all three host operating systems. Release packaging and runtime smoke testing must run on each platform; macOS signing/notarization and Windows signing are separate distribution tasks. No native platform has been validated by this milestone’s local browser checks.

## Future WSL backend — design only

WSL integration is **not implemented or detected**. It should be an additional Windows-host transport behind the same repository service, not an alternate frontend graph or a path-rewriting shortcut.

Model repository locations as a discriminated union, for example:

```ts
type RepositoryLocation =
  | { kind: 'native'; opaquePath: string }
  | { kind: 'wsl'; distribution: string; linuxPath: string };
```

A future Windows implementation can enumerate installed distributions, let the user select one, and execute a small structured helper through `wsl.exe --distribution <name> --exec <helper> ...`. Use explicit arguments and JSON/framed responses; do not build shell command strings from paths or ref names. Preserve Linux path semantics, case sensitivity, permissions, symlinks, and credentials within the selected distribution. Avoid accessing a Linux repository through a Windows Git process over `\\wsl$` as a substitute for this transport.

Cancellation must stop the Windows transport and the Linux-side operation. Repository handles and cache keys must include distribution identity. Capability/error reporting needs distribution-not-found, stopped/unavailable WSL, missing Linux Git/helper, and unsupported operation states. Test paths with spaces and non-ASCII characters, symlinks, large histories, Git worktrees, and unavailable distributions on real Windows/WSL installations before claiming support.

## Preferences and accessibility

Theme and inspector width are optional localStorage preferences, guarded for hosts that disable storage. Repository data is never persisted. Native dialog provides modal focus handling, tabs use arrow/Home/End navigation, the inspector separator exposes its numeric range, and canvas visuals have semantic HTML equivalents. Browser automation checked keyboard interactions and responsive overflow; a dedicated screen-reader audit remains future validation.
