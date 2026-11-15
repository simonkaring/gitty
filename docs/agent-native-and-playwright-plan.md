# Plan: agent-native Gitty and rendered-app testing

Status: shared `gitty-core` and `gitty-cli` extraction plus most native CLI/stdio
contracts are implemented. Desktop and browser acceptance remain incomplete;
the current delivery record below supersedes older status notes.

## 1. Outcome and scope

Make Gitty usable through three supported entry points:

1. The existing Tauri desktop application.
2. A console CLI and persistent headless stdio session for agents and scripts.
3. The existing React workspace in a browser, connected to real Rust behavior
   through a development/test-only bridge and exercised with Playwright.

All three reuse the same repository engine and mutation safeguards. Browser tests
must change real disposable Git repositories, not merely receive successful mocks.

“Agent-native” means discoverable operations, structured inputs/results, explicit
write scope, bounded execution, cancellation where supported, and observable
outcomes. It does not mean an embedded LLM or a replacement shell/test runner.

This plan does not claim that browser automation verifies the packaged desktop
webview, OS dialogs, keychain, credentials, signing, installation, or WSL/SSH runtime
behavior. Those remain separate verification boundaries.

## 2. Current implementation and constraints

Source inspection establishes the following starting points:

- [`Service`](../crates/gitty-core/src/repository.rs) already owns repository sessions,
  history cursors, recent repositories, and common-directory mutation locks.
  Existing Rust tests and the backend benchmark call it without opening a window.
- [`lib.rs`](../src-tauri/src/lib.rs) wraps service calls in Tauri commands and
  `process::request` deadlines. Startup also installs watchers, activity events,
  credential resources, SSH control storage, and askpass/editor bridges.
- [`Cargo.toml`](../src-tauri/Cargo.toml) and
  [`build.rs`](../src-tauri/build.rs) currently depend on desktop build machinery.
  The Linux target includes GTK. A new binary alone would not establish a
  desktop-dependency-free headless build.
- [`main.rs`](../src-tauri/src/main.rs) is the desktop executable and also handles
  askpass/editor helper modes. Its Windows release subsystem is GUI-oriented.
  Keep these existing launch/helper contracts intact; use a separate console CLI.
- [`native.ts`](../src/model/native.ts) selects demo or Tauri invocation by handle
  and mode. [`App.tsx`](../src/App.tsx) defaults browser execution to demo.
  Components also directly use Tauri detection, events, channels, and window APIs.
- [`package.json`](../package.json) has Vitest/build/Rust checks but no installed
  Playwright test dependency or standard E2E command.
  Existing [`*.smoke.mjs`](../src/components/native.smoke.mjs) scripts use an
  external Playwright installation and simulated Tauri internals.
- Mutation safeguards are action-specific, not a universal token mechanism.
  Graph operations carry expected state; worktrees have review/execute; discard,
  amend, conflicts, and hunk writes have their own fingerprints.
  See [the backend contract](../src-tauri/BACKEND.md) and
  [mutation safeguards](knowledge/git-mutation-safeguards.md).
- Existing common-directory mutexes coordinate sessions inside one service
  process, not independent CLI and desktop processes. The implementation now
  adds a native common-directory advisory lock for ordinary mutations; WSL/SSH
  processes remain outside that cross-process guarantee.

These findings are source inspection, not a fresh test run.

## 3. Target architecture

```text
Tauri commands --------------------------+
                                         |
CLI commands --> shared headless API -----+--> Rust repository engine --> Git/filesystem
                                         |
stdio session --> same headless API ------+
                         ^
                         |
test browser --> Vite test bridge --------+
      ^
      |
  Playwright
```

The test bridge is a Node/Vite adapter around a child stdio process. Do not add
an HTTP server to the production Rust engine. Production CLI access is local
process execution, not an always-running daemon.

Keep desktop-specific shell behavior in Tauri: window controls, native pickers,
webview scaling, URL/file opening, resource discovery, and desktop dialogs.
Reuse engine semantics rather than funneling every desktop call through JSON.

## 4. Phase 0 — inventory and contract decisions

### Deliverables

- Inventory every registered Tauri command, frontend invocation, event, and
  channel. Record the corresponding engine method and desktop dependencies.
- Classify each operation as read, local write, network action, credential action,
  desktop-only action, or test-harness action.
- Produce a parity table with CLI command, stdio method, required expectations,
  cancellation support, platform restrictions, and delivery phase.
