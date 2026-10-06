# Gitty

**A little clarity for your Git history.**

A graph-first desktop Git client built with **Tauri 2, React 19, TypeScript, and Rust**. Switch between repository tabs, clone repositories, explore history, stage files or individual hunks, create or amend commits, sync branches, manage stashes, and resolve conflicts in a customizable workspace. The browser preview provides a clearly labeled synthetic history and illustrative diffs; staging and commits require a real desktop repository.

## The redesigned workspace

Neutral light and dark themes with a single burnt-orange accent, locally bundled **Geist** and **Geist Mono**, and restrained motion (disabled under `prefers-reduced-motion`) give Gitty a consistent visual language. Interface text defaults to 15px, history/file rows use 14px text, and diffs and meaningful metadata use 13px text. The graph uses aligned 48px rows.

The graph is the main workspace. Select a commit to inspect its files in the right panel, or select the **Working changes** graph entry to review files, stage changes, and compose a commit there. Selecting a file opens its diff in the center pane; close the diff to return to the graph. The repository action toolbar remains above the workspace. Sidebar and inspector widths persist; narrow windows use collapsible/overlay panes rather than reducing text size. Native history search, branch scope, and date/path filters sit above the graph; the demo's search and reference controls sit in its sidebar.

## Run it

Use Node **22.12+** (Node 24 LTS recommended) and npm.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:1420**. The browser preview demonstrates the workspace without a Rust toolchain. Fonts and icons are bundled locally.

### Desktop

Install **Git 2.37+** and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform, including stable Rust/Cargo:

- **macOS:** macOS 14+ and Xcode Command Line Tools. The bundled credential manager includes the .NET 10 runtime, which requires macOS 14+. The app uses a standard native titlebar and a platform-neutral workspace beneath it.
- **Windows:** Microsoft C++ Build Tools and WebView2. No POSIX shell assumptions or hard-coded filesystem paths in the backend.
- **Linux:** the distribution’s WebKitGTK 4.1 and other Tauri development libraries. See the prerequisites link for your distribution's setup.

```sh
npm run desktop                 # Native development window + Vite
npm run desktop:build           # Production app and platform bundles
npm run check:rust              # Cargo check (build the frontend first)
```

