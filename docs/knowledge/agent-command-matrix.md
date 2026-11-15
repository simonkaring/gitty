---
type: Reference
title: Agent command and host parity
description: Registered Tauri commands, events, channels, and current headless dispositions.
status: draft
sources:
  - id: tauri
    resource: ../../src-tauri/src/lib.rs
  - id: frontend
    resource: ../../src/model/native.ts
  - id: cli
    resource: ../../crates/gitty-cli/src/main.rs
  - id: engine
    resource: ../../crates/gitty-core/src/agent.rs
---

# Native command and host parity inventory

Source of truth: [`lib.rs`](../../src-tauri/src/lib.rs)'s `generate_handler!`,
command bodies, `setup`, `on_window_event`, frontend [`native.ts`](../../src/model/native.ts), plus direct
Tauri usages named below. CLI coverage is intentionally not implied by registration.

## Repository operations

| Tauri command | Kind / engine operation | CLI / stdio disposition |
| --- | --- | --- |
| `repository_open` | Local/WSL/SSH session open; `Service::open` | `repository_open` supports native, WSL (Windows), and SSH locations |
| `repository_close` | Session lifecycle; stop watcher | `repository_close`; stops the headless watcher and closes the session |
| `repository_recent` | Desktop recents | Desktop-only persistence; isolated CLI state, no recents |
| `repository_state` | Session state | `repository_state`; one-shot `request` |
| `repository_snapshot` | Read snapshot | `repository_snapshot`; one-shot `request` |
| `repository_status` | Read status | `repository_status`; one-shot `status` / `request` |
| `repository_operation_state` | Read sequencer/conflict state | `repository_operation_state`; one-shot `request` |
| `repository_history` | Read/paginate/search history | `repository_history`; one-shot `history` / `request` |
| `repository_search` | Read search; cancellable | `repository_search`; one-shot `request`; stdio cancellation can be sent while search runs |
| `repository_cancel_search` | Cancellation | `repository_cancel_search`; stdio dispatches cancellation inline |
| `repository_commit` | Read commit detail | `repository_commit`; one-shot `request` |
| `repository_commit_edit_eligibility` | Read amendment policy | `repository_commit_edit_eligibility`; one-shot `request` |
| `repository_branch_relation` | Read ancestry relation | `repository_branch_relation`; one-shot `request` |
| `repository_diff_files` | Read file diff list | `repository_diff_files`; one-shot `request` |
| `repository_diff` | Read one diff | `repository_diff`; one-shot `request` |
| `repository_git_identity` | Read identity | `repository_git_identity`; one-shot `request` |
| `repository_set_git_identity` | Guarded local config write | `repository_set_git_identity`; one-shot `request` |
| `repository_stage` / `repository_unstage` | Explicit-path index writes | stdio methods and one-shot `stage` / `unstage` / `request` |
| `repository_stage_hunk` / `repository_unstage_hunk` | Fingerprinted partial-index writes | stdio methods and one-shot `request` |
| `repository_discard` | Fingerprinted destructive worktree write | stdio method and one-shot `request` |
| `repository_create_commit` | Commit entire current index, hooks/signing retained | stdio method and one-shot `commit` / `request` |
| `repository_amend_commit` | Guarded history rewrite | stdio method and one-shot `request` |
| `repository_conflict_file` | Read conflict stages | stdio method and one-shot `request` |
| `repository_resolve_conflict` | Fingerprinted conflict write | stdio method and one-shot `request` |
| `repository_run_operation` | Guarded Git operation/sequencer | stdio method and one-shot `request`; editor-dependent behavior is noninteractive |
| `repository_delete_branch` / `repository_delete_branches` | Reviewed branch deletion | stdio methods and one-shot `request`; no account UI prompts |
| `repository_worktrees` | Read worktree list | `repository_worktrees`; one-shot `request` |
| `repository_worktree_review` / `repository_worktree_execute` | Token-reviewed worktree writes | stdio methods; portable `review`/`execute` reopens the repository and reacquires/revalidates the token |
| `repository_remotes` / `repository_sync_info` | Read remote/sync state | stdio methods and one-shot `request` |
| `repository_remote_action` | Fetch/push/pull; may prompt | stdio method and one-shot `request`; prompts disabled and SSH batch mode retained |
| `repository_stashes` / `repository_stash_action` | Read and mutate stashes | stdio methods and one-shot `request` |
| `repository_write_commit_graph` / `repository_commit_graph_status` | Local acceleration write/read | stdio methods and one-shot `request` |
| `repository_clone` / `repository_cancel_clone` | Network filesystem write, progress/cancel | stdio methods; native/WSL destination, progress events, and inline cancellation |
| `repository_watch` | Native filesystem watcher | Native watcher emits `repository_changed`; WSL/SSH report inactive |
| `repository_open_path` / `repository_reveal_path` | OS shell/file-manager action | Desktop-only refusal |
| `repository_ignore_path` | Worktree + `.gitignore` write | stdio method and one-shot `request` |