- Define the initial supported native-local subset and later WSL/SSH/account
  additions explicitly. Unsupported operations must return a structured error,
  never silently fall back to demo behavior.
- Confirm how every helper is launched: moving code must not cause a CLI process
  to invoke itself expecting desktop-only askpass/editor modes.

### Acceptance

Every existing operation has a stated disposition. Initial scope is not presented
as full parity, and no supported GUI feature is removed to simplify headless use.

## 5. Phase 1 — separate engine from desktop host

### Deliverables

- Introduce a shared engine crate, preferably `crates/gitty-core`, and a small
  `crates/gitty-cli` console crate. Keep the existing Tauri package as the desktop
  host; avoid unnecessary restructuring of frontend code.
- Move repository behavior and DTOs without rewriting Git algorithms. Update
  `crate::` paths and tests mechanically where possible.
- Separate the Tauri parts of askpass/editor from reusable operation behavior.
  Use concrete callbacks or small boundary types only where multiple hosts need
  them; do not introduce a general plugin framework.
- Preserve `process::request`, subprocess limits, environment filtering,
  cancellation, tree termination, and tracing at every public request boundary.
- Make engine initialization explicit: data directory, credential/helper policy,
  SSH control directory, event sink, and host capabilities.
- Use isolated CLI/headless state by default so inspecting a repository does not
  rewrite desktop recents or account preferences.
- Headless builds must not require Tauri, GTK, a display, frontend assets, or
  `tauri-build`. Existing desktop checks retain their frontend-build prerequisite.

### Cross-process write coordination

- Add a shared OS-backed advisory mutation lock keyed by canonical repository
  common-directory identity, including linked worktrees.
- Select a maintained cross-platform file-lock implementation if the supported
  Rust standard library lacks it. Do not use stale-prone “lock file exists” logic.
- Retain short registry locks and action-specific freshness checks. Revalidate
  after acquiring the write lock, not before it.
- Define native, WSL, and SSH scope separately. A local host lock cannot claim to
  coordinate Gitty instances on other machines. External Git still relies on
  Git's own locks and remains a concurrent actor.
- Keep background fetch and commit-graph job coordination consistent with their
  existing separate contracts rather than serializing all activity globally.

### Acceptance

- Engine tests run without a window or desktop dependencies.
- Desktop behavior and existing helper modes remain intact.
- Two independent processes cannot overlap ordinary Gitty mutations for the same
  local repository, including linked worktrees; unrelated repositories proceed.
- Process death releases the advisory lock. External-Git races still fail closed
  where existing expectations require it.

## 6. Phase 2 — CLI and persistent agent protocol

### CLI surface

Proposed examples:

```sh
gitty-cli capabilities --json
gitty-cli status --repo . --json
gitty-cli history --repo . --limit 50 --json
gitty-cli diff --repo . --path src/App.tsx --json
gitty-cli stage --repo . --path src/App.tsx
gitty-cli commit --repo . --message-file message.txt --json
gitty-cli serve --stdio
gitty-cli doctor --json
```

- Provide readable default output and a stable `--json` mode.
- Accept complex structured input via file or stdin to avoid shell quoting
  problems. Accept messages/content through files or stdin; never require secrets
  on the command line.
- Separate stdout results from stderr diagnostics. Preserve existing `{code,
  message}` domain errors; add a versioned envelope and documented exit categories.
- Require explicit paths for staging; empty input never means “all.”
- Describe commit scope accurately: a normal commit consumes the entire current
  index, including unrelated already-staged work. Never imply it commits only the
  paths named in a preceding stage command.
- `doctor` reports dependencies and available capabilities, not credentials or
  speculative claims that a platform works.

### Persistent stdio mode

- Use versioned, line-delimited JSON requests/responses with IDs and a distinct
  event envelope. Reuse existing command names/DTOs where practical.
- Keep handles, cursors, and session-scoped reviews inside the running process.
  One-shot commands open/use/close a session; a cursor from an exited process is
  not usable in another invocation.
- Expose capability discovery and machine-readable argument/result schemas.
  Prefer deriving schema from Rust DTOs if that avoids a second handwritten
  contract; keep this one source of truth and test dispatcher coverage.
- Bound input lines, output messages, concurrent requests, event queues, and
  sessions. Reject invalid/unknown methods and malformed arguments explicitly.
