---
type: Platform Boundary
title: Repository cloning and accounts
description: Connected-account repository browsing, clone credential scope, and native/WSL limits.
status: draft
sources:
  - id: discovery
    resource: ../../src-tauri/src/provider_repositories.rs
  - id: accounts
    resource: ../../src-tauri/src/provider_accounts.rs
  - id: clone
    resource: ../../src-tauri/src/clone.rs
  - id: browser
    resource: ../../src/components/RepositoryBrowser.tsx
  - id: entry
    resource: ../../src/components/Welcome.tsx
  - id: ui-tests
    resource: ../../src/components/RepositoryBrowser.test.tsx
  - id: contract
    resource: ../../src-tauri/BACKEND.md
  - id: settings
    resource: ../../src/components/IntegrationsSettings.tsx
  - id: settings-tests
    resource: ../../src/components/IntegrationsSettings.test.tsx
  - id: settings-smoke
    resource: ../../src/components/integrations.smoke.mjs
---

# Repository cloning and accounts

Integrations settings groups connected-account metadata separately from provider
selection and setup. Changing providers clears unfinished token fields; provider
selection is locked while connecting or disconnecting. Browser authorization shows
the user code until approval or cancellation, with access-token fallback and
Bitbucket's token-only setup. Failed account loading offers retry rather than an
empty-account claim. Browser preview exposes provider choices but no connection
controls or native account reads. Mocked component tests cover these UI paths,
credential clearing, device polling/cancellation and disconnect failures; they do
not exercise real OAuth or OS credential storage. The optional integration smoke
checks light/dark and narrow browser layout with mocked Tauri IPC, including
provider setup and device cancellation.[^settings][^settings-tests][^settings-smoke]

The Clone screen defaults to connected-account browsing. GitHub.com and GitLab.com
return pages of accessible repositories; the UI filters loaded names/namespaces
and offers load more. Azure DevOps Services discovers organizations through the
profile/accounts API, or accepts a manually entered organization name, then reads
that organization's unpaged repository list and derives project filters from it.
Requests have fixed provider origins, bounded responses and no redirects. Pagination
links do not become arbitrary credential-bearing requests.[^discovery][^browser]

Discovery/clone IPC exposes account metadata and credential-free clone URLs, not tokens. Tokens live in the
OS credential store, with existing OAuth refresh applied on lookup. Selecting a
repository adds its account ID to the clone request. Native HTTPS clones inject a
repository-URL-scoped Authorization header via process-local Git config, disable
helper/prompt fallback and redirects, and redact tokens from progress/errors.
Cloning never stores those credentials in repository configuration or selects the
account for subsequent fetch/pull/push.[^accounts][^discovery][^clone]

Account-based clones require native destinations and canonical cloud HTTPS URLs;
WSL, SSH, Bitbucket and self-hosted accounts use neither this browser nor its token
injection. URL cloning still supports configured Git/SSH credentials and WSL helper
authentication. Existing cancellation, temporary-directory ownership and no-replace
publication guards are shared by both clone paths.[^entry][^clone][^contract]

Changing accounts/organizations clears selection and keyed browser lifetimes ignore
old results. Closing account settings refreshes metadata; API errors offer retry and
organization discovery failure still permits manual entry. Mocked UI tests cover
selection-to-clone IPC, URL fallback, pagination/filtering, stale account responses,
Azure project filtering and manual organization fallback. Rust tests cover provider
response shapes, rejected URLs/cursors and a real Git loopback HTTP request proving
header isolation to the selected repository. These do not verify live provider
permissions, OAuth registrations, or Windows/WSL execution.[^browser][^ui-tests][^discovery]

[^discovery]: Provider listing, URL validation, clone credentials and Rust tests.
[^accounts]: Credential storage and refreshed token lookup.
[^clone]: Shared clone subprocess and publication lifecycle.
[^browser]: Browser loading, filtering and request invalidation.
[^entry]: Account/URL clone form and destination choice.
[^ui-tests]: Mocked connected-account browser regressions.
[^contract]: Detailed IPC and transport authentication contracts.
[^settings]: Provider selection, connection setup and account metadata presentation.
[^settings-tests]: Mocked integration settings interaction regressions.
[^settings-smoke]: Optional browser rendering and mocked authorization smoke checks.
