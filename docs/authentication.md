# Git authentication and provider connections

Gitty requires no hosted authentication service. Git operations use standard Git
helpers/SSH; provider API connections use public-client device authorization.

## Bundled Git Credential Manager

`npm run desktop` and release builds prepare GCM 2.9.1 automatically. To prepare
it separately, run `npm run prepare:gcm`. The script downloads the portable
distribution for the target architecture, verifies a pinned SHA-256 digest, and
keeps its runtime dependencies and third-party notices. Gitty bundles the GCM MIT
license too. Generated files are ignored by Git.

Supported build targets are macOS, Windows and Linux, each on x64/ARM64. Cross-target
release preparation uses Tauri's `TAURI_ENV_TARGET_TRIPLE`; build macOS architectures
separately rather than using a universal target. macOS requires 14+ for the included
.NET 10 runtime. Linux needs a working Secret Service/keyring (or an explicitly
configured GCM credential store). Follow the GCM runtime requirements for your
distribution. No separate .NET installation is needed.

For native HTTPS operations, existing helpers run first, followed by bundled GCM
unless GCM is already configured or helpers were explicitly disabled. This is
per-command configuration; no global Git configuration is written. First-time clone
and explicit sync can sign in; background fetch cannot. SSH remains managed by the
user's SSH configuration/agent. WSL retains distribution-level helper configuration;
configure Windows GCM interop or a Linux helper there.

GCM's public-host registrations cover Git authentication. They do not register
Gitty's provider API integration or grant its pull-request features access.

## Register Gitty for provider features

Set these **public client IDs** in the environment before compiling the desktop app:

```sh
export GITTY_GITHUB_CLIENT_ID='your-github-client-id'
export GITTY_GITLAB_CLIENT_ID='your-gitlab-application-id'
export GITTY_AZURE_CLIENT_ID='your-entra-application-client-id'
npm run desktop
```

For release builds, set the same variables before `npm run desktop:build`.
Cargo rebuilds when these values change. Missing IDs produce an actionable sign-in
error; manual tokens and GCM-backed Git operations still work. Never embed client
secrets: this implementation does not use them.

- **GitHub:** register an OAuth app owned by the Gitty publisher and enable device
  flow. Gitty requests `repo read:user` for private repository/PR access and account
  identification. The device flow does not use a callback listener. If GitHub's
  registration form requires a callback URL, it is unused by this flow.
- **GitLab.com:** register a **non-confidential** OAuth application with `api`,
  `read_user`, and `write_repository` scopes. Device authorization is available on
  current GitLab.com (generally available since GitLab 17.9). A registered redirect
  URI is unused by device authorization.
- **Azure DevOps Services:** register a Microsoft Entra application for accounts in
  any organizational directory, add Azure DevOps delegated permissions (such as
  `user_impersonation`, as available in the registration portal), and enable public
  client/device flows. Gitty requests the Azure DevOps resource's `.default` scope
  and `offline_access`. Tenant policy may require administrator consent. This flow
  supports work/school accounts; use a PAT for personal Microsoft accounts.
- **Bitbucket Cloud:** provider API connections use manual API tokens for now;
  HTTPS Git browser authentication is handled by GCM.

Device codes stay in Rust memory. The UI receives only an opaque request ID, a user
code, an approved provider verification URL, and timing information. Polling respects
provider intervals and handles cancellation, denial, expiration and slowdown.
Successful sign-in verifies the provider account before saving credentials. Access
tokens refresh before provider API use when the provider supplies refresh tokens.
Disconnect removes Gitty's local credentials; it does not erase GCM's credentials
or revoke authorization on the provider's website.

## Custom hosts

Any Git host supported by installed Git can use existing SSH or HTTPS helpers.
Self-hosted GitLab/enterprise browser authentication may require an instance-specific
OAuth registration and helper configuration. Gitty's provider API account UI currently
targets the public services above; custom API hosts are not implemented.

## Native verification

Run `npm test`, `npm run build`, `npm run check:rust`, `npm run test:rust`, and
`cargo fmt --manifest-path src-tauri/Cargo.toml --check`. Unit checks cover device
session timing, cancellation/expiry, allowed verification hosts, token-free IPC,
legacy account metadata, and helper command quoting. Frontend tests mock IPC.

Before publishing, test the real desktop build with configured client IDs: clone a
private HTTPS repository with no saved credentials, approve browser sign-in, fetch
and push a disposable branch, and confirm later background fetch does not prompt.
Connect each provider, list/create a test PR, cancel/deny a pending connection, and
verify disconnect and token refresh. Verify helper startup/packaging and keyring
behavior on Windows/Linux and signed/notarized macOS builds too. Live provider
authorization cannot be validated with browser mocks or without app registrations.