- Run blocking operations off the input reader so search cancellation and
  shutdown can be processed while work is running.
- Preserve cancellation semantics per operation. Do not claim a timed-out write
  was rolled back or retry it automatically.
- On EOF or shutdown, stop watchers/jobs and release sessions, processes, streams,
  helper files, and locks. Test broken pipes and parent termination.
- Document protocol version negotiation and reject unsupported major versions.

### Safe mutation UX

- Reuse each action's existing expected-state/fingerprint contract.
- For one-shot destructive workflows, emit a review document containing exact
  action, target identity, expectations, and relevant warnings. Execution must
  revalidate it. Do not persist in-memory handles as portable authority.
- Keep worktree review tokens in the persistent session unless a separately
  designed portable review format is introduced.
- No universal `--yes` that bypasses stale-state or backend checks.
- Return enough result/state information to reconcile uncertain outcomes; do not
  convert partial success into a generic failure that encourages retries.
- Start noninteractive: operations needing credentials/editor interaction return
  an explicit unsupported/interaction-required response or use an explicitly
  selected, bounded host policy. Later add typed prompt/reply events with scoped
  request IDs, cancellation, provenance, deadlines, and secret redaction.
- Git hooks/signing may execute user code and must retain existing semantics.
  Headless mode is not a sandbox for untrusted repositories.

### Acceptance

An agent can discover the API, inspect a repository, review and execute supported
writes, and verify results without parsing prose or opening the desktop app.
Malformed requests, stale state, missing identity, hooks failing after a write,
and protocol shutdown have focused executable tests.

## 7. Phase 3 — browser transport without fake Tauri

### Deliverables

- Add a small frontend host boundary for invocation, event subscription, progress,
  and capabilities, initially centered on `src/model/native.ts`.
- Support three explicit modes: desktop, synthetic demo, and real-backend test.
  Preserve handle-based routing when changing modes or closing old sessions.
- Update `App.tsx` so a deliberately configured test host renders the real
  repository workspace rather than automatically selecting demo.
- Audit direct Tauri imports in `NativeWorkspace`, `RepositoryPane`,
  `AskPassDialog`, `EditorDialog`, `WindowControls`, integration settings, and
  scaling code. Separate “real repository backend available” from “native window
  available”; do not fake `window.__TAURI_INTERNALS__`.
- Route repository events and clone progress through the host boundary. Native
  window operations stay desktop-only; browser fixture selection is explicit.
- Keep activity logging and refresh/watch fallback behavior observable in browser
  mode. Do not add test sleeps or bypass application refresh logic.

### Test bridge security and lifecycle

- Implement only in a development/test Node entry point, not the production
  frontend build or packaged application.
- Bind to loopback on an allocated port and require a per-run secret for every
  command/event connection. Check Origin and Host; no permissive CORS.
- Prefer same-origin Vite proxying and a bounded event stream. Do not place the
  secret in URLs, screenshots, traces, or logs.
- Have the harness create and register disposable repository roots. Enforce
  allowed operations and fixture IDs server-side before dispatching commands.
- Canonicalize and validate repository, common-dir, and destination paths; refuse
  symlink/junction escapes and linked repositories pointing outside fixture roots.
  Apply this to clone/worktree destinations as well as initial open.
- Reject WSL, SSH, arbitrary remote URLs, account/keychain access, native external
  actions, and arbitrary process execution in the initial test profile.
- Network tests use only harness-created local bare remotes and controlled Git
  protocol configuration; never contact a developer's configured origin.
- Isolate app data, Git config, identity, hooks, signing configuration, and browser
  storage. Create fixtures from scratch, not from the developer's working tree.
- Stop the bridge and child process on teardown. Delete only harness-owned
  fixture directories; preserve diagnostic artifacts on failure.

### Acceptance

Playwright opens a real fixture repository in the normal React workspace through
the bridge. Invalid authentication, origins, methods, and out-of-root paths are
rejected, and a normal production build cannot enable this bridge.

## 8. Phase 4 — supported Playwright suite

### Tooling and developer workflow

- Add `@playwright/test` as a development dependency and a root Playwright config.
- Add scripts such as `test:e2e`, `test:e2e:ui`, and `test:e2e:headed`.
- Add an interactive `dev:e2e` harness that stays alive for an agent or developer.
  Print a safe browser URL, fixture identifiers, backend version, and artifact
  directory. Keep authentication material out of terminal output.
