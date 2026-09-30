# Provider accounts: delivery status and OAuth prerequisites

Gitty's desktop **Settings → Integrations** currently connects GitHub.com,
GitLab.com, Azure DevOps Services (`dev.azure.com`), and Bitbucket Cloud using
access tokens. GitHub, GitLab, and Bitbucket tokens are verified against the
provider user endpoint before they are saved; an Azure DevOps PAT is checked
against an organization when used. Metadata is kept in app data, while secrets
are stored by the operating system's credential store. Disconnect removes the
credential. Native HTTPS Git operations and clone automatically use the sole
account matching the exact remote host. If several accounts match, Gitty falls
back to the configured Git credential helper until per-remote selection is
implemented. SSH and WSL Git continue using their normal credentials.

With a connected account, the Create pull request dialog lists and creates
PRs/MRs through the provider API. It does not publish branches for you. The
existing browser draft form remains available when the provider URL supports
it. Only cloud provider URLs are accepted by the API bridge.

## Browser sign-in prerequisites

No Gitty OAuth applications are registered yet, so **browser sign-in is not
available**. A desktop client ID must be registered for each provider before
the following flows can be implemented and exercised:

- **GitHub:** Register a GitHub OAuth app or GitHub App, enable device flow,
  decide repository and PR permissions, and ship its public client ID. A
  GitHub App may require installation on an organization before its user token
  can access that organization's repositories. Device flow does not require a
  client secret in the desktop application.
- **GitLab.com:** Register an OAuth application supporting authorization-code
  with PKCE and a desktop callback. Request scopes that cover Git read/write
  and merge request creation. Refresh and replace rotating tokens in the OS
  credential store.
- **Azure DevOps Services:** Register a public-client Microsoft Entra app with
  Azure DevOps delegated permissions and PKCE, and use the system browser.
  Entra's Azure DevOps resource currently does not natively cover all personal
  Microsoft-account users, so retain an access-token fallback. Do not start a
  new Azure DevOps OAuth registration: that flow is deprecated.
- **Bitbucket Cloud:** Its OAuth authorization-code exchange requires a client
  secret. A desktop binary cannot keep this secret confidential. Keep the
  Bitbucket API-token flow unless a maintained HTTPS broker is introduced to
  own the secret and authorization exchange.

OAuth completion must validate state/PKCE and callbacks in Rust, verify the
resulting provider identity, store rotating refresh tokens only in the OS
credential store, and never send access tokens to the webview. Once registered,
the OAuth provider token can use the same per-operation Git and provider API
paths as the access-token connection.

Follow-up platform work: explicit per-remote account choice for multiple
accounts, WSL provider credentials (separate from native Git), self-hosted
provider registrations and origin verification, and packaged desktop sign-in
tests on macOS, Windows and Linux.