`src-tauri/tauri.conf.json` sets the app identity, window limits, a restrictive CSP (including Gravatar images when enabled), and platform icons. `app-icon.svg` is the editable source; regenerate assets with `npm run tauri -- icon app-icon.svg --output src-tauri/icons`. The manual `.github/workflows/release.yml` workflow uses protected CI secrets to build and verify signed Windows installers and a notarized macOS DMG; a successful workflow run and installation are required before treating the bundles as release-ready. macOS secrets: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_CONTENT` (the private `.p8` contents). Windows secrets: `WINDOWS_CERTIFICATE` (base64 PFX) and `WINDOWS_CERTIFICATE_PASSWORD`. No signing secrets belong in this repository.

## Explore a real repository

Run `npm run desktop`, choose **Open repository**, then use the native folder picker, a recent location, or the clone form. A clone targets a selected native folder or the currently browsed WSL folder, reports progress, can be cancelled, and opens the completed repository in a new tab. Clones are full, use the remote's default branch, do not initialize submodules, and copy local-source objects instead of hardlinking them. On Windows, the picker also offers WSL distribution discovery and Linux-directory browsing, and a folder chosen under `\\wsl.localhost\<distribution>\` (or `\\wsl$\`) opens through that distribution's Git. WSL Git runs inside the selected distribution; its conflict editor filesystem helper also requires Python 3. Windows/WSL runtime validation is still pending.

- **Repository identity:** native/WSL location, current branch or detached HEAD, linked worktree, shallow, and bare states.
- **Live graph:** local branches, remote-tracking branches, commit-pointing tags, and HEAD; 200-commit cursor pages with original parent relationships. Remote information reflects locally stored refs, including those updated by background fetch.
- **Working changes:** when there are changes, a distinct graph entry attached to HEAD opens the right-side file list and commit composer. It groups staged, unstaged, untracked, and conflicted paths. A partially staged file can appear in both staged and unstaged lists. Right-click a file (or press **Shift+F10**) for stage/unstage, discard, copy path or name, open, reveal in the file manager, and add to `.gitignore`; **Discard all** reverts every unstaged change.
- **Real changes:** lazy file lists and Git-produced unified/side-by-side diffs, including rename/binary/mode metadata and explicit preview limits. Root commits compare against the empty tree; merge commits offer a parent selector.
- **Compare commits:** select a commit as base and another as target, then swap direction if needed. The heading explains how the base tree becomes the target tree.
- **Search/filter:** messages, authors/emails, full/prefix hashes, and reference labels across reachable history; optional branch, date, and literal-path scope. Matches are highlighted while nonmatching ancestry stays visible. Results are capped at 500 and explicitly labeled when truncated.
- **Refresh:** every five seconds while visible, on window focus, or manually. Coherence checks reject mixed history snapshots; selection and the viewport's commit/pixel anchor are preserved where available. No filesystem watcher is installed yet.
- **Background fetch:** approximately every five minutes while a tab is active and the app is visible. Fetch updates the selected remote's remote-tracking branches and graph; it does not move local branches, merge, pull, push, prune, or import tags. Fetches requiring new credentials fail without showing an unsolicited prompt.

## Repository tabs and action toolbar

Use **+** or **Open repository…** to add a native or WSL repository tab. Opening the same worktree again focuses its existing tab; different linked worktrees remain separate. Tabs show the branch, uncommitted-change indicator, and operation status. Left/Right/Home/End navigate the focused tab strip.

Each open tab retains its graph selection, scroll position, search filters, and commit draft while switching. Open locations and the active tab restore on restart; commit drafts also persist per worktree. Inactive tabs pause routine polling and refresh when activated. You can switch repositories while an operation runs; its result belongs to its original tab. A running operation keeps that tab open until completion.

The toolbar beneath the tabs stays available while inspecting history or working changes:

- **Pull:** fast-forward-only by default. Its dropdown also offers **Fetch only**, **Pull (merge)**, and **Pull (rebase)**. Pull requires a clean worktree; conflicts use the existing operation banner and editor.
- **Push / Publish…:** push the current branch to its configured upstream, or select a remote and destination branch to publish and set upstream. Push targets one branch and does not force updates.
- **Branch:** create or switch a branch. When commits are selected, the menu also offers the ordered cherry-pick workflow.
- **Stash…:** save tracked changes with an optional message and optional untracked files, then browse/apply/pop/drop stashes. Pop retains the stash when application conflicts.
- **Refresh:** update local repository state. Ahead/behind counts reflect locally known remote-tracking refs; fetching updates that information.
- **Git identity…:** inspect the repository-local and effective name/email, then explicitly apply a saved profile to this repository’s Git config. Linked worktrees share that local identity, including for commits made outside Gitty.

Explicit clone/fetch/pull/push allow browser sign-in through Git credential helpers, with native HTTPS/SSH prompts as a fallback. Background fetch never opens sign-in or password prompts. Gitty bundles a checksum-pinned portable Git Credential Manager (GCM), appended as an HTTPS fallback after existing helpers; an existing GCM configuration or an explicitly empty helper setting is respected. Gitty never changes global Git configuration. SSH uses your SSH agent. WSL uses its distribution's credential helpers (including Windows GCM configured through interop); native bundled GCM is not injected into Linux Git. Embedded HTTP(S) credentials are rejected for clone. Auto-fetch runs only for the focused tab: on open, on tab or window focus, and at most every five minutes.

**Settings → Integrations** connects GitHub.com, GitLab.com and Azure DevOps work/school accounts through browser device authorization. A manual access-token fallback also supports Bitbucket Cloud and Azure DevOps personal accounts. Provider accounts authorize Gitty's pull-request APIs independently of Git authentication, so expired provider tokens do not override working Git helpers. OAuth access/refresh tokens and manual tokens live in the OS credential store; only account metadata is stored in app data. See [authentication setup](docs/authentication.md) for publisher app registrations, self-hosted limitations, and native verification.

History reads, search, and inspection remain read-only. The **Working changes** graph entry opens staging and commit controls; graph and sidebar action controls provide explicit branch operations. The backend uses the installed Git with separate read/write command contracts and shell-free arguments. Missing objects, unsupported encodings, partial/promisor clones, and process limits return explicit errors.

## Stage, review, and commit

1. Open a desktop repository with working changes and select the **Working changes** entry at the top of its graph.
2. Select an unstaged or untracked file in the right panel to inspect its diff in the center pane, then use its **+** control or **Stage all**.
3. Review the **Staged** group. Use **−** or **Unstage all** to remove changes from the index without changing working files.
4. Choose **Commit as** (or **Manage profiles…** to save a name and email), enter a summary and optional description, then choose **Commit staged changes**. To replace HEAD instead, enable **Amend last commit** and review the last commit's message before submitting. Gitty refreshes status and history after either operation.

A partially staged file appears in both lists. File-level controls stage its remaining working changes or unstage its indexed changes. Renames are handled as both source and destination where required.

Discarding throws away unstaged work and cannot be undone. Right-click an unstaged or untracked file and choose **Discard changes…**, or use **Discard all** to cover the whole Unstaged list. A confirmation names the files first. Tracked files return to their staged content (so a partially staged file keeps its staged half) and untracked files are deleted from disk. Staged files are never discarded; unstage them first. If anything changed in the working tree after the confirmation opened, Gitty refuses and asks you to review again rather than discard something you have not seen. **Open file** and **Reveal** are desktop-only and Open refuses directories, executables and program or launcher files; neither is available for WSL repositories, and the browser demo disables them.

For modified regular text files, use **Stage hunk** in an unstaged diff or **Unstage hunk** in a staged diff. Both unified and side-by-side views support complete hunks. The backend validates the displayed diff fingerprint and builds the patch from Git's original bytes; stale previews require a fresh selection. Only the index changes, preserving working files and other staged edits. Gitty serializes its own writes; Git's index locks and patch validation also apply when external Git processes are active.

Hunk actions currently fall back to whole-file controls for new/deleted files, renames, binary files, mode changes, symlinks/submodules, and truncated or oversized previews. Line-level staging is not yet implemented. The browser demo currently offers history and illustrative diffs only.

Commit drafts and profile selections persist per repository/worktree and survive failed operations. Saved profiles live in Gitty's local settings; selecting one in **Commit as** affects Gitty commits without changing Git config. Use the toolbar’s **Git identity… → Apply to repository** to write that profile to the repository-local `user.name` and `user.email`, shared by linked worktrees and used by external Git clients. Gitty displays the effective identity separately when another setting overrides the local one. The default composer choice uses Git's configured identity. Amending preserves the original author and uses the selected profile as committer. Configured hooks and signing are honored. Failed or uncertain writes trigger a refresh; Gitty does not automatically retry a commit. Bare repositories, unresolved conflicts, and in-progress Git operations produce explicit errors. A failed refresh blocks further writes in the composer until repository state can be refreshed.

Amend supports message-only rewrites and staged changes. It never includes unstaged content. HEAD, its symbolic ref, and the working-state fingerprint are revalidated under Gitty's mutation lock immediately before Git runs, so changes already visible at preflight reject a stale review. This serializes Gitty sessions, not external Git: an external process can still race before `git commit` acquires Git's own index/ref locks.

The commit inspector can also edit the **HEAD** commit's message in place (click the title or description). Only HEAD on a checked-out branch is offered, with no operation or conflicts in progress and no known remote-tracking ref containing it; other commits stay on interactive rebase. This runs a message-only amend (`--only`, no paths), so staged, partially staged and working-tree changes are untouched, and it refuses a commit that a remote-tracking ref already contains. Those refs are local data from your last fetch, not proof of what the remote has. A reason is shown when editing is unavailable, and the draft is kept if HEAD, the branch or eligibility changes while you edit. The demo workspace does not support it.

The browser demo does not modify repository files. Its commit history and diffs are synthetic; stage and commit controls are available in the desktop app.

## Branches, drag/drop, and conflicts

- Use **New branch…** or **Switch branch…**, or open a reference/commit's action menu with its button, right-click, or **Shift+F10**.
- Drag a branch onto the **outlined current branch** in the graph or sidebar to review a merge. Drag a commit subject onto that target to review a cherry-pick. Dropping opens the action dialog; execution follows an explicit review.
- Other actions include rebasing the current branch onto a selected source, editing up to 100 recent linear commits with a reviewed interactive rebase (reorder/drop/reword/squash/fixup), ordered multi-commit cherry-picks, comparison, and lightweight/annotated tags. Merge commits require an explicit cherry-pick mainline parent.
- The operation banner provides **Continue**, **Skip** where applicable, **Abort**, and conflict links. The built-in conflict editor shows full base/current/incoming versions, editable results, block acceptance, and whole-file/deletion choices. On Unix and WSL, symlink conflicts allow exact side selection or deletion; external edits are detected before saving.
- **Create pull request…** opens GitHub, GitLab.com, or Azure DevOps in your browser with source/base branches filled in. Choose a local source branch and remote; use the toolbar's **Push / Publish…** first when needed. Background fetch does not push your branch.

New graph mutations currently require a clean index/worktree, including no untracked files. Interactive rebase requires a native checkout and a loaded ancestor base; WSL interactive editing is still unsupported. Submodule conflicts with two gitlink sides permit an index-only pointer selection without changing the nested worktree. Rebase ranges containing merge commits and directory/file conflicts have explicit limitations. See [Milestone 3](docs/milestone-3.md) for the original graph workflow semantics.

## Settings and themes

Open the gear button or **Cmd/Ctrl+,** from either workspace, including the native welcome screen.

- **Presets:** Gitty Light/Dark, Gruvbox Light/Dark, Dracula, Nord, Catppuccin Latte/Mocha.
- **System appearance:** choose separate light and dark themes, or use one fixed theme.
- **Custom themes:** duplicate a preset, edit UI/diff/graph colors with a live preview and contrast feedback, then save a named theme. Import/export versioned local JSON; edits can be reset or canceled.
- **Editor preferences:** bundled code font, code size, line wrapping, and default unified/side-by-side diffs.
- **Commit profiles:** add, edit, or delete saved name/email identities for the desktop commit composer.
- **Workspace reset:** restore pane sizes. Resizing and settings persist across reloads and native/demo switching within the app.
- **Author avatars:** initials by default, or optional Gravatar images in history and commit details. Gravatar requests use a SHA-256 hash of the author's email; missing images fall back to initials.

## Explore the demo

- **Three repositories:** choose a synthetic repository from the titlebar’s **+** picker. Each has deterministic IDs and a fresh selection/loading state.
- **Interactive graph:** canvas paths and nodes underneath accessible, virtualized HTML commit rows. Click a row to inspect it; double-click or press Enter to reopen a closed inspector.
- **History with difficult topology:** 1,685 commits, 2,279 parent edges, nested branch synchronization, shared ancestors, multi-parent merges, and octopus merges. Local branches, remotes, and tags jump to their target commits.
- **Progressive history:** start with 240 commits; load another 240 at a time. Search and parent/reference navigation automatically reveal older targets. Existing positions and scroll offsets stay stable.
- **Whole-history search:** match subjects, authors, SHAs, branch names, and ref labels. Enter / Shift+Enter or the arrow buttons move between matches. Unmatched rows fade rather than disappearing, preserving topology.
- **Commit inspector:** author/date, full copyable SHA, navigable parents, and changed files. Selecting a file opens its illustrative unified or side-by-side diff in the center pane, with correct line numbers and added/deleted/context lines. File status covers additions, modifications, and deletions.
- **Adjustable workspace:** collapse either side pane; resize the inspector by dragging its divider or using arrow keys while it is focused. Inspector width and light/dark preference persist locally. Small windows use overlay panes.
- **Keyboard and accessibility:** labeled listbox/options, selected and positional metadata, visible focus, semantic buttons, keyboard-accessible tabs and divider, native modal focus containment, and reduced-motion support.

### Shortcuts

| Key                                 | Action                                |
| ----------------------------------- | ------------------------------------- |
| `/`                                 | Focus search (demo: also `Cmd/Ctrl K`) |
| `Cmd/Ctrl K` (desktop)              | Command palette                       |
| `Enter` / `Shift Enter` in search   | Next / previous match                 |
| `↑` / `↓` in history                | Previous / next commit                |
| `Page Up` / `Page Down` in history  | Move one visible page                 |
| `Home` / `End` in history           | First / last loaded commit            |
| `H`                                 | Jump to HEAD and clear search         |
| `Enter` in history                  | Open commit inspector                 |
| `Esc`                               | Clear search / dismiss menu or dialog |
| `?`                                 | Show shortcut reference               |
| `Cmd/Ctrl ,`                        | Open settings                         |
| `Shift F10` in native history       | Open selected commit actions          |
| `←` / `→` on inspector divider      | Resize by 20 px                       |
| `Home` / `End` on inspector divider | Minimum / maximum width               |

Single-letter shortcuts are disabled while editing an input. Sidebar reference names navigate; their action buttons and graph badges open explicit operations. `All branches` intentionally keeps the complete graph visible.

## Project map

```text
src/
  App.tsx                       Workspace state, search, navigation, layout controls
  styles.css                    Editorial typography, themes, responsive workspace
  components/
    HistoryGraph.tsx             Canvas renderer + virtualized accessible rows
    NativeWorkspace.tsx          Persistent native repository tabs and shared shell
    RepositoryPane.tsx           Per-tab sessions, search, paging, coherent refresh
    RepositoryToolbar.tsx        Pull/push, branch, stash and refresh controls
    NativeInspector.tsx          Commit files, parent selection, commit comparisons
    WorkingChanges.tsx           Right-side file staging, shared diff viewer, commit composer
    WorkspaceControls.tsx        Shared navigation, branding, pane resizing
    RepositoryPicker.tsx         Native/recent/WSL opening and clone form
    Sidebar.tsx                  Repository and reference navigation
    Inspector.tsx                Commit metadata, files, mock diff
  graph/
    layout.ts                    Pure renderer-independent appendable lane layout
    branchColor.ts               Name-based branch palette and first-parent color ownership
    layout.worker.ts             Off-main-thread layout for loaded history pages
    useGraphLayout.ts            Worker lifecycle and stale-page handoff
    layout.test.ts               DAG, lane, append-stability, clipping invariants
  model/
    types.ts                     Commit/ref/file models and provider boundary
    repository.ts                Native/WSL IPC data contract
    native.ts                    Typed data helpers and coherent snapshot loading
    workflow.ts                  Write/refresh lifecycle, explicit paths, saved drafts
    clone.ts                     Clone request, progress and cancellation state
    demoWorkflow.ts              Legacy in-memory demo operations (not mounted in current UI)
    demo.ts                      Deterministic synthetic history/provider
    diff.ts                      Small LCS diff for synthetic text fixtures
    diff.test.ts                 Diff reconstruction and line-number invariants
