# Gitty frontend redesign & staging workflow

## Design decisions

- Editorial workspace inspired by the inspected GitButler client direction: warm paper surfaces, warm charcoal dark mode, teal emphasis, clear borders, and restrained 3–5px rounding.
- Locally bundled **Fraunces** headings, **Inter** interface text, and **Geist Mono** hashes/diffs. No font CDN or external runtime asset dependency.
- 15px default interface text; 14px commit/file rows; 13px hashes, meaningful file metadata, and diffs; 24–28px workspace headings. Graph text and canvas use the same `ROW_HEIGHT = 48` constant.
- History stays graph-first. Search and branch scope are primary; native date/path filters live in a disclosure. Search preserves ancestry. Existing paging, comparison direction, parent inspection, shallow boundaries, and unreachable commit inspection remain available.
- Shared brand, view navigation, keyboard/pointer pane resizing, diff renderer, and working-change composer connect native and demo views. Sidebar and inspector widths persist locally. Both panes can be toggled from the header; narrow layouts use overlays and a visible workspace view switcher.
- Working changes uses the full workspace: categorized files at left, diff and a full-width commit composer at right. Narrow layouts stack files, diff, and composer with scrolling rather than reducing type size.

## Write contract and lifecycle

The documented TypeScript contract is in `src/model/repository.ts`:

```ts
repository_stage({ handle, paths: string[] }): Promise<void>
repository_unstage({ handle, paths: string[] }): Promise<void>
repository_create_commit({ handle, message: string }): Promise<{ oid: string }>
```

`repository_commit` remains a read operation. Errors use `{ code, message }`. Every file/all action sends explicit, deduplicated repository-relative paths; empty arrays never mean “all.”

- Stage all includes unstaged and untracked paths; unstage all includes indexed paths. Conflicts are excluded from both operations. Per-file controls operate on the selected category's entire path.
- Unstaging an indexed rename includes its original and destination paths. Staging remaining edits on that rename targets only the destination. Copies never implicitly include their source's unrelated edits; displayed file counts remain independent of expanded command paths.
- Partially staged files appear in both staged and unstaged groups. Their previews compare HEAD → index and index → working tree respectively. Staging the unstaged entry stages the remainder; unstaging the staged entry removes its indexed changes.
- The native workspace takes a synchronous mutation lock before waiting for any current read. Polling/paging cannot start another read while a write is in progress. The lock stays held through the required post-write refresh.
- Every attempted write is followed by an awaited coherent repository snapshot refresh, including failed writes. Forced refresh also invalidates inspection when fingerprints happen to match.
- Read failures keep the last coherent snapshot, show an error, and block subsequent writes until an explicit refresh succeeds. No ambiguous commit is automatically retried.
- Session epochs prevent late responses from publishing into a different repository. Diff previews additionally use request scopes and effect cancellation to reject late results after category/file/revision changes.
- Subject and body persist synchronously on edit, keyed by worktree root plus native/WSL location and distribution rather than ephemeral handle. Storage failure retains an in-memory draft and is identified in the composer.
- Commit failure preserves the draft. A confirmed returned OID clears only the submitted draft; an older completion cannot erase a newer persisted draft. Confirmed commit + failed refresh is reported separately.
- Bare repositories and conflicted paths have explicit UI states. In-progress merges and other checks use backend errors; the frontend does not assume new backend state fields. No conflict resolution UI is provided.

The demo uses the same composer and diff UI with separate HEAD/index/working contents. Its simulated commits advance demo history and leave unstaged contents intact. Demo repository contents reset when reopened; draft persistence is independent of that in-memory simulation.

## Amend and clone follow-up

The native composer can explicitly amend HEAD. It loads the current message into
the amend fields without replacing the ordinary commit draft, supports message-only
or staged rewrites, and labels the history rewrite. The backend revalidates HEAD,
its symbolic ref, and the status fingerprint under the mutation lock. Hooks,
signing, refresh-on-every-outcome, uncertain-write handling, and the no-retry rule
remain unchanged; unstaged content is never included. The lock serializes Gitty
sessions, but external Git can still race after preflight and before `git commit`
acquires its own index/ref locks. The demo keeps amend disabled.

The repository picker also starts full native or WSL clones. Clone progress and
cancellation belong to `NativeWorkspace`, so closing the picker does not abandon
the operation. Success flows through the existing tab reducer and opens the new
location. The backend clones into an operation-owned temporary sibling, publishes
with no replacement, and cleans up only that temporary path on failure or cancel.
An atomic lifecycle transition decides whether cancellation or publication wins;
late cancellation is rejected and the UI returns to the running state. Local clone
objects are copied rather than hardlinked to the source.
Authentication is noninteractive and uses configured credential helpers or the
SSH agent; embedded HTTP(S) credentials are rejected.