- The harness starts Vite and the headless process, waits for explicit readiness,
  and owns shutdown. Reuse the same launcher in automated and interactive modes.
- Install Chromium explicitly; make platform prerequisites and browser download
  instructions reproducible. Use WebKit/Firefox selectively later.
- Store tests in `tests/e2e`, fixtures/helpers alongside them, and ignored output
  in `test-results`/`playwright-report`.
- Use one isolated repository and browser context per mutating test. Start with
  few workers; increase only when fixtures and process isolation prove reliable.
- Use accessible roles/names for interactions. Add stable test IDs only where
  graph/virtualization structure has no suitable semantic locator.
- Wait for visible state or specific events, not arbitrary delays. Disable E2E
  retries initially so flaky behavior is not disguised.

### Initial test order

| Priority | Scenario | Independent verification |
| --- | --- | --- |
| P0 | Open fixture, show refs/history/status, inspect commit and diff | Compare displayed OIDs/files with raw Git |
| P0 | Stage/unstage a selected file, then create a commit | Check index, commit tree, HEAD and preserved working files |
| P0 | Partial hunk/line staging with unrelated staged content | Compare exact index and working-file bytes |
| P0 | Review discard, externally change file, confirm stale refusal | Check new bytes survive; then test fresh explicit discard |
| P0 | External commit/file edit while UI is open | Wait for normal watcher/poll refresh; assert graph/status update |
| P1 | Search, selection, pagination, pinned history and refresh | Compare fixture commits and ensure no duplicate/mixed generations |
| P1 | Branch create/switch, merge, conflict resolution and continue/abort | Check refs, sequencer state, index and recovery files |
| P1 | Worktree review/create/remove and stale/occupied safeguards | Check Git worktree metadata and filesystem preservation |
| P1 | Fetch/push against disposable local bare remote | Inspect remote refs; confirm no unintended ref updates |
| P1 | Write failure and uncertain outcome | Confirm useful UI state and no automatic mutation retry |
| P1 | Tabs, keyboard navigation, context menus, dialogs and focus return | Assert DOM/accessibility behavior and selected repository identity |
| P2 | Narrow layouts, light/dark themes, long paths and split diffs | Targeted screenshots plus semantic assertions |
| P2 | Large history/working-file sets | Check virtualization, scroll/reveal and bounded loading behavior |

Use raw Git and filesystem reads as the oracle for writes, rather than verifying
the engine exclusively through its own status endpoint. Control fixture timestamps,
author identity and input bytes; derive expected OIDs instead of hardcoding them.

### Failure evidence

- Capture screenshots, browser errors, sanitized backend stderr, protocol request
  IDs, and a fixture-state summary on failure. Traces are currently disabled:
  Playwright archives authenticated request headers, and this harness does not
  yet have a verified secret-redaction pipeline.
- Fail on unexpected page errors and relevant failed requests. Maintain only
  narrow, justified exclusions.
- Pin screenshot browser/OS/fonts/viewport and disable animation for visual
  checks. Use screenshots as supplementary evidence, not proof of Git safety.
- Keep logs bounded and secrets redacted. An artifact is not automatically safe
  to publish just because it came from a test run.
- Migrate useful existing smoke scenarios incrementally. Retain mocked tests for
  deterministic races/errors that are hard to provoke with real Git, and label
  their evidence separately.

### Acceptance

A clean checkout can install documented prerequisites and run one command that
builds/starts the necessary hosts, tests the rendered app against real fixtures,
reports artifacts, and exits without orphaned Git/server/browser processes.

## 9. Phase 5 — parity, packaging, and platform evidence

- Expand CLI/stdin protocol coverage according to the Phase 0 parity table:
  branch deletion, stashes, conflicts, worktrees, remote operations, clone,
  identity and history acceleration are delivered. Provider token/device-OAuth
  methods are now available only under explicit account policy; SSH discovery
  and Windows WSL discovery are exposed through shared validated core APIs.
  Continue with any remaining desktop host behaviors that do not inherently
  require a window, while retaining native dialogs and OS shell actions as host-only.
- Preserve native/WSL/SSH refusals and capability differences. Add real platform
  checks only where an execution environment exists; distinguish shell doubles
  from real network/authentication evidence.
- Test release CLI binaries on Windows, macOS, and Linux, including spaces,
  Unicode, leading-dash and newline paths permitted by the existing contract.
