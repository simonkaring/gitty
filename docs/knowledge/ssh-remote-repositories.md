---
type: Platform Boundary
title: SSH repository transport
description: How a repository on another machine is opened, which actions run remotely, and what stays refused.
status: draft
sources:
  - id: dto
    resource: ../../src-tauri/src/dto.rs
  - id: process
    resource: ../../src-tauri/src/process.rs
  - id: repository
    resource: ../../src-tauri/src/repository.rs
  - id: operations
    resource: ../../src-tauri/src/operations.rs
  - id: mutate
    resource: ../../src-tauri/src/mutate.rs
  - id: conflicts
    resource: ../../src-tauri/src/conflicts.rs
  - id: ssh
    resource: ../../src-tauri/src/ssh.rs
  - id: ssh-tests
    resource: ../../src-tauri/src/ssh_tests.rs
  - id: contract
    resource: ../../src-tauri/BACKEND.md
  - id: plan
    resource: ../../docs/ssh-remote-repositories.md
  - id: frontend
    resource: ../../src/model/ssh.ts
  - id: welcome
    resource: ../../src/components/Welcome.tsx
  - id: welcome-tests
    resource: ../../src/components/Welcome.ssh.test.tsx
  - id: readme
    resource: ../../README.md
---

# SSH repository transport

An SSH location (`{kind: "ssh", host, port?, user?, path}`) is a session whose Git runs
on another machine. Only `process.rs` knows this: it wraps every command as
`ssh … -- destination "sh -c '<script>'"`, one argument, where the script is
`env … git [-C path] …` with each word single-quoted. OpenSSH joins remote arguments
with spaces before the login shell splits them, so `sh -c` and its script have to be
quoted into a single word; separate arguments would run only `env`. The read and
mutation contracts therefore travel as remote `env` assignments rather than local child
environment, and `-c` overrides remain argv. Host, user, port and path are validated
wherever they are used, because `ssh` re-parses the remote command with the login
shell.[^dto][^process][^contract]

Policy is fixed, not user-tunable: `BatchMode=yes` and `StrictHostKeyChecking=yes`, no
identity, proxy or host-key options, no `known_hosts` writes, and the user's
`~/.ssh/config` authoritative for everything else. Multiplexing lives only on Unix
clients because Win32 OpenSSH lacks `ControlMaster`; its `ControlPath` is a quoted,
length-bounded hashed name per destination, because OpenSSH's `-o` parser splits an
unquoted value on spaces and a Unix socket path cannot hold OpenSSH's listener suffix.
Both the app-data directory and the temp fallback are measured, and multiplexing is
skipped when neither fits rather than handing OpenSSH an unusable path. The local askpass and editor
bridges cannot be forwarded, so remote fetch/push authenticate on that host and a write
needing a local prompt is refused instead of silently losing the prompt.[^process][^contract]

Git-only work (reads, staging, hunk/line staging, commit/amend, branches, merge, rebase,
cherry-pick, reset, stash, fetch/pull/push, worktree create/lock/prune) runs through the
existing contracts. The three capabilities that need the remote filesystem use one
remote command each: the operation-metadata scan (`find` plus `cat`), `git_dir_entries`
(`find`), and conflict read/write via the WSL Python helper — so conflict editing needs
`python3` on the host and returns `unsupportedConflict` without it. Open/reveal,
`.gitignore` appends, worktree move/remove, cloning into the host, and interactive
rebase/reword are refused with explicit codes; mutation locks include the destination so
identical paths on two hosts are independent sessions.[^repository][^operations][^mutate][^conflicts][^contract]

`ssh_test` runs `git --version` and, with a path, the same discovery `repository_open`
uses, mapping host-key, authentication, resolution, connection, missing-Git and
not-a-repository failures to distinct codes before a tab exists. `ssh_directories`
lists immediate subfolders with one `find` per directory (no `python3`), so the connect
form can browse instead of demanding an exact path; both run without a session and
store nothing. The connect form mirrors the target validation only for feedback; the
backend re-validates.[^ssh][^frontend][^welcome]

Verification is split: `ssh_tests.rs` runs the real workspace through a shell double of
`ssh` on Unix that joins remote arguments as OpenSSH does before a shell parses them
(quoting, remote environment, stdin framing, conflict helper, fetch/push against a local
bare remote, refusals, argv shape); `process.rs` unit tests cover the control path and
validate it with `ssh -G -F /dev/null`, which parses options without connecting or
reading the developer's SSH configuration (a malformed option fails the test). Authentication, host
keys, real networks and Windows clients are untested there and need a manual `ssh_test`
against a real host recorded as platform-scoped evidence.[^ssh-tests][^welcome-tests][^readme][^plan]

[^dto]: Location shape and target/path validation.
[^process]: Transport options, remote script construction, quoting, control socket.
[^repository]: Open validation, session root revalidation, mutation-lock key.
[^operations]: Remote metadata scan, merge message via `/dev/stdin`, editor refusals.
[^mutate]: Remote `find` for Git-directory entries and the bounded remote write environment.
[^conflicts]: Shared Python helper over WSL and SSH.
[^ssh]: Connection probe and failure classification.
[^frontend]: Location identity, display destination, form validation mirror.
[^welcome]: Connect form, test action, and refused-capability copy.
[^welcome-tests]: Mocked-IPC UI tests for the connect form and recents.
[^ssh-tests]: Shell-double integration coverage and its limits.
[^contract]: The authoritative IPC and transport contract.
[^readme]: User-facing prerequisites and the manual-verification note.
[^plan]: Design record, delivered scope, and deliberate deviations.