## Files

- `src/styles.css`: replacement design system, layout, responsive behavior, local font imports.
- `src/App.tsx`, `src/components/Sidebar.tsx`: redesigned demo workspace, navigation, simulated staging/commit integration.
- `src/components/NativeWorkspace.tsx`: native workspace structure, grouped refs, filter disclosure, mutation serialization and awaited refresh.
- `src/components/WorkingChanges.tsx`: file categories/actions, request-scoped previews, composer, draft lifecycle, errors/progress, shared diff renderer.
- `src/components/WorkspaceControls.tsx`: shared brand, workspace navigation, accessible resizers, pane-width preferences.
- `src/components/HistoryGraph.tsx`, `src/graph/layout.ts`: warm graph palette and synchronized 48px rows.
- `src/components/Inspector.tsx`, `src/components/NativeInspector.tsx`: shared typography/diff presentation, native close control, updated copy.
- `src/model/repository.ts`, `src/model/workflow.ts`: command contract, write/refresh lifecycle, explicit path selection, durable drafts.
- `src/model/clone.ts`, `src/components/RepositoryPicker.tsx`: clone request/state contract and native/WSL clone form.
- `src/model/demo.ts`, `src/model/demoWorkflow.ts`: updated illustrative history and index-aware demo operations.
- `src/model/workflow.test.ts`: lifecycle, stale-session, draft durability, path selection, and demo partial-staging tests.
- `src/components/native.smoke.mjs`, `src/components/workflow.smoke.mjs`: browser integration checks.
- `package.json`, `package-lock.json`: three local Fontsource font packages.

## Current follow-up verification

- `npm test`: **139 tests passed across 13 files**.
- `npm run test:rust`: **113 tests passed** on macOS, including real-repository amend and local-bare-remote clone coverage.
- TypeScript/Vite build, Rust check, formatting, Clippy with warnings denied, and `git diff --check` passed.
- `npm run desktop:build -- --debug --bundles app`: **passed**, producing `src-tauri/target/debug/bundle/macos/Gitty.app`.
- All six Chromium smoke suites passed. After amend/clone coverage was added, `workflow.smoke.mjs` and `tabs.smoke.mjs` were rerun; they cover amend draft restoration and clone request/progress/open-tab behavior through mocked native IPC.
- Packaged native GUI interaction, live remote authentication, and Windows/WSL/Linux runtime behavior remain unverified.

## Original redesign verification

- `npm test`: **45 tests passed across 5 files**, including rename/copy command-path semantics.
- `npm run build`: **passed**, including TypeScript and production Vite bundling.
- `npm run test:rust`: **49 tests passed** on macOS. Real-repository coverage includes initial commits, partial staging, renames/deletions, unusual names, large stdin path batches/messages, hook and signing failures, locks, conflicts, and serialization across sessions/worktrees.
- Rust check, formatting, and Clippy checks passed.
- `npm run desktop:build -- --debug --bundles app`: **passed**, producing `src-tauri/target/debug/bundle/macos/Gitty.app` with the integrated frontend and backend.
- `native.smoke.mjs`: **passed** against a mocked native IPC service: state/status race, silent polling, paging, selection/scroll-anchor preservation, comparisons, stale diff rejection, unreachable commit inspection, theme persistence.
- `workflow.smoke.mjs`: **passed** in Chromium: native and demo flows; subject/body across reload; staged/unstaged preview semantics; explicit file/all paths; duplicate clicks; mutation lock through delayed refresh; merge errors; ambiguous commit with actual fixture HEAD movement; refresh failure/recovery; confirmed draft clearing; conflicts; bare repository; late working-file preview rejection; keyboard resizers; 390px viewport horizontal overflow check.
- Visually inspected screenshots of demo history and working changes in both themes, native history/working changes, and the narrow working view. Screenshot capture uses reduced motion to avoid capturing theme transitions halfway through.

Run optional browser checks with an existing Playwright installation:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node src/components/native.smoke.mjs
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node src/components/workflow.smoke.mjs
```

Set `SCREENSHOT_DIR` to an existing directory for workflow screenshots. This run used `/var/folders/z4/72jgz2h11qx8760vfrs3g0vw0000gn/T/opencode`, with `gitty-history-{light,dark}.png`, `gitty-working-{light,dark,mobile}.png`, and `gitty-native-{history,working}.png`.

### Verification limits

Browser native tests use a deterministic mocked Tauri IPC boundary, not a real desktop process. They verify frontend integration and race behavior; real Git execution is covered separately by the Rust suite. The macOS application bundle was built, but native GUI end-to-end interaction and Windows/WSL/Linux runtime validation remain open. The mutation-timeout outcome is unit-tested rather than exercised through a 120-second native timeout.
