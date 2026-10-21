# SSH repository transport

Status: **implemented through phase 2, plus conflict editing from phase 3.** The
transport, read sessions, pure-Git writes, operation-metadata reads and the remote
conflict helper exist and are covered by the shim suite described below. Worktree
move/remove, `.gitignore` appends, cloning into an SSH destination, open/reveal, and
interactive rebase/reword remain refused; see [Delivered](#delivered) for the exact
line between implemented and refused. [src-tauri/BACKEND.md](../src-tauri/BACKEND.md)
is the contract for the IPC surface.

## Delivered

- `RepositoryLocation::Ssh { host, port?, user?, path }` with target and path validation
  on every use, not only at open (`src-tauri/src/dto.rs`).
- The transport arm in `process::command_inner`, `ssh_test`, and the connect form with
  remote folder browsing (`ssh_directories`, one `find` per listing).
- Reads, staging, hunk/line staging, commit/amend, branches, merge/rebase/cherry-pick,
  tags, stashes, fetch/pull/push, and the operation-metadata scans.
- Conflict read/write through the existing Python helper over SSH.
- Explicit refusals: `repository_open_path`, `repository_reveal_path`,
  `repository_ignore_path`, worktree move/remove, cloning into an SSH destination,
  interactive rebase/reword, and any mutation that would need a local askpass or
  editor bridge.

Deviations from the original plan, all deliberate:

- Connection multiplexing is enabled only on Unix clients. Win32 OpenSSH does not
  implement `ControlMaster`, so Windows pays one connection per command; the code says
  so rather than failing.
- `.gitignore` appends are refused instead of being reimplemented through the helper.
  The append itself is trivial; the symlink-safe, append-only guarantee is not, and a
  refusal is honest about a capability that does not exist yet.
- Worktree *creation* still works over SSH (it is a Git command and the destination is
  checked with one remote `test`). Only move/remove are refused, matching the fact that
  they also rewrite recent-location state locally.

## Goal

Open a repository that lives on another machine, over SSH, and use the same
workspace: graph, working changes, staging, commits, branch operations, fetch and
push. Git keeps running on the remote host, next to the working tree, exactly as it
does today for native and WSL locations.

The driving scenario is a home machine running an agent (for example opencode)
while you review from a laptop over Tailscale. You see the agent's commits *and its
uncommitted work*, and you decide when anything is pushed. Gitty's job is to be the
review surface; it is not a remote IDE and it does not broker the agent.

## Non-goals

- No remote editor, terminal, file browser, or `open`/`reveal`.
- No credential or askpass bridging over SSH. The remote host authenticates its own
  Git remotes with its own helpers and keys.
- No cloning *into* an SSH destination, and no agent/automation surface. A remote
  repository is opened by a person.
- POSIX remotes only. OpenSSH for Windows defaults to `cmd.exe` for exec, which
  breaks `env`, quoting and `-C`; detect and refuse with an explicit message.

## Location model

`RepositoryLocation` gains one variant (`src-tauri/src/dto.rs`):

```rust
Ssh {
    host: String,          // ~/.ssh/config alias, hostname, or tailnet name
    port: Option<u16>,     // None = ssh default / config
    user: Option<String>,  // None = ssh config / current user
    path: String,          // absolute POSIX path to the working tree or bare repo
}
```

Tagged `<kind: "ssh">` on the wire, matching the existing camelCase enum. The
frontend mirrors it in `src/model/repository.ts`; tab persistence
(`src/model/tabs.ts`) and `recent-repositories.json` already store the location, so
no schema work is needed beyond accepting unknown kinds gracefully. `read_recent`
should skip entries it cannot deserialize today, so a downgrade degrades to a shorter
recent list instead of `recentData` failure.

Validation, for every value that reaches argv:

- `host`/`user`: `[A-Za-z0-9._-]`, non-empty, must not start with `-`. Never accept
  from a repository file or a URL inside the repo.
- `port`: 1–65535.
- `path`: absolute POSIX, no NUL, no newline, no `..` segment after the leading `/`.
  The session's `root` comes from `git rev-parse --show-toplevel` on the remote and is
  re-validated the same way before it is used in later commands.

## Transport

`process.rs` is the only place that learns about SSH. `command_inner` gains a third
arm next to `Native` and `Wsl`:

```
ssh [-T] [-x] [-o BatchMode=yes] [-o StrictHostKeyChecking=yes]
    [-o ConnectTimeout=10] [-o ServerAliveInterval=15] [-o ServerAliveCountMax=3]
    [-o ControlMaster=auto] [-o 'ControlPath="<app-data>/ssh/<16-hex>"']
    [-o ControlPersist=60]
    [-p <port>] [--] [<user>@]<host>
    <one ASCII octal-encoded script envelope>
```

The POSIX script is generated locally, but never exposed literally to the login
shell. It is decoded only inside explicitly invoked `sh`:

```
env GIT_...=... LC_ALL=C git -C <quoted path> --no-pager -c ... <quoted args...>
```

Rules that follow from that:

- **Encode before the login shell.** OpenSSH joins remote arguments before the login
  shell parses them. Nested POSIX single quoting was unsafe for newline-containing
  values under tcsh. The outer envelope now contains only fixed ASCII syntax and
  octal bytes, decoded by POSIX `printf` inside `sh`, without using stdin. Inside
  that decoded script each argv/environment word is POSIX single-quoted. Expanded
  command size is bounded for Windows/Unix, with explicit refusal rather than truncation.
  Real sh/tcsh execution is covered by process tests when those shells are installed;
  fish runtime remains unverified.
- **Environment is part of the remote command.** SSH does not forward the host
  environment, so the read contract's `GIT_OPTIONAL_LOCKS=0`, `LC_ALL=C`,
  `GIT_NO_LAZY_FETCH=1`, `GIT_NO_REPLACE_OBJECTS=1`, `GIT_TERMINAL_PROMPT=0`,
  `GIT_LITERAL_PATHSPECS=1`, `GIT_PAGER=cat` and the per-commit identity overrides
  become `env` assignments in the script. The mutation contract keeps the user's
  locale and omits `GIT_OPTIONAL_LOCKS`, exactly as the WSL arm does. Host `GIT_*`
  variables are never forwarded; `cmd.env` stays empty for this arm.
- **`-c` overrides still work** because they are argv (`core.fsmonitor=false`,
  `maintenance.auto=false`, `gc.auto=0`, `protocol.allow=never`, …). Read-only
  suppressions (`diff.external=`, `core.quotePath=true`) apply the same way.
- **Connection reuse is not optional.** A refresh is roughly ten sequential Git
  launches; today WSL shows that process launch dominates. `ControlMaster` +
  `ControlPersist` turns all of them into channels on one connection. The control
  socket lives under app data with user-only permissions, one 16-hex name hashed from
  the destination. Two details are load-bearing: the value is double-quoted for
  OpenSSH's `-o` parser (macOS app-data paths contain a space, and an unquoted value
  fails with `keyword controlpath extra arguments at end of line`), and the path stays
  within 88 bytes so OpenSSH's `.XXXXXXXXXX` listener suffix still fits `sun_path`
  (104 bytes on macOS); an over-long home directory falls back to a short per-process
  random private temp directory. Existing directories must be owned by the effective
  user, non-symlink directories with no group/other permissions. The fallback is
  measured too, and when neither fits the command
  runs without multiplexing instead of failing. `ssh -G -F /dev/null` validates the
  option without connecting or reading the developer's own SSH configuration.