- Ship/document the CLI as a console executable without changing desktop
  repository-path launch or askpass/editor behavior. Test upgrade and protocol
  compatibility before calling the CLI API stable.
- Maintain a small actual-desktop verification checklist for IPC permissions,
  window behavior, OS file pickers, keychain/auth prompts, editor integration,
  webview differences, and process cleanup.
- If automating desktop later, evaluate current Tauri/WebDriver support on each
  target platform in a separate proof of concept. Do not call browser Chromium
  tests “Tauri desktop E2E.”
- Keep all checks local initially, consistent with the repository policy. Future
  Azure DevOps automation can invoke the same scripts without a second harness.

## 10. Delivery slices and gates

| Slice | Contents | Gate before proceeding |
| --- | --- | --- |
| A | Inventory, engine extraction, explicit host initialization | Desktop checks remain valid; engine builds without desktop stack |
| B | Read-only CLI, capabilities, stdio sessions and lifecycle | Real-repository protocol tests; bounded input and clean shutdown |
| C | Cross-process write locks and first guarded writes | Independent-process race tests; stale and ambiguous outcomes covered |
| D | Frontend host boundary and restricted test bridge | Real browser repository read; negative bridge security tests |
| E | Playwright open/diff/stage/commit/stale-write vertical slice | UI assertions plus raw-Git verification and failure artifacts |
| F | Remaining mutation/protocol parity and broader E2E suite | Published capability matrix matches tested behavior |
| G | Platform packaging and native-runtime checklist | Actual per-platform evidence, with unsupported coverage explicit |

The first useful milestone is B: agents can inspect without a window.
The first complete milestone is E: an agent can change the app, launch its real
browser workspace, act through the UI, inspect evidence, and verify Git outcomes.
Do not postpone this vertical slice until every command has CLI parity.

## 11. Verification and documentation per slice

- Frontend changes: `npm test` and `npm run build`.
- Rust/IPC changes: build frontend first for the existing Tauri package, then
  `npm run check:rust`, `npm run test:rust`, and
  `cargo fmt --manifest-path src-tauri/Cargo.toml --check`.
  Add explicit engine/CLI checks that need neither frontend build nor display.
- New CLI/protocol behavior: focused process-level tests on real temporary repos.
- Bridge changes: authentication/root-restriction/lifecycle tests.
- Rendered behavior: focused Playwright tests and captured failure evidence.
- Record commands, host platform, outcomes, and skipped/conditional scope; do not
  translate mock or browser coverage into native-runtime claims.
- Update README setup/commands, `src-tauri/BACKEND.md` contracts, `AGENTS.md`
  workflows, and affected knowledge concepts in the same implementation patches.
  Add an agent/headless concept and index entry once behavior actually exists.
- Assess existing in-progress changes before editing manifests or moving files;
  preserve unrelated user work.

## 12. Explicit non-goals

- No always-on daemon, production HTTP API, or remote agent control plane.
- No MCP adapter until a real consumer needs more than CLI/stdin access.
- No embedded general-purpose command runner; npm, Cargo, and Playwright remain
  the supported build/test tools.
- No duplicated Git implementation in TypeScript or the CLI.
- No blanket bypass of validation, hooks, signing, stale checks, or platform limits.
- No broad rewrite of React components or immediate migration of every old smoke
  test. Move only the host boundaries and test scenarios needed for each slice.

## 13. Implementation record

### CURRENT completion checklist — 2026-11-15

- Parent verification: `npm test` passed (501 tests), `npm run build` passed,
  `cargo fmt --all -- --check` passed, and documentation local-target/whitespace
  checks passed. Packaging, benchmark-selection, and Git-environment isolation
  Node tests passed (four tests).
- The parent serial workspace run passed the five CLI unit tests and ten
  real-binary tests, then exposed one Windows watcher false-positive (307 core
  passed, one failed, two ignored). Luna traced it to directory-only
  `Modify(Any)` notifications and fixed their classification. Its subsequent
  full serial core run passed (309 tests, two ignored); the parent independently
  reran the watcher suite (12/12 passed). Conditional WSL tests without the
  distribution variable are not real-WSL execution evidence.
- Parent `npm run package:cli` passed, including release compilation and
  host-binary doctor/capabilities checks. Artifact:
  `src-tauri/target/cli-artifacts/gitty-cli.exe`, version `0.1.0`, target
  `x86_64-pc-windows-msvc`; its adjacent manifest records SHA-256. This is not
  signed-installer or native GUI runtime evidence.
