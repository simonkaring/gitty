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
  - id: bridge
    resource: ../../src-tauri/src/bridge.rs
  - id: bridge-test
    resource: ../../src-tauri/src/remote_tests.rs
  - id: contract
    resource: ../../src-tauri/BACKEND.md
  - id: readme
    resource: ../../README.md
  - id: windows
    resource: ../../src-tauri/src/lib.rs
  - id: linux-window
    resource: ../../src-tauri/src/linux.rs
  - id: workspace
    resource: ../../src/components/NativeWorkspace.tsx
  - id: controls
    resource: ../../src/components/WindowControls.tsx
---

# Native and WSL boundaries

Linux and Windows disable native window decorations and use app-header controls;
macOS retains its native overlay controls. Linux reads `gtk-decoration-layout`
on the GTK UI thread, exposes the current value through `app_window_button_layout`,
and emits `window-button-layout-changed` when GTK preferences change. The frontend
honors supported buttons on both sides, filtering duplicates and GTK-only menu
entries; malformed layouts fall back to minimize/maximize/close on the right.
Controls use Gitty styling, not the desktop GTK theme. Window APIs bypass demo
repository dispatch, so desktop demo mode keeps working controls. Linux edge/corner
handles invoke native resize dragging; Tauri's deep drag region handles moving and
double-click maximization without capturing interactive header elements.
Wayland/X11 GUI behavior requires separate runtime verification.[^windows][^linux-window][^workspace][^controls]

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
extending platform support.[^contract] The WSL operation-metadata scan is one
`find` that must keep `test -e`/`cat` parity: symlinks followed, dangling links absent,
heavy Git-directory subtrees pruned, and exit 1 from entries vanishing under
concurrent Git tolerated; it has no Windows/WSL runtime verification yet.[^contract]

Git authentication and provider API accounts are separate. WSL retains its
distribution credential helpers; bundled native GCM is not injected there.
Explicit WSL fetch/pull/push can configure a scoped askpass bridge when the
Windows executable path translates for interop. If path translation fails or no
askpass registry is available, the helper-UI fallback (`credential.interactive=true`)
remains. Background fetch stays noninteractive. This is
implemented capability, not a claim of successful Windows/WSL runtime
verification.[^remote][^askpass][^readme]

Native interactive actions (fetch/pull/push, origin branch deletion, clone) also
hold a per-operation scoped askpass token, not the app token, so prompts end with
the operation. The loopback bridges bound pre-authentication input (256-byte
token, 4 KiB prompt), an absolute 10 s handshake deadline, and 16 concurrent
connections; helper scripts are removed on window close.[^askpass][^bridge]

Background fetch deliberately bypasses the Gitty mutation lock and read deadline:
it moves only `refs/remotes/*` and must not block local writes behind the network.
Explicit remote actions still use the lock.[^remote]

Inspect `command_inner`, `remote_action`, `wsl_executable_path`, and
`network_args_wsl` when changing transport/authentication. The
`wsl_network_bridge_uses_scoped_token_and_linux_executable_path` test checks
argument/token construction, not real interop execution.[^bridge-test]

Open verification point: `network_args_wsl` sets `SSH_ASKPASS` but inherits
`core.sshCommand=ssh -oBatchMode=yes …` from `network_args(false, None)`.
Do not infer interactive SSH passphrase support from that environment variable.
The `allow_credential_helper_ui` comment now describes only the WSL fallback
branch (no registry, or `wslpath` translation failed).[^remote]

For runtime scope, use [demo and native verification](demo-and-native-verification.md).
The [backend contract](../../src-tauri/BACKEND.md#read-semantics) and
[README prerequisites](../../README.md#desktop) remain the detailed references.

[^process]: Transport selection and environment isolation.
[^remote]: Explicit/background authentication branches and fallback handling.
[^askpass]: Executable translation and per-operation token lifecycle.
[^bridge]: Connection cap, handshake deadline, bounded lines and stale-helper cleanup.
[^bridge-test]: Construction-level WSL bridge regression.
[^contract]: Filesystem, editor, and process-lifecycle platform limits.
[^readme]: User-facing platform prerequisites and pending runtime checks.
[^windows]: Window decoration setup and layout IPC.
[^linux-window]: GTK button layout observation and Linux icons.
[^workspace]: Platform-gated header controls and layout subscription.
[^controls]: Button layout parsing, window actions, and native resize handles.
