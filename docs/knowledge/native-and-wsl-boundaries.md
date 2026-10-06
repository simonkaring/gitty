---
type: Platform Boundary
title: Native and WSL boundaries
description: Where Git and filesystem work execute and which platform capabilities differ.
status: draft
sources:
  - id: process
    resource: ../../src-tauri/src/process.rs
  - id: remote
    resource: ../../src-tauri/src/remote.rs
  - id: askpass
    resource: ../../src-tauri/src/askpass.rs
  - id: bridge-test
    resource: ../../src-tauri/src/remote_tests.rs
  - id: contract
    resource: ../../src-tauri/BACKEND.md
  - id: readme
    resource: ../../README.md
---

# Native and WSL boundaries

Rust owns repository Git and filesystem work. Native Git uses explicit arguments
with `git -C`; WSL locations use `wsl.exe --distribution … --exec env … git -C …`
on Windows. Native locations on `\\wsl…` UNC paths are refused by the process layer; the UI
must represent them as a distribution plus Linux path. Read and mutation
environments are distinct: preserve their targeted configuration and lock
policies rather than replacing them with a generic runner.[^process]

WSL is a separate execution environment, not a Windows path alias. Distribution
browsing and operation detection require Linux tools; conflict filesystem access
uses a fixed Python 3 helper with pinned directory descriptors. Native conflict
access uses capability-rooted handles. Ignore/open/reveal and interactive rebase
editing have explicit WSL limitations; consult the detailed contract before
extending platform support.[^contract]

Git authentication and provider API accounts are separate. WSL retains its
distribution credential helpers; bundled native GCM is not injected there.
Explicit WSL fetch/pull/push can configure a scoped askpass bridge when the
Windows executable path translates for interop. If path translation fails or no
askpass registry is available, the helper-UI fallback (`credential.interactive=true`)
remains. Background fetch stays noninteractive. This is
implemented capability, not a claim of successful Windows/WSL runtime
verification.[^remote][^askpass][^readme]

Inspect `command_inner`, `remote_action`, `wsl_executable_path`, and
`network_args_wsl` when changing transport/authentication. The
`wsl_network_bridge_uses_scoped_token_and_linux_executable_path` test checks
argument/token construction, not real interop execution.[^bridge-test]

Open verification point: `network_args_wsl` sets `SSH_ASKPASS` but inherits
`core.sshCommand=ssh -oBatchMode=yes …` from `network_args(false, None)`.
Do not infer interactive SSH passphrase support from that environment variable.
The comment above `allow_credential_helper_ui` still describes WSL as unable to
use the bridge; the caller now has a separate bridge branch. Follow the branch
implementation and retain this caveat until that comment/runtime behavior is
reconciled.[^remote]

For runtime scope, use [demo and native verification](demo-and-native-verification.md).
The [backend contract](../../src-tauri/BACKEND.md#read-semantics) and
[README prerequisites](../../README.md#desktop) remain the detailed references.

[^process]: Transport selection and environment isolation.
[^remote]: Explicit/background authentication branches and fallback handling.
[^askpass]: Executable translation and per-operation token lifecycle.
[^bridge-test]: Construction-level WSL bridge regression.
[^contract]: Filesystem, editor, and process-lifecycle platform limits.
[^readme]: User-facing platform prerequisites and pending runtime checks.