src-tauri/
  src/lib.rs                     Tauri command registration and blocking-worker dispatch
  src/repository.rs              Sessions, streaming history, status, search, metadata
  src/diff.rs                    Git change lists and structured patches
  src/mutate.rs                  Staging, unstaging, commits, write preflight checks
  src/clone.rs                   Safe cancellable native/WSL repository cloning
  src/hunk.rs                    Byte-preserving, fingerprint-checked hunk staging
  src/remote.rs                  Local sync metadata and explicit fetch/pull/push
  src/stash.rs                   Stash management with stable object identities
  src/process.rs                 Bounded shell-free process execution
  src/stream.rs                  Backpressured Git streams and lifecycle cleanup
  src/wsl.rs                     Windows distribution discovery and Linux browsing
  src/main.rs                    Cross-platform native entry point
  capabilities/default.json     Minimal main-window permissions
  tauri.conf.json                Tauri 2 app/build/bundle configuration
docs/architecture.md             Layout decisions, native Git and future WSL boundary
docs/milestone-2.md               Implemented exploration architecture and validation
docs/redesign-notes.md            Redesign, workflow lifecycle, browser validation
docs/milestone-3.md               Graph operations, conflict editor, settings and themes
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
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

Testing is local-only for now; pushes and pull requests do not trigger GitHub Actions checks. Run `npm run build` before the Rust checks so the frontend assets are available. For native compilation, run `npm run tauri -- build --no-bundle` on the target platform. Local checks validate the host platform; Windows and Linux runtime behavior require testing on those platforms. Automated cross-platform checks can be introduced in Azure DevOps when needed. The signed-release GitHub workflow remains manually triggered for release packaging.

