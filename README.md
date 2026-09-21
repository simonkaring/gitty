# Gitty

**A little clarity for your Git history.**

A graph-first desktop Git client built with **Tauri 2, React 19, TypeScript, and Rust**. The desktop app now supports read-only exploration of real repositories: paged history, working changes, diffs, comparisons, search, and automatic refresh. The browser preview retains the clearly labeled synthetic demo.

## Run it

Use Node **22.12+** (Node 24 LTS recommended) and npm.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:1420**. The browser preview has the same interactions as the desktop frontend and requires no Rust toolchain. Fonts and icons are bundled locally; the application makes no external runtime network requests for assets or repository data.

### Desktop

Install **Git 2.37+** and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform, including stable Rust/Cargo:

- **macOS:** Xcode Command Line Tools; the first visual target. The app uses a standard native titlebar and a platform-neutral workspace beneath it.
- **Windows:** Microsoft C++ Build Tools and WebView2. No POSIX shell assumptions or hard-coded filesystem paths in the backend.
- **Linux:** the distribution’s WebKitGTK 4.1 and other Tauri development libraries. See the prerequisites link and the Ubuntu CI setup.

```sh
npm run desktop                 # Native development window + Vite
npm run desktop:build           # Production app and platform bundles
npm run check:rust              # Cargo check (build the frontend first)
```

`src-tauri/tauri.conf.json` sets the app identity, window limits, local asset CSP, and platform icons. `app-icon.svg` is the editable source; regenerate assets with `npm run tauri -- icon app-icon.svg --output src-tauri/icons`. Installer signing and notarization are not configured.

## Explore a real repository

Run `npm run desktop`, choose **Open repository**, then use the native folder picker or a recent location. On Windows, the picker also offers WSL distribution discovery and Linux-directory browsing. WSL Git runs inside the selected distribution. Windows/WSL runtime validation is still pending.

- **Repository identity:** native/WSL location, current branch or detached HEAD, linked worktree, shallow, and bare states.
- **Live graph:** local branches, remote-tracking branches, commit-pointing tags, and HEAD; 200-commit cursor pages with original parent relationships. Remote information reflects locally stored refs, without fetching.
- **Working changes:** a distinct graph entry attached to HEAD, with staged, unstaged, untracked, and conflicted categories. A partially staged file can appear in both staged and unstaged lists.
- **Real changes:** lazy file lists and Git-produced unified/side-by-side diffs, including rename/binary/mode metadata and explicit preview limits. Root commits compare against the empty tree; merge commits offer a parent selector.
- **Compare commits:** select a commit as base and another as target, then swap direction if needed. The heading explains how the base tree becomes the target tree.
- **Search/filter:** messages, authors/emails, full/prefix hashes, and reference labels across reachable history; optional branch, date, and literal-path scope. Matches are highlighted while nonmatching ancestry stays visible. Results are capped at 500 and explicitly labeled when truncated.
- **Refresh:** every five seconds while visible, on window focus, or manually. Coherence checks reject mixed history snapshots; selection and the viewport's commit/pixel anchor are preserved where available. No filesystem watcher is installed yet.

Exploration does not stage, commit, switch branches, fetch, or change repository files. The backend uses the installed Git with structured arguments and targeted read-only configuration. Missing objects, unsupported encodings, partial/promisor clones, and process limits return explicit errors. See [M2 architecture and release validation](docs/milestone-2.md) for scope and remaining checks.

## Explore the demo

- **Three repositories:** switch from the sidebar or the repository picker in the titlebar. Each has deterministic IDs and a fresh selection/loading state.
- **Interactive graph:** canvas paths and nodes underneath accessible, virtualized HTML commit rows. Click a row to inspect it; double-click or press Enter to reopen a closed inspector.
- **History with difficult topology:** 1,685 commits, 2,279 parent edges, nested branch synchronization, shared ancestors, multi-parent merges, and octopus merges. Local branches, remotes, and tags jump to their target commits.
- **Progressive history:** start with 240 commits; load another 240 at a time. Search and parent/reference navigation automatically reveal older targets. Existing positions and scroll offsets stay stable.
- **Whole-history search:** match subjects, authors, SHAs, branch names, and ref labels. Enter / Shift+Enter or the arrow buttons move between matches. Unmatched rows fade rather than disappearing, preserving topology.
- **Commit inspector:** author/date, full copyable SHA, navigable parents, changed files, and mock unified diffs with correct line numbers and added/deleted/context lines. File status covers additions, modifications, and deletions.
- **Adjustable workspace:** collapse either side pane; resize the inspector by dragging its divider or using arrow keys while it is focused. Inspector width and light/dark preference persist locally. Small windows use overlay panes.
- **Keyboard and accessibility:** labeled listbox/options, selected and positional metadata, visible focus, semantic buttons, keyboard-accessible tabs and divider, native modal focus containment, and reduced-motion support.

### Shortcuts