- After the final EOF/admission/late-registration cancellation fixes, the parent
  reran `cargo test -p gitty-cli -- --test-threads=1`: all seven unit tests and
  eleven process tests passed, including real parent termination and clone
  cancellation on EOF without publication. The parent rebuilt and repackaged
  the release CLI afterward, including its doctor/capabilities smoke checks.

- Extracted shared Rust engine and standalone CLI crates. Native, WSL, and SSH
  repository locations are supported where the platform permits. Native watcher,
  Git activity, clone progress, and opt-in prompt events use bounded envelopes:
  `{"version":1,"eventId":N,"event":{"kind":"…","data":{…}}}`.
- Default headless network/editor policy is noninteractive. Prompt replies and
  system-account access require explicit host opt-ins. Portable review/execute
  binds canonical repository identity and reviewed state; worktree execution
  reacquires and compares its token before writing.
- Account-enabled capabilities now include token connection and device OAuth
  start/poll/cancel. Secrets enter through JSON stdio only, OAuth does not open
  the returned verification URL, and methods are omitted unless `--accounts-file`
  explicitly enables the system credential store. SSH discovery is available
  through validated core APIs; Windows-only WSL discovery reports missing
  `wsl.exe` as `wslUnavailable`.
- Capabilities derive the method list and nested request/response schemas from
  typed request DTOs. Dispatch validates with the same DTOs, including nested
  unknown-field rejection. Portable review inputs are validated before a
  document is emitted; execution revalidates repository identity/state while
  holding the same common-directory mutation guard as the action. A nested
  mutation on that thread reuses, rather than reacquires, the guard.
- CLI prompt scripts dispatch to shared core helper clients. Clone progress data
  includes `operationId`; the event schema describes it, and askpass context is
  nullable as emitted. Remote actions without an explicit prompt guard disable
  credential UI, terminal prompts, and interactive SSH fallback.
- Stdio shutdown now stops event delivery, cancels clone/search/prompt work,
  closes sessions before joining workers, and returns on broken output even when
  stdin remains open. Accepted writes are not retried or reported as rolled back.
- Sources: [`AgentService`](../crates/gitty-core/src/agent.rs),
  [`protocol registry`](../crates/gitty-core/src/protocol.rs),
  [`stdio host`](../crates/gitty-cli/src/main.rs),
  [`backend contract`](../src-tauri/BACKEND.md), and
  [`host matrix`](knowledge/agent-command-matrix.md).
- Packaging reports `npm run tauri -- build --no-bundle` passed for the Windows
  release target. `@tauri-apps/api` and Tauri CLI are aligned at 2.12.4 with
  Rust `tauri` 2.12.5; the earlier desktop-build version-guard failure is
  superseded. Do not infer runtime, keychain, SSH-server, WSL, macOS, or Linux
  verification from this Windows compilation.
- Earlier Windows verification, before the watcher classification follow-up:
  `cargo test --workspace -- --test-threads=1` passed (306 core tests, 5 CLI
  unit tests, 9 real-binary process tests; 2 core tests ignored),
  `npm run check:rust`, `cargo fmt --all -- --check`, and `git diff --check`.
  A prior default-parallel run had one transient askpass helper failure; an
  isolated test and that then-current serial rerun passed.
- After the provider/host parity additions, focused `agent_tests` policy coverage,
  protocol schema/dispatch-validation tests, CLI capability process test,
  `npm run check:rust`, `cargo fmt --all -- --check`, and `git diff --check`
  passed on Windows.
- The parent's later independent serial workspace run passed all 5 CLI unit and
  10 real-process tests, but core had 307 passed, 1 failed, 2 ignored. The failure
  was `watcher::tests::ignored_paths_and_object_writes_are_quiet`. Windows
  notification tracing captured `Modify(Any)` on `.git/hooks`, `.git/info`,
  `.git/logs`, and nested log directories; those directory-only events were
  classified as refreshes and coalesced with the ignored/object writes.
- Fixed the Windows-only classification narrowly: `Modify(Any)` for the Git
  directory itself and existing `hooks`, `info`, or `logs` directories is
  dropped; child entry notifications and file-level ref/index/config/unknown
  events remain refreshes. Unknown Git metadata directories remain conservative.