## Desktop, provider, and host commands

| Tauri command | Classification | Headless disposition |
| --- | --- | --- |
| `repository_pick`, `repository_pick_clone_parent` | Native folder dialogs | `desktopOnly` refusal; caller supplies explicit paths |
| `app_start_dragging`, `app_window_button_layout`, `app_launch_path` | Window integration / launch args | Desktop-only |
| `open_external_url` | OS URL handler | Desktop-only |
| `askpass::repository_provide_password`, `editor::editor_reply` | Scoped interactive prompt replies | `repository_prompt_reply` only with `--allow-prompts`; default is noninteractive |
| `list_provider_accounts`, `provider_connect_token`, `provider_disconnect` | Keychain/account mutation | Available in stdio only with explicit `--accounts-file`; token is JSON input, never an argv option |
| `provider_oauth_start`, `provider_oauth_poll`, `provider_oauth_cancel` | Device authorization/account flow | Available in stdio only with `--accounts-file`; returns a verification URL/code without opening a browser; polling is bounded and cancellable |
| `provider_pull_requests`, `provider_create_pull_request`, `provider_repositories`, `provider_organizations` | Authenticated network/provider operations | Exposed only with explicit `--accounts-file`; no such account access in test bridge |
| `ssh_test`, `ssh_directories` | Host SSH discovery | Stdio uses the shared validated shell-free SSH API; local locks do not coordinate remote hosts |
| `wsl_distributions`, `wsl_directories` | Windows WSL discovery | Advertised only on Windows; missing `wsl.exe` returns `wslUnavailable` |

## Events, channels, startup and shutdown

| Surface | Producer / consumer | Headless behavior |
| --- | --- | --- |
| `repository_changed` | `watcher::Watchers` emits; frontend refreshes | Native watcher events use the versioned stdio event envelope |
| `git_command` | `process::set_git_log`; activity UI | Transported as a versioned stdio event |
| Askpass/editor prompt and expiry events | Askpass/editor registries and dialogs | Disabled by default; opt-in scoped request IDs and inline reply through `repository_prompt_reply` |
| `repository_clone` progress `Channel<CloneProgress>` | Clone command and workspace | Transported as bounded versioned stdio events; cancellation is inline |
| Window button-layout event | Linux host/window setup | Desktop-only |
| Startup | credentials resource, account store, SSH control dir, `Service`, watchers, Git activity sink, askpass/editor registries | CLI must initialize isolated data and explicit capabilities; must not reuse desktop app-data or launch the GUI helper |
| Shutdown | window close cancels clone/graph jobs, stops watchers and cleans prompt helpers | stdio EOF/broken output discards queued requests, cancels active clone/search/prompt work, and closes sessions; started writes are not rolled back |

## Current guarantee boundary

The CLI defaults to noninteractive behavior and preserves action-specific
review/fingerprint rules. Prompt listeners and system-account access are explicit
opt-ins. Provider secrets are excluded from event/activity logs, and the browser
test bridge continues to refuse credentials and network actions. A local advisory lock does not coordinate independent actors on an SSH
host. The browser test bridge is separate and currently does not transport native
events or clone progress; it refuses credentials, arbitrary remotes, OS shell
actions, and paths outside its disposable fixture.