| Key | Action |
| --- | --- |
| `/` or `Cmd/Ctrl K` | Focus search |
| `Enter` / `Shift Enter` in search | Next / previous match |
| `↑` / `↓` in history | Previous / next commit |
| `Page Up` / `Page Down` in history | Move one visible page |
| `Home` / `End` in history | First / last loaded commit |
| `H` | Jump to HEAD and clear search |
| `Enter` in history | Open commit inspector |
| `Esc` | Clear search / dismiss menu or dialog |
| `?` | Show shortcut reference |
| `←` / `→` on inspector divider | Resize by 20 px |
| `Home` / `End` on inspector divider | Minimum / maximum width |

Single-letter shortcuts are disabled while editing an input. Reference controls **navigate**, rather than checkout or filter. `All branches` intentionally keeps the complete graph visible.

## Project map

```text
src/
  App.tsx                       Workspace state, search, navigation, layout controls
  styles.css                    Light/dark tokens and responsive visual system
  components/
    HistoryGraph.tsx             Canvas renderer + virtualized accessible rows
    NativeWorkspace.tsx          Repository sessions, search, paging, coherent refresh
    NativeInspector.tsx          Real changes, parent selection, commit comparisons
    RepositoryPicker.tsx         Native/recent/WSL repository opening
    Sidebar.tsx                  Repository and reference navigation
    Inspector.tsx                Commit metadata, files, mock diff
  graph/
    layout.ts                    Pure renderer-independent lane layout
    layout.test.ts               DAG, lane, append-stability, clipping invariants
  model/
    types.ts                     Commit/ref/file models and provider boundary
    repository.ts                Native/WSL IPC data contract
    native.ts                    Typed data helpers and coherent snapshot loading
    demo.ts                      Deterministic synthetic history/provider
    diff.ts                      Small LCS diff for synthetic text fixtures
    diff.test.ts                 Diff reconstruction and line-number invariants
src-tauri/
  src/lib.rs                     Tauri command registration and blocking-worker dispatch
  src/repository.rs              Sessions, streaming history, status, search, metadata
  src/diff.rs                    Git change lists and structured patches
  src/process.rs                 Bounded shell-free process execution
  src/stream.rs                  Backpressured Git streams and lifecycle cleanup
  src/wsl.rs                     Windows distribution discovery and Linux browsing
  src/main.rs                    Cross-platform native entry point
  capabilities/default.json     Minimal main-window permissions
  tauri.conf.json                Tauri 2 app/build/bundle configuration
docs/architecture.md             Layout decisions, native Git and future WSL boundary
docs/milestone-2.md               Implemented exploration architecture and validation
```

## Checks

```sh
npm test                        # Topology/layout and diff invariant tests
npm run test:watch
npm run build                   # Strict TypeScript check + production Vite build
npm run preview                 # Serve the production build
npm audit
npm run check:rust              # Requires Rust/Cargo
npm run test:rust               # Real temporary repository integration tests
```

The CI workflow defines a macOS / Windows / Ubuntu matrix for frontend tests/builds, Rust tests, and native compilation. The matrix is not evidence that Windows or Linux runtime behavior has been verified locally.

### Milestone 2 verification

- **22 frontend tests passed**, including asynchronous refresh races and graph clipping invariants.
- **30 Rust tests passed on macOS**, using real temporary repositories, including a 100,005-commit fixture, merges, linked worktrees, conflicts, search semantics, process limits, read-only behavior, and cursor replay.
- Strict TypeScript/Vite production build and Rust check/format checks passed.
- Browser smoke passed for the demo and native workspace using mocked Tauri IPC, including refresh races, scroll preservation, comparisons, stale responses, and themes.
- A macOS debug application bundle built successfully with `npm run desktop:build -- --debug --bundles app`. Native GUI repository interaction, Windows/WSL, Linux runtime, signed installers, and screen-reader validation remain release checks.

### Milestone 1 verification

- Production frontend build and all **7 invariant tests passed** locally.
- Automated Chromium smoke checks passed for virtualization, row selection, keyboard navigation, HEAD jumps, searching into unloaded history, no-results search, diffs, pointer/keyboard resizing, sidebar toggling, both themes, dialogs, repository switching, incremental loading, and narrow layouts. No uncaught browser errors were observed.
- `npm audit` reported **0 vulnerabilities** at implementation time.
- At M1 implementation time, `tauri info` recognized the app/config and macOS/Xcode environment, but Rust/Cargo was unavailable. M2 now includes `Cargo.lock` and successful native compilation as recorded above.

## Scope and next steps

The next functional milestone is everyday Git workflows: staging, commits, branches, remotes, and stashes. WSL runtime verification and broader desktop validation should precede claiming the exploration release is platform-complete.

The demo snapshot remains materialized once per repository. Native history uses a pinned Git walk with bounded read-ahead and a temporary replay spool, batched metadata reads, and lazy diffs. Canvas and DOM rendering are viewport bounded; an interval index accelerates edge visibility queries. Layout still runs on the main thread for the loaded prefix; worker-based/incremental layout remains performance follow-up work.

See the [M1 architecture record](docs/architecture.md), [M2 implementation](docs/milestone-2.md), and [backend details](src-tauri/BACKEND.md).