The verification notes below record results at the time of each implementation; they are not current test totals or claims that every historical browser scenario still matches the redesigned UI.

### Historical: tabs, sync, stashes, hunk staging, amend, and clone verification

- **139 frontend tests** and **113 Rust tests** passed. Rust integration tests use real temporary repositories and local bare remotes, including selected-hunk commits, amend freshness/hooks/signing, clone cancellation/publication linearization, independent local object files and cleanup, stash conflicts, divergent pulls, and single-branch publication.
- All six Chromium smoke suites passed: `native`, `workflow`, `settings`, `tabs`, `operations`, and `hunks`. These use mocked Tauri IPC; coverage includes amend draft restoration and clone request/progress/open-tab behavior as well as retained per-tab state, active-only refresh, and operations completing or failing after switching tabs.
- Production TypeScript/Vite build, Rust checks, formatting, and Clippy passed. The integrated macOS debug app built with `npm run desktop:build -- --debug --bundles app`.
- Live remote authentication, packaged native GUI end-to-end interaction, and Windows/WSL/Linux runtime checks remain unverified.

These historical browser suites require an existing Playwright/Chromium installation; their UI expectations may need updating for the current workspace:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node src/components/tabs.smoke.mjs
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node src/components/hunks.smoke.mjs
```

### Historical: Milestone 3 verification

- **68 frontend tests** and **74 Rust tests** passed; Rust tests use real temporary repositories.
- Production TypeScript/Vite build, Rust formatting and Clippy checks passed.
- Native, workflow, operations, and settings Chromium smoke suites passed. Settings covers 13 scenario groups, including actual canvas theme colors, JSON round trips, pane reset/persistence, and narrow layouts.
- The integrated macOS debug `Gitty.app` bundle built successfully. Browser native coverage uses mocked IPC; packaged native GUI end-to-end and Windows/WSL/Linux runtime checks remain open.

### Historical: Milestone 2 verification

- **22 frontend tests passed**, including asynchronous refresh races and graph clipping invariants.
- **30 Rust tests passed on macOS**, using real temporary repositories, including a 100,005-commit fixture, merges, linked worktrees, conflicts, search semantics, process limits, read-only behavior, and cursor replay.
- Strict TypeScript/Vite production build and Rust check/format checks passed.
- Browser smoke passed for the demo and native workspace using mocked Tauri IPC, including refresh races, scroll preservation, comparisons, stale responses, and themes.
- A macOS debug application bundle built successfully with `npm run desktop:build -- --debug --bundles app`. Native GUI repository interaction, Windows/WSL, Linux runtime, signed installers, and screen-reader validation remain release checks.

### Historical: redesign and staging/commit verification

- **45 frontend tests** and **49 Rust tests** passed.
- TypeScript/Vite build, Rust check, formatting, and Clippy checks passed.
- Chromium history and workflow smoke checks passed, including draft persistence, partial staging, rename/copy paths, duplicate-write protection, failed refresh recovery, themes, and narrow layouts. Native browser checks use mocked Tauri IPC.
- The integrated macOS debug application bundle built successfully at `src-tauri/target/debug/bundle/macos/Gitty.app`. Native GUI end-to-end and other-platform runtime validation remain open.

### Historical: Milestone 1 verification

- Production frontend build and all **7 invariant tests passed** locally.
- Automated Chromium smoke checks passed for virtualization, row selection, keyboard navigation, HEAD jumps, searching into unloaded history, no-results search, diffs, pointer/keyboard resizing, sidebar toggling, both themes, dialogs, repository switching, incremental loading, and narrow layouts. No uncaught browser errors were observed.
- `npm audit` reported **0 vulnerabilities** at implementation time.
- At M1 implementation time, `tauri info` recognized the app/config and macOS/Xcode environment, but Rust/Cargo was unavailable. M2 now includes `Cargo.lock` and successful native compilation as recorded above.

## Scope and next steps

Repository tabs, native/WSL cloning, file/hunk/line staging, commits and amend, branch creation/switching, merge/rebase/interactive rebase/cherry-pick, tags, stashes, background fetch, explicit fetch/pull/push, regular-file and narrowly scoped symlink/submodule conflict resolution, and settings/custom themes are implemented in the desktop app. The browser demo currently focuses on synthetic history and diffs. Directory/file conflicts and merge-preserving rebase remain unsupported. Windows/WSL interactive authentication, native GUI runtime checks, Linux rendering, screen-reader auditing, and signed/notarized artifact installation still need platform verification; see [Milestone 4 runtime checks](docs/milestone-4-runtime.md).

The demo snapshot remains materialized once per repository. Native history uses a pinned Git walk with bounded read-ahead and a temporary replay spool, batched metadata reads, and lazy diffs. Canvas and DOM rendering are viewport bounded; an interval index accelerates edge visibility queries. Lane layout and edge-index construction run in a Web Worker and append loaded history pages without replaying earlier lane reservations. Subsequent pages transfer only new nodes/edges, resolved parent endpoints, and a typed edge index. Viewport drawing still occurs on the main thread; large-history browser interaction profiling remains open.

See the [M3 implementation](docs/milestone-3.md), [redesign and workflow notes](docs/redesign-notes.md), [M1 architecture record](docs/architecture.md), [M2 implementation](docs/milestone-2.md), and [backend details](src-tauri/BACKEND.md).
