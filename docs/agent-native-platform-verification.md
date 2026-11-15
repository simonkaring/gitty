# Agent CLI and native platform verification

This checklist is evidence to collect, not a claim that each platform has been
tested. Record OS/version, architecture, artifact hash, command, result, and
skipped scope for each run. Browser Chromium/Playwright coverage is not packaged
Tauri desktop coverage.

## CLI release artifact

- [ ] Build a release CLI on each supported target with
  `npm run package:cli -- [--target RUST_TARGET] [--out-dir DIR]`.
- [ ] Keep each target's artifact separate. The adjacent JSON manifest records
  target, version when runnable on the build host, and SHA-256; it is not a
  signature or provenance attestation.
- [ ] On the matching host only, run `gitty-cli doctor --json` and
  `gitty-cli capabilities --json`; verify required Git availability and
  advertised protocol/methods. Never execute a foreign-target binary.
- [ ] Exercise the published stdio protocol and CLI commands against a disposable
  repository, including paths with spaces, Unicode, leading dashes, and
  newlines where the host/filesystem permits. Verify resulting Git state.
- [ ] Install version N, upgrade to N+1, and confirm invocation paths,
  configuration/state compatibility, and protocol-major compatibility. Test
  old-client/new-server and new-client/old-server behavior before declaring the
  protocol stable.
- [ ] Record compiler/toolchain and target prerequisites. A successful cross
  compile is not runtime verification.

## Packaged Tauri desktop (each target OS)

- [ ] Install and uninstall the actual platform package; verify app identity,
  launch/upgrade behavior, shortcuts, and cleanup of app/helper processes.
- [ ] Open repositories and exercise native IPC permissions, file/folder
  pickers, window controls, deep links if enabled, and filesystem access.
- [ ] Exercise authentication prompts and OS keychain/credential storage:
  success, cancel, missing credential, and cleanup/logout. Record account,
  network, and credential-store scope; mocks do not count as platform evidence.
- [ ] Check the bundled webview/runtime version, rendering, keyboard/focus,
  screen scaling, and accessibility with native assistive technology.
- [ ] Exercise editor/askpass integrations, cancellation, app close while helpers
  run, and ensure no orphaned child processes or leaked credentials.
- [ ] Record installer/signing/notarization verification separately; checksum
  metadata alone does not establish signing or release readiness.

## Automation boundary

Tauri's [v2 WebDriver documentation](https://v2.tauri.app/develop/tests/webdriver/)
describes desktop WebDriver testing on Windows, Linux, and macOS, with platform
setup requirements. The direct `tauri-driver` route has platform-specific limits;
consult the [manual setup](https://v2.tauri.app/develop/tests/webdriver/manual-setup)
for the current matrix (notably, its direct desktop driver is not a macOS route).
Evaluate the chosen driver and its native dependencies per platform before
claiming desktop automation. Playwright running a browser/Chromium app remains
rendered-browser evidence, not packaged Tauri runtime evidence.

## Recorded verification

- Windows x86_64: `@tauri-apps/api` and `@tauri-apps/cli` 2.12.4 with Rust
  `tauri` 2.12.5; `npm run tauri -- info` reported these versions without a
  mismatch, and `npm run build`, `npm run check:rust`,
  `npm run test:rust`, and `npm run tauri -- build --no-bundle` passed.
  The Tauri CLI's installed-package version check ran without a mismatch
  warning. The no-bundle build produced `target/release/gitty.exe`; this verifies
  native compilation only, not launch/runtime, installation, signing, or
  notarization.
