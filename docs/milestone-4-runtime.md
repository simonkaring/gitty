# Milestone 4 runtime verification

The macOS test suite, cross-platform compilation CI, and mocked browser IPC do not verify Windows/WSL transport or packaged GUI behavior. Record OS, Git, Python, WSL distribution, outcome, and any error text for the checks below. Use disposable repositories and remotes for mutations.

## Windows + WSL host

1. Build the current workspace on Windows with `npm ci`, `npm test`, `npm run build`, `npm run check:rust`, and `npm run test:rust`. Start the desktop app with `npm run desktop`. Confirm Windows Git and WSL Git 2.37+, GNU `find`, `env`, `wslpath`, and Python 3 in the selected distribution.
2. Verify WSL interoperability is enabled: from PowerShell, run `wsl.exe --distribution Ubuntu --exec wslpath -u "C:\path\to\Gitty.exe"` using the actual built app executable and distribution name. Inside the distribution, run the resulting Linux path as a Windows executable from a disposable shell. A disabled WSL interop installation should use its Linux credential helper/SSH agent without a prompt.
3. Open a WSL repository in Gitty. Exercise explicit **Fetch**, **Pull**, and **Push** against test HTTPS credentials that are not already supplied by a helper; each should request credentials in the Windows app. Cancel once, refresh, and confirm no blind retry or hidden branch integration. With an existing Linux credential helper, confirm no extra prompt. Background fetch and clone should remain noninteractive.
4. Repeat explicit remote operations against a test SSH remote whose key requires a passphrase, then with a configured Linux SSH agent. Exercise two repository tabs concurrently so prompts return to the operation that requested them. On failed authentication, copy only error text (never the answer) into the validation record.
5. Exercise WSL directory browsing, an ordinary conflict and a symlink conflict, and ensure the Python 3 filesystem helper does not follow symlink ancestors. For a divergent submodule-pointer conflict, choosing a side should change only the parent repository's index entry, not the nested checkout.

## Linux and macOS GUI

On Linux, install the Tauri/WebKitGTK 4.1 prerequisites, run `npm run desktop`, and exercise repository tabs, graph paging, conflict dialogs, line staging, and explicit remote actions with the platform's actual Git executable. On macOS, open the built `.app` and test the same workflows. With keyboard-only input and a screen reader, check interactive-rebase action selects, order buttons, review/execute, message prompts, conflict choices, focus return, and narrow-window behavior. Record results separately from headless and mocked tests.

## Signed artifacts

After changes are published to the repository, manually dispatch `.github/workflows/release.yml` with the signing secrets described in `README.md`. The jobs fail if credentials are absent and verify signatures (and the macOS notarization ticket) before uploading bundles. Install and launch the resulting signed macOS DMG and Windows MSI/NSIS on real hosts before declaring a release. The debug `.app` built locally is not evidence of signing or notarization.