- After the fix, Windows `cargo test -p gitty-core -- --test-threads=1` passed
  (309 passed, 2 ignored, 0 failed; 704.51 seconds). The focused watcher suite
  passed all 12 tests, and the real ignored-path/object-write watcher test passed
  10 consecutive runs. `npm run check:rust`, `cargo fmt --all -- --check`, and
  `git diff --check` also passed after the final patch.
- Added real parent-death coverage in
  [`helper_process.rs`](../crates/gitty-cli/tests/helper_process.rs): the focused
  test passed, then the serial CLI suite passed (5 unit and 11 real-process tests).
- Stdio EOF/broken-output shutdown now stops admission and discards queued jobs,
  repeating cleanup every 25 ms until workers finish. A deterministic late-
  registration barrier test lives in [`main.rs`](../crates/gitty-cli/src/main.rs);
  real clone coverage verifies request and EOF cancellation without publication
  in [`helper_process.rs`](../crates/gitty-cli/tests/helper_process.rs). Serial
  CLI suite passed (7 unit, 11 process tests); workspace check, formatting, and
  diff checks passed after this fix.
- Final parent `npm run test:e2e` passed the environment-isolation regression and
  all 15 Chromium scenarios on Windows (1.8 minutes). This supersedes the earlier
  partial/failing browser runs. Coverage includes commit/index/file preservation,
  stale discard/hunk refusal, hook failure without retry, external refresh and
  search, branch creation/switching, merge conflict continue/abort, local bare
  fetch/push and clone, reviewed worktrees, virtualized working sets, and
  keyboard/theme/split-diff/narrow-layout checks.
- The browser host forwards authenticated bounded repository/activity/clone
  events, establishes subscriptions before starting watchers, and refreshes after
  reconnect or queue loss. Per-test fixture release waits for owned work before
  closing sessions and removing the sandbox. Independent clones and linked
  worktrees retain explicit root/common-directory ownership mappings.
- Browser evidence is not native Tauri IPC/webview, keychain, live authentication,
  installer, signing/notarization, or macOS/Linux/WSL/SSH runtime verification.
  Those observations remain in the
  [platform checklist](agent-native-platform-verification.md), not implied by the
  implementation or host test passes.

### Historical delivery notes (superseded; not current status)

- Added a source-linked command/host inventory covering every entry in
  `generate_handler!`, emitted events, clone channel, startup/shutdown, and
  current CLI/stdio dispositions. Provider/keychain, window, picker, WSL/SSH
  discovery, prompt replies, and clone progress are explicitly host-only or
  unsupported; the local mutation lock does not claim to span WSL/SSH hosts.
- Expanded `AgentService` and capability discovery for status/state/snapshot,
  search/cancel, identity, diff/history, guarded discard/hunk/amend/conflict/
  operation/branch/worktree/stash/remote/commit-graph actions. Added a bounded
  JSON one-shot `request` command, `doctor`, parameter schemas, and explicit
  desktop/noninteractive policy. Stage remains explicit-path; normal commit
  consumes the whole index.
- `serve --stdio` now uses four worker threads and an eight-request bounded
  queue, correlates out-of-order replies by request ID, handles search cancel
  inline, returns `serverBusy` on saturation, caps encoded output at 4 MiB, and
  stops request admission on EOF/broken output, discards queued jobs, cancels
  active clone/search/prompt work, closes sessions, and joins workers. Tests cover
  output bounds, queue discard, response IDs before EOF, and broken pipes.
  Event envelopes, clone progress, and prompt/reply transport remain open;
  parent-death integration coverage is verified above.
