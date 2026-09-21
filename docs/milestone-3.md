# Milestone 3 — graph workflows and personalization

## Delivered workflow

Native history and sidebar actions support branch creation/switching, merge into
the checked-out branch, noninteractive rebase, ordered cherry-picks, lightweight
and annotated tags, comparisons, and browser PR links. The current branch's
default action is creating a branch; another branch defaults to merging it into
the current one. Operation reviews show readable source/destination, fast-forward
policy, and cherry-pick order/mainline, with raw request details in a disclosure.

Branch drag/drop opens a merge review only when the target is the current branch.
Commit subjects carry a separate stable-object-ID payload and open a cherry-pick
review on that target. Actual refs/commits are checked; graph lanes and the working
tree pseudo-row never identify mutation targets. Canceling a drop/review is
read-only. Drag edge scrolling supports virtualized history. Action buttons,
right-click, and keyboard actions provide equivalent access.

New graph operations require a clean index/worktree, including no untracked files.
They use Git's configured hooks/signing and never force a branch switch or silently
stash. The browser demo retains its staging/commit simulation; new graph actions
there explain that a desktop repository is required.

## Operation lifecycle

`src/model/operations.ts` is the additional typed IPC contract. `operationFlow.ts`
brackets coherent history/status reads with operation-state snapshots. Review
captures HEAD, HEAD ref and an operation fingerprint once. Execute submits that
captured request unchanged; the Rust service revalidates it under the existing
common-directory mutation lock.

The fingerprint covers refs, index/status, operation metadata and conflicted
working bytes. A write is followed by awaited refresh even on errors or uncertain
outcomes; refresh failure blocks further writes until a successful refresh.
Requests from old repository sessions cannot publish into the active session.

Operation state is discovered from Git, including operations started externally
or found after reopening a repository. A banner exposes conflict paths and
Continue/Skip/Abort where supported. Merge cannot skip. Rebase abort/skip refuses
non-conflicted local changes it cannot distinguish from unrelated work, including
some staged resolutions; the error explains why it cannot safely proceed.

Switch/merge protect ignored files from overwrite. Rebase/cherry-pick preflight
their destination and replay trees, including queued continuation steps. These
checks and Gitty's locks do not make repository changes atomic against external
editors or Git processes.

## Conflict editor

`ConflictEditor.tsx` reads complete base/current/incoming blobs and working results
using the dedicated conflict API, never the possibly truncated display diff.
It provides editable text, block navigation, accept-current/incoming/both, exact
whole-file sides, explicit deletion, and mark-working-file-resolved. Missing sides
map to explicit deletion requests. Operation-aware labels explain rebase sides.

Dirty buffers survive polling. External file/stage/context changes block stale
saves and offer explicit reload. Failed rereads also block saving. Text editing
preserves unchanged line endings and final-newline state; binary side selection
retains exact blobs and modes. Failed staging after a saved result is reported as
an uncertain write and reconciled.

Supported editor paths are regular files, including ordinary add/add,
modify/delete, and independent regular-file rename paths, up to 16 MiB per
blob/file. Symlinks, submodules, directory/file conflicts, unsupported encodings,
and missing/unsafe parent paths produce explicit explanations. WSL conflict
filesystem access uses a fixed Python 3 helper and requires Python 3 installed.

Rebase ranges containing merge commits are rejected rather than flattened.
Apply-backend rebases, patch application, bisect and unknown sequencers remain
unsupported. Non-pick interactive rebase steps require Git to continue.

## PR links

`pullRequest.ts` generates links locally for github.com, gitlab.com (including
nested namespaces), and Azure DevOps HTTPS/SSH/legacy URLs. It preserves explicit
source/base direction and encodes branch names. Unsupported/self-hosted providers
and credential-bearing URLs return explanations.

The dialog offers a remote and base branch, and explains that locally known
remote refs do not prove the latest commits are published. Source branches must
be local. The user-triggered native opener accepts validated HTTPS URLs; Gitty
does not authenticate, fetch, push, or submit a PR in the background.

## Settings and themes

`SettingsProvider` in `main.tsx` owns one typed, versioned store above both native
and demo modes. The gear button and Cmd/Ctrl+, open a native modal dialog while
leaving the workspace mounted. Settings include appearance, code font/size,
diff wrapping/layout, workspace-size reset, and shortcut information.

Eight bundled presets: Gitty Light/Dark, Gruvbox Light/Dark, Dracula, Nord,
Catppuccin Latte/Mocha. Fixed and live system appearance are supported, with
independent light/dark choices. Semantic tokens drive both CSS and canvas graph
lanes, selection, merges and HEAD markers.

Custom themes can be duplicated, named, edited with live whole-app preview,
saved/canceled/reset, renamed/deleted, and imported/exported as versioned JSON.
The editor provides color pickers, hex fields, graph/diff/control samples, and
contrast feedback. JSON validates all tokens, IDs, names and colors, with 100 KB
input and 30-custom-theme limits; it does not accept arbitrary CSS or assets.

Preferences live at `gitty:settings` in local storage. Existing light/dark and
pane-width keys migrate when no new store exists. Corrupt stored data is not
overwritten until an explicit change/retry. Storage failures preserve session
preferences and expose retry. Pane resizing uses the shared store so reset and
mode switching update mounted panes without losing sibling widths.

## Verification

- 68 frontend tests across 9 files: topology/diffs, asynchronous snapshots and
  write lifecycle, operation eligibility/order/conflict text, settings/theme
  validation, and provider links.
- 74 Rust tests using real temporary repositories, including conflicts and
  continuation/abort, stale reviews, ignored-file preservation, hooks/signing,
  binary contents, linked-worktree locks and symlink rejection.
- TypeScript/Vite build, Rust formatting and Clippy passed.
- Four Chromium smoke scripts passed: native exploration, working changes,
  graph operations/conflicts, and settings (13 scenario groups).
- `npm run desktop:build -- --debug --bundles app` built the integrated macOS app.

Run browser checks with an existing Playwright installation:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node src/components/native.smoke.mjs
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node src/components/workflow.smoke.mjs
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node src/components/operations.smoke.mjs
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node src/components/settings.smoke.mjs
```

Browser native scenarios mock IPC. Real Git behavior is verified separately by
Rust integration tests; packaged native GUI end-to-end, OS browser launching,
Windows/WSL/Linux runtime, signing/notarization and screen-reader validation
remain open. No release-readiness claim is implied by the successful build.