- **`BatchMode=yes` and `StrictHostKeyChecking=yes` are fixed.** Gitty never writes a
  trust decision. If the host key is unknown or authentication is non-interactive
  impossible, the command fails and the connect dialog explains it ("run `ssh <host>`
  in a terminal once, or add the host to ~/.ssh/config"). No `accept-new`, no
  `ssh-keyscan` auto-import.
- **`~/.ssh/config` stays authoritative** for keys, `ProxyCommand`, `IdentityAgent`
  and Tailscale/`tailscale ssh` setups. Gitty adds options only for the policies above
  and never overrides the user's identity or proxy settings.

`git_external_mutation_command` (used by clone) must refuse `Ssh`, since SSH locations
only ever surround an existing repository.

## Capability matrix

Works through the existing Git-command contracts without new remote filesystem work:

| Area | Notes |
| --- | --- |
| Open / state / status / snapshot | Discovery and status are plain Git; fingerprint key gains an SSH form keyed by destination + `common_dir` |
| History, search, commit details, diffs | Read contract only; `--stdin` tip lists and `cat-file --batch` framing already avoid argv limits |
| Stage / unstage / discard tracked / hunk and line staging | Index-only; the patch is built from Git's own bytes and fed on stdin |
| Commit / amend | Messages already go through `git commit --file=-`, i.e. the SSH channel |
| Branches, tags, merge, rebase, cherry-pick, reset, stash | Git operations; merge messages must switch to `--file=/dev/stdin` like WSL |
| Fetch / pull / push / background fetch | Run remotely; authentication is the remote's own |
| Worktree listing | `git worktree list` output only |

Needs a remote filesystem path (see below): conflict versions and saving, operation
metadata under the Git directory, worktree move/remove, and every editor that Git
launches. Untracked discard needs no helper: it is `git restore` plus `git clean`, which
already run inside Git. `.gitignore` appends stay refused (see [Delivered](#delivered)).

Refused over SSH in the first release:

- `repository_open_path`, `repository_reveal_path`, `repository_ignore_path` — no remote
  desktop, and no remote `.gitignore` writer (the helper could append, but the
  symlink-safe append-only guarantee has not been re-proven over SSH).
- Interactive rebase editing and reword flows until phase 4 (see "Editors").
- Worktree move/remove; `prune` stays read-only.
- Clone to an SSH destination; the recent-location picker still opens repositories.

Each refusal returns a normal `{code, message}` error (for example
`unsupportedLocation`), not a UI-only disable, so command-palette and keyboard paths
cannot bypass it. The frontend additionally hides or disables the controls with a
reason, consistent with how WSL differences are presented.

## Operation metadata

Two helpers read the Git directory directly and need an SSH branch, modeled on the
existing WSL implementations:

- `Repository::metadata` (`src-tauri/src/operations.rs`) — `MERGE_HEAD`,
  `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `REBASE_HEAD`, `rebase-merge/*`, `sequencer/*`.
- `Repository::git_dir_entries` (`src-tauri/src/mutate.rs`) — in-progress and lock
  checks.

WSL already batches both into one remote listing plus one `cat` per present file
(`metadata_scan_args`, `find_outcome_acceptable`). Reuse that shape with
`ssh … sh -c 'find …'`: one scan per request, one `cat` only for names that exist,
`exit 1` from entries vanishing under a concurrent Git tolerated. No `test -e` per
name — that would be a connection round trip per file.

## Remote filesystem helper

Conflict editing is the only place that needs real file reads and writes, and its
current native implementation is deliberately conservative (capability-rooted
directory handles, symlink refusal, exact path validation, external-edit detection by
fingerprint). Reproducing that privilege model over a shell is not worth it.

Reuse the WSL design verbatim: `ssh … python3 -c '<helper>'` with the same JSON +
bytes stdin protocol, one request per read or write. Consequences to state plainly in
the UI and docs:

- The remote needs `python3`; without it conflict editing, untracked discard and
  `.gitignore` appends return `unsupported` with that reason (the repository still
  opens, the graph still works).
- The helper receives the session root and an exact validated relative path, refuses
  `.git` segments, symlinked ancestors and paths outside the root, and returns the
  working snapshot it validated so the caller's fingerprint check still applies.
- Writes are `mutationUnverified` on a failed channel, like the WSL path.

Untracked discard and ignore-path go through the same helper rather than `git clean`/
`ssh rm`, so the existing fingerprint and path-confinement guarantees carry over
unchanged.

## Editors

The native editor bridge is an HTTP server on the laptop's loopback; a remote Git
cannot reach it, and forwarding it would create a remote-to-local execution path. So:

- Merge messages already avoid the editor (`--file=/dev/stdin`).
- Commit and amend messages are stdin-only.
- Interactive rebase and reword (phase 4) upload instead of bridging: create a remote
  temp file with the reviewed todo or reword message, set `GIT_SEQUENCE_EDITOR` or
  `GIT_EDITOR` to a single-use `sh` script that copies the uploaded file over the file
  Git passes, and remove the temp files afterwards. `GIT_SEQUENCE_EDITOR` accepts a
  command word, so `sh -c '…'` quoting pattern must be tested explicitly; the plan is a
  small uploaded script rather than a long inline command.
- Until phase 4, rebase continuation reports the same explicit
  "not supported, finish in Git" reason that WSL interactive rebase uses.

## Timeouts, refresh, fetch

- Reads keep the 30 s per-command / 60 s per-request budget. `ConnectTimeout=10`
  bounds a sleeping host; `ServerAlive*` bounds a dropped connection. A timeout is
  reported as a timeout, never as an empty repository.
- Same-session parallelism stays: with `ControlMaster` each command is a channel on
  one connection, which is cheaper than a new TCP+auth round trip.
- Routine refresh (5 s) is 30 s for SSH sessions (`SSH_REFRESH_INTERVAL`) and still
  refreshes on window focus and on demand. A 5 s poll over a tailnet would generate
  continuous remote process launches for no benefit. The 30 s figure is a conservative
  default, not a measurement; revisit it on the real path.
- Background fetch is **off** for SSH sessions (`backgroundFetchAllowed`); explicit
  fetch/pull/push and the fetch on open still run. There is no opt-in yet: a sleeping
  host should not be probed on a timer, and adding a per-repository switch is polish,
  not part of the delivered line.
- `GITTY_TRACE_PROCESS=1` keeps printing launch timing for the local `ssh` process,
  which is the number that matters here; it must not print remote credentials (it
  never prints environment values today).

## Security

The new capability is "run Git on a host the user configured". Keep it that narrow:

- No value from inside a repository (config, hooks, remote URLs, `.git` files) may
  select a host, port, user, path, executable or SSH option.
- `--` ends option parsing locally; host/user/port/path validation rejects leading
  `-` and control characters. A crafted path cannot become `-oProxyCommand=…`.
- No password, passphrase or key material is read by Gitty. Authentication is the
  user's SSH configuration; failures are surfaced, not retried with weaker settings.
- Host keys must already be trusted. Gitty never edits `known_hosts`.
- Remote commands are `env`, `sh -c`, `git`, `find`, `cat`, `python3` and the uploaded
  editor script — no interpolation of repository content into a shell word, only
  validated paths and Git arguments, all quoted.
- The activity log records destination and operation, never SSH options or output that
  could contain key material. Credential redaction already applies.

## Frontend

- `Welcome.tsx` gains **Open over SSH**: host, optional user/port, remote path, a
  **Test connection** action, and **Browse…** (`ssh_directories`) so an exact path is not
  required. Browsing starts at `/` or the current absolute path, lists immediate
  subfolders, and writes the chosen folder into the path field.
- New command `ssh_test({host, port, user, path?}) -> {gitVersion, name?}` runs
  `env git --version` and, when a path is supplied, the same discovery `repository_open`
  uses (returning the repository name). Errors stay specific: `hostKeyUnknown`,
  `authRequired`, `connectTimeout`, `gitMissing`, `notARepository`, `invalidPath`.
- Recent repositories show the destination (`you@home:~/code/thing`) and reconnect from
  the recent list; the tab strip shows a small SSH label.
- `src/model/paneLayout.ts` and workspace code keep working unchanged.
- Controls that cannot work over SSH reuse the existing "not available for this
  repository" presentation with a reason string; no new dialog patterns.
- Activity log entries name the operation and host, e.g. `fetch · home`.

No new Tauri capabilities are needed: the command set is unchanged apart from
`ssh_test`, and the webview gains no direct network access.

## Testing

Implemented today: unit tests in `process.rs` for quoting, environment-name validation,
destination/path rejection, the hashed and length-bounded control path, and `ssh -G`
option parsing; `src-tauri/src/ssh_tests.rs` with the shim below, which joins remote
arguments the way OpenSSH does before running them through a shell
(open/read/diff, stage and commit, amend, merge conflict resolved through the helper,
fetch and push against a local bare remote, refusals, validation, `ssh_test` argv
shape, and literal spaces/apostrophes/metacharacters/newlines/stdin across the join). The real-host suite in the last bullet is **not** written yet; `ssh_test` is the
manual path for verifying a real tailnet host, and its outcome must be recorded as
platform-scoped evidence rather than general coverage.


- **Unit tests** (`process.rs`): destination and path validation; quote/espace
  round-trip for values containing `'`, `"`, spaces, `$(…)`, newlines and leading `-`;
  argv assembly assertions that the remote script is a single argument and that no
  user value lands in an option position.
- **Shim integration (the important one).** A POSIX `ssh` double: a script that strips
  the options Gitty adds, joins the remaining remote arguments with spaces the way
  OpenSSH does, and hands that string to `sh -c`. Exposed
  through a test-only override (`GITTY_SSH_EXECUTABLE`, compiled under `cfg(test)`),
  it lets the existing real-temporary-repository tests — staging, hunk selection,
  commit/amend freshness, merges, conflicts, stash, fetch/pull/push against a local
  bare remote — run end to end through the SSH transport. This is the only way to
  cover quoting and stdin framing without a second machine, and it must be a real
  shell path, not a mocked `Command`.
- **Real remote, gated.** `GITTY_SSH_TEST_HOST=<alias>` runs a small suite against a
  reachable host (open, snapshot, history page, status, diff, stage/commit round trip,
  conflict read/write when `python3` exists), single-threaded like the WSL suite. This
  is the check that can never run in CI today and must be recorded as
  platform-scoped verification, not as general coverage.
- **Frontend**: Vitest UI tests with mocked IPC for the connect form (validation,
  error mapping, tab restore of an SSH location) and for the disabled-feature reasons.
- Existing suites must stay green; a new refusal path must not change native/WSL
  behavior. `npm run check:rust`, `npm run test:rust`, `npm run build`, `npm test`,
  and `cargo fmt --check` apply as usual.

## Delivery phases

1. **Transport and read sessions.** `dto` variant, `process` arm (quoting, env,
   control connection, host-key policy), `repository::open` validation, fingerprint
   key, frontend location type and connect dialog, `ssh_test`. Delivers: open, graph,
   search, diffs, working-tree view of the agent's uncommitted work. No writes.
2. **Writes that are pure Git.** Stage/unstage/hunk/line, commit/amend, branch ops,
   merge/rebase/cherry-pick/tags/stash, fetch/pull/push; operation-metadata scans
   (`metadata`, `git_dir_entries`); merge message via `/dev/stdin`. Delivers the full
   "review and commit" loop.
3. **Remote filesystem helper.** Python helper over SSH for conflict read/write,
   untracked discard and `.gitignore` appends; explicit refusals everywhere else,
   including worktree move/remove and open/reveal.
4. **Editors.** Uploaded single-use editor scripts for interactive rebase and reword;
   remove the temporary WSL-style limitation for SSH if the quoting holds up.
5. **Polish.** Refresh/fetch cadence after measurement, connection failure UX
   (sleeping host, changed key, agent forwarding guidance), recent-location editing,
   docs (`README`, `BACKEND.md` section, knowledge concept) and platform verification
   notes.

Rough size: phases 1–2 are the bulk (a dozen Rust modules plus DTOs and the workspace
location plumbing, comparable in shape to the WSL work); phase 3 is one helper plus
four call sites; phase 4 is the riskiest per line of code.

## Risks and open questions

- **Latency is the acceptance test.** If a refresh over a tailnet costs more than a
  second or two with `ControlMaster`, the feature needs batching (fewer, larger
  commands) before it is pleasant. Measure on the real path first; do not tune from
  LAN numbers.
- **Remote shell variance.** `sh` may be a stripped container shell without `find`
  features used by the metadata scan; detect once per session and fall back to
  `git rev-parse --git-path` + `git cat-file`.
- **`python3` on the remote.** Conflict editing depends on it. If that is unacceptable,
  phase 3 must grow a POSIX helper, which reopens the byte-safe transport question
  (`base64 -d` vs `-D`).
- **Windows remotes** are refused. Supporting them means a different exec model
  (`cmd.exe`, no `env`), and it is out of scope until someone needs it. A connected
  Windows OpenSSH host is detected and reported as `posixShellRequired`, which points
  at WSL; a host with no SSH server reachable at all is `connectFailed`.
- **Concurrent writers.** The remote may hold an agent process writing the same
  working tree. Git's index locks and Gitty's stale-fingerprint checks already cover
  this; the UI should say so rather than implying the view is authoritative.
- **Pushes run on the remote host, as the user Gitty's SSH session authenticates as.**
  That is the right default for review workflows, but it is not a permission boundary:
  if the agent runs as the same Unix user with the same credentials, it can push too.
  Gitty does not and cannot revoke that; separating the agent's user/home or using a
  read-only deploy key plus branch protection is still the enforcement layer.
- **Downgrade.** An older build reading a recent-repositories file containing `ssh`
  entries should skip them rather than fail; decide whether that tolerance belongs in
  this change or a separate one.