- Fixed Windows clone argument paths that used a `\\?\` verbatim path Git for
  Windows could not create; native filesystem paths remain canonical. Worktree
  lookup now compares canonical/verbatim path aliases. Test fixtures explicitly
  disable autocrlf, encode Windows paths safely in Git config, use Windows-valid
  filename variants, and keep large ignored-path fixtures within host path
  limits. The watcher test permits one conservative `.git/info` metadata event,
  while still failing on repeated snapshot-triggered refresh loops.
- Added a rendered real-Git stale-discard scenario: external bytes survive a
  stale review, a refresh is required, then a fresh explicit discard is checked
  against raw Git/filesystem state. Fixture state is reset before each test;
  unique repository roots per test and the remaining P0/P1/P2 matrix are still
  needed.
- Added partial-line staging with unrelated pre-staged content and a stale-hunk
  refusal after external bytes change; assertions inspect both the index and
  worktree directly with Git/filesystem reads.
- **Not delivered:** `crates/gitty-core` and a separate CLI package. The engine
  still lives in the Tauri package and pulls desktop build machinery, so a
  headless `cargo build` without Tauri/GTK remains unavailable. Provider/account
  and clone workflows, protocol event envelopes, prompt provenance, remote
  WSL/SSH CLI parity, release target packaging, broad Playwright scenarios, and
  process-parent-death coverage are also still open. No native desktop runtime,
  keychain, SSH server, macOS, or Linux runtime was available here.

### Historical parent review

- Reviewed the CLI dispatcher, frontend host routing, bridge authorization and
  fixture boundary, harness environment, and shared mutation-lock path. Review
  findings were returned to Luna and corrected: inherited Git environment
  overrides, unbounded cross-process lock waiting, credential-bearing traces,
  flattened one-shot JSON errors, unbounded message-file reads, incomplete
  preservation assertions, and discarded backend diagnostics.
- Independently reran on Windows after those corrections: `npm run test:e2e`
  (one environment-isolation regression and two browser tests), `npm test`
  (500 tests), `npm run build`, focused `mutation_lock_tests` (three tests),
  and `git diff --check`; all passed. The full Rust suite was not rerun during
  parent review; its previously reported failures remain unresolved.

### Historical delivered subset

- Added `gitty-cli` in the existing Tauri crate. One-shot commands include
  native-local status/history/stage/unstage/commit plus guarded JSON requests;
  `serve --stdio` offers a wider restricted repository-method set. Requests
  are strict UTF-8 and capped at 1 MiB, with four active workers, eight queued,
  and structured domain errors. This is not a desktop-dependency-free engine
  build or complete protocol parity.
- Added native common-directory advisory locks around `Service::mutate`. The
  Windows subprocess lock test verifies exclusion and release; a separate
  mutation-path test verifies nonblocking `repositoryBusy` and that a contended
  mutation closure never runs. WSL/SSH locks and races with external Git are not
  covered by this lock.
- Added an explicit browser-test host and dev-only authenticated Vite bridge
  backed by the CLI stdio process. The harness creates a disposable repository
  with isolated Git config/home and hooks, strips inherited Git/editor/askpass
  environment overrides, and limits bridge access to that fixture. A Node
  regression poisons Git directory/index/object/config variables and proves
  actual fixture writes stay isolated from a decoy repository. Playwright
  stages and commits through the rendered workspace and independently checks
  the index, changed HEAD, expected parent, tree, exact file bytes, and preserved
  untracked content with raw Git. Negative checks cover missing auth, hostile
  origin, unsupported methods, and out-of-fixture paths. Traces are disabled
  because they would persist authorization headers; screenshots and bounded
  backend stderr diagnostics remain.
- Verification on Windows: `npm test` (73 files / 500 tests), `npm run build`,
  `npm run check:rust`, `cargo fmt --check`, `npm run test:e2e` (4 browser tests
  and environment isolation), and `npm run test:rust` (298 passed, 2 ignored;
  300 lib tests plus 2 desktop helper and 5 CLI tests) passed. The full Rust run
  initially exposed one Windows nonblocking socket read; explicitly restoring
  blocking mode on accepted test sockets fixed it. The focused regression and
  subsequent complete suite passed.

### Historical omissions (recheck against the current checklist above)

- Phase 0 source-linked inventory is present at
  [`agent-command-matrix.md`](knowledge/agent-command-matrix.md); frontend usage
  and some setup/event boundaries should continue to be audited as code changes.
- Phase 1 engine crate extraction, desktop-dependency-free headless build, and
  WSL/SSH cross-process locks.
- Phase 2 remaining omissions include an event envelope, clone progress,
  prompt/reply transport, and portable one-shot review documents. Parent-death
  integration coverage is verified above. Method schemas are currently
  capability metadata rather than DTO-derived full schemas.
- Broader Phase 3–5 host capability/event routing, fixture-isolated browser
  roots per mutating test, many P0/P1/P2 scenarios, platform packaging, and
  native runtime evidence.
- Slices A, F, and G remain outstanding; B, C, D, and E are partial. The E
  browser slice now covers commit, stale discard, partial-line staging, stale
  hunk refusal, and bridge security, but not the broader P0/P1 scenario matrix.
