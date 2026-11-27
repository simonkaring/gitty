//! Only these explicitly requested actions opt into network protocols. All
//! discovery, upstream counts and validation use the offline read contract.
use crate::{
    dto::{Error, RepositoryLocation, Result},
    mutate::report,
    process::{self, args, Output},
    provider_accounts::AccountStore,
    provider_repositories::github_push_credential,
    remote_dto::{ActionOutput, PullMode, RemoteAction, SyncInfo},
    repository::{resolve, Repository, Service},
};

/// No configured refspecs, pruning or FETCH_HEAD: only the refspecs each caller
/// names after `-- <remote>` can move. Git's default tag auto-follow may add
/// missing tags that point into fetched history; it never changes or deletes
/// an existing local tag.
const SAFE_FETCH: [&str; 7] = [
    "fetch",
    "--no-all",
    "--no-recurse-submodules",
    "--no-prune",
    "--no-prune-tags",
    "--no-write-fetch-head",
    "--refmap=",
];
pub(crate) const SAFE_PUSH: [&str; 6] = [
    "push",
    "--porcelain",
    "--no-force",
    "--no-mirror",
    "--no-follow-tags",
    "--recurse-submodules=no",
];

impl Service {
    pub fn remote_action(
        &self,
        handle: &str,
        action: RemoteAction,
        askpass: Option<&crate::askpass::AskpassRegistry>,
    ) -> Result<ActionOutput> {
        self.remote_action_with_accounts(handle, action, askpass, None)
    }

    pub fn remote_action_with_accounts(
        &self,
        handle: &str,
        action: RemoteAction,
        askpass: Option<&crate::askpass::AskpassRegistry>,
        accounts: Option<&AccountStore>,
    ) -> Result<ActionOutput> {
        if matches!(action, RemoteAction::BackgroundFetch) {
            // Only moves refs/remotes/* and adds missing tags; Git's own ref locks suffice, and a slow
            // network must not block local writes such as switching branches.
            let repo = self.repo(handle)?;
            return crate::process::without_read_deadline(|| {
                repo.remote_action(action, askpass, false, None)
            });
        }
        self.mutate(handle, |repo| {
            repo.remote_action(action, askpass, false, accounts)
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalSync {
    Fetch,
    Pull,
    Push,
    Publish,
}

#[derive(Clone, PartialEq, Eq)]
pub struct TerminalRemoteReview {
    kind: TerminalSync,
    remote: String,
    branch: Option<String>,
    destination: Option<String>,
    oid: Option<String>,
    upstream: (Option<String>, Option<String>),
    endpoint: String,
}

impl TerminalRemoteReview {
    pub fn kind(&self) -> TerminalSync {
        self.kind
    }

    pub fn remote(&self) -> &str {
        &self.remote
    }

    pub fn branch(&self) -> Option<&str> {
        self.branch.as_deref()
    }

    pub fn destination(&self) -> Option<&str> {
        self.destination.as_deref()
    }

    pub fn oid(&self) -> Option<&str> {
        self.oid.as_deref()
    }

    pub fn endpoint_label(&self) -> String {
        endpoint_label(&self.endpoint)
    }
}

pub fn endpoint_label(endpoint: &str) -> String {
    // URLs can contain secrets outside userinfo as well, including in the path.
    if let Ok(url) = url::Url::parse(endpoint) {
        if let Some(host) = url.host_str() {
            return match url.port() {
                Some(port) => format!("{}://{host}:{port}/…", url.scheme()),
                None => format!("{}://{host}/…", url.scheme()),
            };
        }
    }
    if let Some((host, _)) = endpoint.split_once(':') {
        let host = host.rsplit('@').next().unwrap_or_default();
        if crate::dto::valid_ssh_word(host) && host.len() > 1 {
            return format!("SSH {host}:…");
        }
    }
    "configured endpoint (hidden)".into()
}

impl Service {
    pub fn terminal_remote(
        &self,
        handle: &str,
        review: &TerminalRemoteReview,
        askpass: Option<&crate::askpass::AskpassRegistry>,
    ) -> Result<ActionOutput> {
        self.mutate(handle, |repo| {
            let fresh = repo
                .terminal_review_remote(review.kind, &review.remote, review.destination.as_deref())
                .map_err(|_| {
                    Error::new(
                        "staleOperation",
                        "Sync target changed; refresh and review again.",
                    )
                })?;
            if &fresh != review {
                return Err(Error::new(
                    "staleOperation",
                    "Sync target changed; refresh and review again.",
                ));
            }
            let remote = Some(review.remote.clone());
            let branch = review.destination.clone();
            let action = match review.kind {
                TerminalSync::Fetch => RemoteAction::Fetch {
                    remote,
                    branch: None,
                },
                TerminalSync::Pull => RemoteAction::Pull {
                    remote,
                    branch,
                    target: None,
                    pull_mode: PullMode::FfOnly,
                },
                TerminalSync::Push | TerminalSync::Publish => RemoteAction::Push {
                    remote,
                    branch,
                    source: review.branch.clone(),
                    set_upstream: review.kind == TerminalSync::Publish,
                },
            };
            repo.remote_action(action, askpass, true, None)
        })
    }
}

impl Repository {
    pub fn terminal_review_remote(
        &self,
        kind: TerminalSync,
        remote: &str,
        publish_destination: Option<&str>,
    ) -> Result<TerminalRemoteReview> {
        let info = self.sync_info_with_counts(false)?;
        let remote = self.choose_remote(Some(remote), None, &info.remotes)?;
        let push = matches!(kind, TerminalSync::Push | TerminalSync::Publish);
        let endpoint = if push {
            self.push_destination(&remote)?
        } else {
            self.check_text(&["remote", "get-url", "--", &remote])?
                .trim_end_matches('\n')
                .to_owned()
        };
        let (branch, oid, upstream, destination) = if kind == TerminalSync::Fetch {
            (None, None, (None, None), None)
        } else {
            let branch = info.branch.ok_or_else(|| {
                Error::new("detachedHead", "Switch to a local branch before syncing.")
            })?;
            let oid = resolve(self.location(), &format!("refs/heads/{branch}"))?;
            let configured_remote = self.sync_config(&format!("branch.{branch}.remote"))?;
            let configured_ref = self.sync_config(&format!("branch.{branch}.merge"))?;
            let upstream = (configured_remote, configured_ref);
            let destination = match (kind, &upstream.0, &upstream.1) {
                (TerminalSync::Publish, None, None) => {
                    publish_destination.unwrap_or(&branch).to_owned()
                }
                (TerminalSync::Publish, ..) => {
                    return Err(Error::new(
                        "upstreamExists",
                        "This branch already has an upstream.",
                    ))
                }
                (_, Some(r), Some(target)) if r == &remote => target
                    .strip_prefix("refs/heads/")
                    .filter(|name| kind != TerminalSync::Push || *name == branch)
                    .ok_or_else(|| {
                        Error::new(
                            "invalidUpstream",
                            "Push requires a same-name upstream branch.",
                        )
                    })?
                    .to_owned(),
                _ => {
                    return Err(Error::new(
                        "noUpstream",
                        "Choose the configured upstream remote, or Publish a new branch.",
                    ))
                }
            };
            self.remote_branch_name(&destination)?;
            (Some(branch), Some(oid), upstream, Some(destination))
        };
        Ok(TerminalRemoteReview {
            kind,
            remote,
            branch,
            destination,
            oid,
            upstream,
            endpoint,
        })
    }

    pub fn terminal_push_ref(
        &self,
        review: &TerminalRemoteReview,
        askpass: Option<&crate::askpass::AskpassRegistry>,
    ) -> Result<Option<String>> {
        let cannot_verify = || {
            Error::new("remoteUnverified", "Could not verify the reviewed push endpoint. Inspect it manually before pushing again.")
        };
        let branch = review.destination.as_deref().ok_or_else(cannot_verify)?;
        if !matches!(review.kind, TerminalSync::Push | TerminalSync::Publish)
            || !matches!(self.location(), RepositoryLocation::Native { .. })
        {
            return Err(cannot_verify());
        }
        // Pass the URL via environment, not argv, and detect additional URL rewrites.
        let alias = format!("gitty-check-{}", uuid::Uuid::new_v4());
        let guard = askpass.map(|registry| {
            registry.start_operation_with(crate::askpass::AskpassContext::new(
                &self.session.name,
                format!("verify push {}", review.remote),
            ))
        });
        let (mut args, mut env) = network_args(true, guard.as_ref());
        env.extend([
            ("GIT_CONFIG_COUNT".into(), "1".into()),
            ("GIT_CONFIG_KEY_0".into(), format!("remote.{alias}.url")),
            ("GIT_CONFIG_VALUE_0".into(), review.endpoint.clone()),
        ]);
        let mut probe = args.clone();
        probe.extend(crate::process::args(&[
            "ls-remote",
            "--get-url",
            "--",
            &alias,
        ]));
        let endpoint = self
            .write(&probe, &env, &[], 0)
            .map_err(|_| cannot_verify())?;
        if !endpoint.success
            || String::from_utf8_lossy(&endpoint.stdout).trim_end_matches('\n') != review.endpoint
        {
            return Err(cannot_verify());
        }
        let reference = format!("refs/heads/{branch}");
        args.extend(crate::process::args(&[
            "ls-remote",
            "--exit-code",
            "--refs",
            "--",
            &alias,
            &reference,
        ]));
        let output = self
            .write(&args, &env, &[], 0)
            .map_err(|_| cannot_verify())?;
        if output.code == Some(2) && output.stdout.is_empty() {
            return Ok(None);
        }
        if !output.success {
            return Err(cannot_verify());
        }
        let answer = crate::process::text(output.stdout).map_err(|_| cannot_verify())?;
        let (oid, name) = answer
            .trim_end_matches('\n')
            .split_once('\t')
            .ok_or_else(cannot_verify)?;
        if name != reference
            || !matches!(oid.len(), 40 | 64)
            || !oid.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(cannot_verify());
        }
        Ok(Some(oid.into()))
    }

    fn sync_branch(&self) -> Result<Option<String>> {
        let out = process::git(self.location(), &args(&["symbolic-ref", "--quiet", "HEAD"]))?;
        match out.code {
            Some(0) => Ok(process::text(out.stdout)?
                .trim_end_matches('\n')
                .strip_prefix("refs/heads/")
                .map(String::from)),
            Some(1) => Ok(None),
            _ => Err(self.failed(&out)),
        }
    }

    fn sync_config(&self, key: &str) -> Result<Option<String>> {
        let out = process::git(self.location(), &args(&["config", "--get", key]))?;
        match out.code {
            Some(0) => Ok(Some(
                process::text(out.stdout)?.trim_end_matches('\n').into(),
            )),
            Some(1) => Ok(None),
            _ => Err(self.failed(&out)),
        }
    }

    pub fn sync_info(&self) -> Result<SyncInfo> {
        self.sync_info_with_counts(true)
    }

    /// Offline sync metadata for one local branch, without checking it out.
    /// Remote actions use `sync_info_with_counts` for the checked-out branch.
    pub fn sync_info_for(&self, branch: &str) -> Result<SyncInfo> {
        self.remote_branch_name(branch)?;
        resolve(self.location(), &format!("refs/heads/{branch}"))?;
        self.sync_info_for_branch(Some(branch), true)
    }

    fn sync_info_with_counts(&self, counts: bool) -> Result<SyncInfo> {
        let branch = self.sync_branch()?;
        self.sync_info_for_branch(branch.as_deref(), counts)
    }

    fn sync_info_for_branch(&self, branch: Option<&str>, counts: bool) -> Result<SyncInfo> {
        let remotes = crate::repository::string(self.location(), &["remote"])?
            .lines()
            .map(String::from)
            .collect();
        let mut info = SyncInfo {
            branch: branch.map(String::from),
            upstream: None,
            ahead: None,
            behind: None,
            remotes,
        };
        // Remote actions need selection, not a walk of the upstream history.
        if !counts {
            return Ok(info);
        }
        if let Some(branch) = &info.branch {
            let full = format!("refs/heads/{branch}");
            let refs = crate::repository::string(
                self.location(),
                &[
                    "for-each-ref",
                    "--format=%(refname)%00%(upstream:short)%00%(upstream)",
                    &full,
                ],
            )?;
            for record in refs.lines() {
                let fields: Vec<_> = record.split('\0').collect();
                if fields.len() != 3 || fields[0] != full || fields[1].is_empty() {
                    continue;
                }
                info.upstream = Some(fields[1].into());
                // A configured but deleted upstream is still useful to display;
                // counts are unknown until its tracking ref exists again.
                let exists = process::git(
                    self.location(),
                    &args(&[
                        "rev-parse",
                        "--verify",
                        "--quiet",
                        "--end-of-options",
                        &format!("{}^{{commit}}", fields[2]),
                    ]),
                )?;
                if exists.code == Some(1) {
                    continue;
                }
                if !exists.success {
                    return Err(self.failed(&exists));
                }
                let counts = crate::repository::string(
                    self.location(),
                    &[
                        "rev-list",
                        "--left-right",
                        "--count",
                        &format!("{full}...{}", fields[2]),
                        "--",
                    ],
                )?;
                let values: Vec<_> = counts.split_whitespace().collect();
                if values.len() != 2 {
                    return Err(Error::new("gitParse", "Invalid ahead/behind counts"));
                }
                info.ahead = Some(
                    values[0]
                        .parse()
                        .map_err(|_| Error::new("gitParse", "Invalid ahead count"))?,
                );
                info.behind = Some(
                    values[1]
                        .parse()
                        .map_err(|_| Error::new("gitParse", "Invalid behind count"))?,
                );
            }
        }
        Ok(info)
    }

    pub(crate) fn remote_branch_name(&self, branch: &str) -> Result<()> {
        if branch.is_empty()
            || branch.starts_with(['-', '+'])
            || branch.len() > 1024
            || branch.chars().any(char::is_control)
            || !self
                .check(&["check-ref-format", &format!("refs/heads/{branch}")])?
                .success
        {
            return Err(Error::new(
                "invalidBranch",
                "Choose a valid branch name, not a revision or refspec.",
            ));
        }
        Ok(())
    }

    /// `(refs/tags/<tag>, its unpeeled object)`, refused unless the tag still
    /// peels to the commit the user chose.
    pub(crate) fn tag_target(&self, tag: &str, expected_oid: &str) -> Result<(String, String)> {
        let reference = format!("refs/tags/{tag}");
        if tag.is_empty()
            || tag.starts_with(['-', '+'])
            || tag.len() > 1024
            || tag.chars().any(char::is_control)
            || !self.check(&["check-ref-format", &reference])?.success
        {
            return Err(Error::new("invalidReference", "Choose a valid tag name."));
        }
        let value = crate::repository::string(
            self.location(),
            &["rev-parse", "--verify", "--end-of-options", &reference],
        )?;
        if resolve(self.location(), &reference)? != expected_oid {
            return Err(Error::new(
                "staleOperation",
                format!("Tag {tag} changed; refresh and try again."),
            ));
        }
        Ok((reference, value))
    }

    /// The single push URL of a non-mirror remote; even an explicit refspec does
    /// not neutralize `remote.*.mirror`.
    pub(crate) fn push_destination(&self, remote: &str) -> Result<String> {
        let mirror = self.check(&[
            "config",
            "--bool",
            "--get",
            &format!("remote.{remote}.mirror"),
        ])?;
        if mirror.success && process::text_ref(&mirror.stdout)?.trim() == "true" {
            return Err(Error::new(
                "mirrorRemote",
                "Mirror remotes cannot be pushed from Gitty; configure a normal remote.",
            ));
        } else if !mirror.success && mirror.code != Some(1) {
            return Err(self.failed(&mirror));
        }
        let urls = self.check_text(&["remote", "get-url", "--push", "--all", "--", remote])?;
        if urls.lines().count() != 1 {
            return Err(Error::new(
                "multiplePushUrls",
                "Choose a remote with exactly one push URL.",
            ));
        }
        Ok(urls.trim_end().to_owned())
    }

    fn choose_remote(
        &self,
        requested: Option<&str>,
        configured: Option<&str>,
        remotes: &[String],
    ) -> Result<String> {
        let remote = requested
            .or(configured)
            .or_else(|| {
                if remotes.len() == 1 {
                    Some(remotes[0].as_str())
                } else {
                    remotes
                        .iter()
                        .find(|r| r.as_str() == "origin")
                        .map(String::as_str)
                }
            })
            .ok_or_else(|| Error::new("noRemote", "Choose a configured remote before syncing."))?;
        if remote.is_empty()
            || remote.starts_with('-')
            || remote.len() > 1024
            || remote.chars().any(char::is_control)
            || !remotes.iter().any(|r| r == remote)
            || !self
                .check(&["check-ref-format", &format!("refs/remotes/{remote}/check")])?
                .success
        {
            return Err(Error::new(
                "invalidRemote",
                "Choose an existing named remote, not a URL or path.",
            ));
        }
        Ok(remote.into())
    }

    pub(crate) fn remote_action(
        &self,
        action: RemoteAction,
        askpass: Option<&crate::askpass::AskpassRegistry>,
        reviewed: bool,
        accounts: Option<&AccountStore>,
    ) -> Result<ActionOutput> {
        let wsl = matches!(self.location(), RepositoryLocation::Wsl { .. });
        // Network authentication happens on the remote host: Gitty must not try to
        // answer prompts with a local helper the remote cannot reach.
        let ssh = matches!(self.location(), RepositoryLocation::Ssh { .. });
        self.require_writable()?;
        if !self.unmerged()?.is_empty() {
            return Err(Error::new(
                "unresolvedConflict",
                "Resolve existing conflicts before syncing.",
            ));
        }
        let info = self.sync_info_with_counts(false)?;
        // A named push source or pull target supplies its own upstream
        // configuration; every other action follows the checked-out branch.
        let source_branch = match &action {
            RemoteAction::Push { source, .. } => source.as_deref().or(info.branch.as_deref()),
            RemoteAction::Pull { target, .. } => target.as_deref().or(info.branch.as_deref()),
            _ => info.branch.as_deref(),
        };
        let configured_remote = source_branch
            .map(|b| self.sync_config(&format!("branch.{b}.remote")))
            .transpose()?
            .flatten();
        let configured_branch = if matches!(
            action,
            RemoteAction::Pull { .. } | RemoteAction::Push { .. }
        ) {
            source_branch
                .map(|b| self.sync_config(&format!("branch.{b}.merge")))
                .transpose()?
                .flatten()
        } else {
            None
        };
        let (remote, branch) = match &action {
            RemoteAction::BackgroundFetch => (None, None),
            RemoteAction::Fetch { remote, branch }
            | RemoteAction::Pull { remote, branch, .. }
            | RemoteAction::Push { remote, branch, .. } => (remote.as_deref(), branch.as_deref()),
            RemoteAction::PushTag { remote, .. } | RemoteAction::DeleteRemoteTag { remote, .. } => {
                (Some(remote.as_str()), None)
            }
        };
        let pushes = matches!(
            action,
            RemoteAction::Push { .. }
                | RemoteAction::PushTag { .. }
                | RemoteAction::DeleteRemoteTag { .. }
        );
        let interactive = !matches!(action, RemoteAction::BackgroundFetch);
        let remote = self.choose_remote(remote, configured_remote.as_deref(), &info.remotes)?;
        if let Some(branch) = branch {
            self.remote_branch_name(branch)?;
        }
        let tracking_branch = if configured_remote.as_deref() == Some(&remote) {
            configured_branch
                .as_deref()
                .and_then(|b| b.strip_prefix("refs/heads/"))
        } else {
            None
        };

        let prompt_context = || {
            crate::askpass::AskpassContext::new(
                &self.session.name,
                format!("{} {remote}", action_verb(&action)),
            )
        };
        #[cfg(windows)]
        let wsl_bridge =
            if let (true, RepositoryLocation::Wsl { distribution, .. }, Some(registry)) =
                (interactive, self.location(), askpass)
            {
                crate::askpass::wsl_executable_path(distribution)
                    .ok()
                    .map(|path| (path, registry.start_operation_with(prompt_context())))
            } else {
                None
            };
        #[cfg(not(windows))]
        let wsl_bridge: Option<(String, crate::askpass::AskpassGuard<'_>)> = None;
        // Native prompts use a token scoped to this action, so any prompt dies with it.
        let native_bridge = match (interactive, wsl || ssh, askpass) {
            (true, false, Some(registry)) => Some(registry.start_operation_with(prompt_context())),
            _ => None,
        };
        let network = || -> Result<_> {
            Ok(match (&wsl_bridge, askpass) {
                (Some((path, guard)), Some(registry)) => {
                    network_args_wsl(path, registry, guard.token())
                }
                _ => {
                    let (mut args, env) = network_args(interactive, native_bridge.as_ref());
                    let url = if pushes {
                        self.check_text(&["remote", "get-url", "--push", "--", &remote])?
                    } else {
                        self.check_text(&["remote", "get-url", "--", &remote])?
                    };
                    crate::credentials::configure(&mut args, self.location(), url.trim_end())?;
                    if wsl && interactive {
                        allow_credential_helper_ui(&mut args);
                    }
                    (args, env)
                }
            })
        };

        match &action {
            RemoteAction::Fetch { .. } | RemoteAction::BackgroundFetch => {
                let (mut a, env) = network()?;
                a.extend(args(&SAFE_FETCH));
                a.extend(args(&["--", &remote]));
                // Ignore configured fetch refspecs (including mirror mappings
                // into local heads). Only remote-tracking branches may move,
                // including when the remote rewrites its history.
                a.push(match branch {
                    Some(branch) => format!("+refs/heads/{branch}:refs/remotes/{remote}/{branch}"),
                    None => format!("+refs/heads/*:refs/remotes/{remote}/*"),
                });
                let output = self.write(&a, &env, &[], 0)?;
                network_result(output, wsl && interactive)
            }
            RemoteAction::Push {
                source,
                set_upstream,
                ..
            } => {
                let source = source
                    .as_deref()
                    .or(info.branch.as_deref())
                    .ok_or_else(|| {
                        Error::new("detachedHead", "Switch to a local branch before pushing.")
                    })?;
                self.remote_branch_name(source)?;
                resolve(self.location(), &format!("refs/heads/{source}"))?;
                if tracking_branch.is_none() && !set_upstream {
                    return Err(Error::new(
                        "noUpstream",
                        "Publish this branch with setUpstream enabled for its first push.",
                    ));
                }
                // With no chosen destination the upstream's name is used, but only
                // when it is the branch's own name: `feature` tracking `origin/main`
                // must not publish onto `main` in one click. Git's default
                // `push.default=simple` refuses the same push.
                if let (None, Some(tracking)) = (branch, tracking_branch) {
                    if tracking != source {
                        return Err(Error::new(
                            "upstreamNameDiffers",
                            format!("{source} tracks {remote}/{tracking}, which has a different name. Choose the destination branch explicitly with Publish…, so nothing is pushed onto {tracking} by accident."),
                        ));
                    }
                }
                let destination = branch.or(tracking_branch).unwrap_or(source);
                self.remote_branch_name(destination)?;
                let endpoint = self.push_destination(&remote)?;
                // Any account problem falls back to normal Git authentication.
                let credential = accounts.filter(|_| !wsl && !ssh).and_then(|accounts| {
                    github_push_credential(accounts, &endpoint, || self.sync_config("user.email"))
                        .ok()
                        .flatten()
                });
                let (mut a, mut env) = if credential.is_some() {
                    network_args(false, None)
                } else {
                    network()?
                };
                if let Some(credential) = &credential {
                    // Never fall back to another account or follow a redirect with this token.
                    a.extend(args(&[
                        "-c",
                        "credential.helper=",
                        "-c",
                        &format!("http.{endpoint}.followRedirects=false"),
                        "-c",
                        &format!("http.{endpoint}.sslVerify=true"),
                    ]));
                    env.push(("GIT_ALLOW_PROTOCOL".into(), "https".into()));
                    env.extend(credential.config_env());
                }
                a.extend(args(&SAFE_PUSH));
                if *set_upstream {
                    a.push("--set-upstream".into());
                }
                a.extend(args(&[
                    "--",
                    &remote,
                    &format!("refs/heads/{source}:refs/heads/{destination}"),
                ]));
                let mut output = self.write(&a, &env, &[], 0).map_err(|mut error| {
                    if let Some(credential) = &credential {
                        error.message = credential.redact(&error.message);
                    }
                    error
                })?;
                if let Some(credential) = &credential {
                    output.stdout = credential
                        .redact(&String::from_utf8_lossy(&output.stdout))
                        .into_bytes();
                    output.stderr = credential
                        .redact(&String::from_utf8_lossy(&output.stderr))
                        .into_bytes();
                }
                if reviewed && !output.success {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    let destination = format!("refs/heads/{destination}");
                    if crate::branch_delete::porcelain_status(&stdout, &destination)
                        .is_some_and(|(flag, _)| flag == "!")
                    {
                        return Err(Error::new(
                            "pushRejected",
                            "The server rejected the destination ref.",
                        ));
                    }
                    return Err(Error::new(
                        "mutationUnverified",
                        "Push result could not be verified.",
                    ));
                }
                network_result(output, wsl && interactive)
            }
            RemoteAction::PushTag {
                tag, expected_oid, ..
            }
            | RemoteAction::DeleteRemoteTag {
                tag, expected_oid, ..
            } => {
                let (reference, value) = self.tag_target(tag, expected_oid)?;
                self.push_destination(&remote)?;
                let (mut a, env) = network()?;
                a.extend(args(&SAFE_PUSH));
                let refspec = if matches!(action, RemoteAction::DeleteRemoteTag { .. }) {
                    // Absent or different on the remote: refused, nothing is deleted.
                    a.push(format!("--force-with-lease={reference}:{value}"));
                    format!(":{reference}")
                } else {
                    // --no-force refuses replacing a different tag of the same name.
                    format!("{reference}:{reference}")
                };
                a.extend(args(&["--", &remote, &refspec]));
                let output = self.write(&a, &env, &[], 0)?;
                network_result(output, wsl && interactive)
            }
            RemoteAction::Pull {
                target: Some(target),
                ..
            } => {
                self.remote_branch_name(target)?;
                if info.branch.as_deref() == Some(target.as_str()) {
                    return Err(Error::new(
                        "invalidRequest",
                        "Pull the checked-out branch without choosing a target branch.",
                    ));
                }
                let local_ref = format!("refs/heads/{target}");
                let before = resolve(self.location(), &local_ref)?;
                let branch = branch.or(tracking_branch).ok_or_else(|| {
                    Error::new(
                        "noUpstream",
                        "Configure an upstream or explicitly choose a remote branch to pull.",
                    )
                })?;
                self.remote_branch_name(branch)?;
                let (mut fetch, env) = network()?;
                fetch.extend(args(&SAFE_FETCH));
                fetch.extend(args(&[
                    "--",
                    &remote,
                    &format!("+refs/heads/{branch}:refs/remotes/{remote}/{branch}"),
                    // No `+`: Git itself refuses anything but a fast-forward, and
                    // refuses a branch checked out in any worktree.
                    &format!("refs/heads/{branch}:{local_ref}"),
                ]));
                let mut fetched = self
                    .write(&fetch, &env, &[], 0)
                    .and_then(|output| network_result(output, wsl && interactive))?;
                let after = resolve(self.location(), &local_ref).map_err(|error| {
                    Error::new(
                        "mutationUnverified",
                        format!("Fetch completed, but {local_ref} could not be read: {} Refresh before another action.", error.message),
                    )
                })?;
                if after == before {
                    if !fetched.output.is_empty() {
                        fetched.output.push('\n');
                    }
                    fetched.output.push_str("Already up to date.");
                }
                Ok(fetched)
            }
            RemoteAction::Pull { pull_mode, .. } => {
                let current = info.branch.as_ref().ok_or_else(|| {
                    Error::new("detachedHead", "Switch to a local branch before pulling.")
                })?;
                let branch = branch.or(tracking_branch).ok_or_else(|| {
                    Error::new(
                        "noUpstream",
                        "Configure an upstream or explicitly choose a remote branch to pull.",
                    )
                })?;
                self.remote_branch_name(branch)?;
                let expected_head = self.head_commit()?;
                // Fetch precisely one branch, then integrate its pinned object ID.
                // No merge/rebase ever runs after an uncertain or failed fetch.
                let (mut fetch, env) = network()?;
                let private_ref = format!("refs/gitty/pull/{}", uuid::Uuid::new_v4());
                fetch.extend(args(&SAFE_FETCH));
                fetch.extend(args(&[
                    "--",
                    &remote,
                    &format!("+refs/heads/{branch}:refs/remotes/{remote}/{branch}"),
                    &format!("refs/heads/{branch}:{private_ref}"),
                ]));
                let fetched = self.write(&fetch, &env, &[], 0)
                    .and_then(|output| network_result(output, wsl && interactive))
                    .map_err(|mut error| {
                        error.message.push_str(&format!("\nNo integration was attempted. An interrupted fetch may have retained {private_ref}; refresh and inspect before another action."));
                        error
                    })?;
                let incoming = resolve(self.location(), &private_ref).map_err(|error|
                    Error::new("mutationUnverified", format!("Fetch completed, but its private tip {private_ref} could not be read: {} No integration was attempted. Refresh and inspect before another action.", error.message)))?;
                let result = (|| -> Result<ActionOutput> {
                    if self.sync_branch()?.as_ref() != Some(current)
                        || self.head_commit()? != expected_head
                    {
                        return Err(Error::new("staleOperation", "HEAD or the checked-out branch changed during fetch. No integration was attempted; refresh before pulling again."));
                    }
                    self.require_writable()?;
                    if !self.unmerged()?.is_empty() {
                        return Err(Error::new(
                            "unresolvedConflict",
                            "Conflicts appeared during fetch. No integration was attempted.",
                        ));
                    }
                    let mut a = args(&[
                        // Branch mergeOptions can otherwise silently turn this
                        // explicitly selected mode into a squash/no-commit merge.
                        "-c",
                        &format!("branch.{current}.mergeOptions="),
                        "-c",
                        "core.editor=true",
                        "-c",
                        "sequence.editor=true",
                        "-c",
                        "merge.autoStash=false",
                        "-c",
                        "rebase.autoStash=false",
                        "-c",
                        "submodule.recurse=false",
                        "-c",
                        "rebase.abbreviateCommands=false",
                    ]);
                    match pull_mode {
                        PullMode::FfOnly | PullMode::Merge => {
                            a.extend(args(&[
                                "merge",
                                "--no-edit",
                                "--no-autostash",
                                "--no-overwrite-ignore",
                                if matches!(pull_mode, PullMode::FfOnly) {
                                    "--ff-only"
                                } else {
                                    "--ff"
                                },
                                "--",
                                &incoming,
                            ]));
                        }
                        PullMode::Rebase => {
                            if self
                                .status_entries()?
                                .entries
                                .iter()
                                .any(|entry| !entry.untracked)
                            {
                                return Err(Error::new(
                                "dirtyWorktree",
                                "Commit or stash staged and unstaged changes before pulling with rebase.",
                            ));
                            }
                            let range = format!("{incoming}..HEAD");
                            if !self
                                .check_text(&["rev-list", "--merges", &range, "--"])?
                                .is_empty()
                            {
                                return Err(Error::new("mergeHistory", "This pull would flatten local merge history. Rebase it explicitly in Git."));
                            }
                            let mut targets: Vec<String> = self
                                .check_text(&["rev-list", &range, "--"])?
                                .lines()
                                .map(String::from)
                                .collect();
                            targets.push(incoming.clone());
                            self.protect_untracked(&targets)?;
                            a.extend(args(&[
                                "rebase",
                                "--merge",
                                "--no-autostash",
                                "--no-update-refs",
                                "--no-rebase-merges",
                                "--no-autosquash",
                                "--no-fork-point",
                                &incoming,
                            ]));
                        }
                    }
                    let integrated = action_result(self.write(&a, &env, &[], 0)?)?;
                    Ok(ActionOutput {
                        output: [fetched.output, integrated.output]
                            .into_iter()
                            .filter(|s| !s.is_empty())
                            .collect::<Vec<_>>()
                            .join("\n"),
                    })
                })();
                // Expected-OID deletion cannot remove a ref another actor changed.
                // Cleanup is not integration: never turn a completed merge/rebase
                // into a retryable error or obscure its original failure.
                let cleanup = self.write(
                    &args(&["update-ref", "-d", &private_ref, &incoming]),
                    &[],
                    &[],
                    0,
                );
                let warning = match cleanup {
                    Ok(output) if output.success => None,
                    Ok(output) => Some(report(&output)),
                    Err(error) => Some(error.message),
                };
                match (result, warning) {
                    (Ok(mut output), Some(warning)) => {
                        output.output.push_str(&format!("\nIntegration completed. Temporary pull ref cleanup failed ({private_ref}): {warning}. Do not repeat the integration; refresh first."));
                        Ok(output)
                    }
                    (Err(mut error), Some(warning)) => {
                        error.message.push_str(&format!(
                            "\nTemporary pull ref cleanup also failed ({private_ref}): {warning}"
                        ));
                        Err(error)
                    }
                    (result, None) => result,
                }
            }
        }
    }
}

/// Nonzero exits can leave fetched refs or conflicts, or can follow a remote
/// accepting a push. The caller must refresh on *every* action result/error.
pub(crate) fn action_result(output: Output) -> Result<ActionOutput> {
    if !output.success {
        return Err(Error::new(
            "git",
            format!(
                "{}\nRefresh and review repository state before retrying.",
                report(&output)
            ),
        ));
    }
    Ok(ActionOutput {
        output: if output.stdout.is_empty() && output.stderr.is_empty() {
            String::new()
        } else {
            report(&output)
        },
    })
}

pub(crate) fn network_result(output: Output, wsl: bool) -> Result<ActionOutput> {
    action_result(output).map_err(|mut error| {
        if wsl {
            error.message.push_str("\nIf this failure is authentication-related: Gitty can prompt for WSL passwords only when Windows interop can run the Gitty executable, and it never prompts for SSH passphrases. A credential helper with its own sign-in window (such as Git Credential Manager) can still ask; otherwise configure a credential helper or SSH agent inside the distribution, then retry.");
        }
        error
    })
}

/// WSL actions without a scoped askpass bridge (no registry, or `wslpath` could not
/// translate the Gitty executable) cannot prompt through Gitty, but a credential
/// helper that opens its own window — typically Windows Git Credential Manager
/// reached through WSL interop — may sign the user in again. Terminal prompts,
/// askpass programs and SSH passphrase prompts stay disabled, so nothing can
/// wait on input Gitty cannot supply. Callers use this only for explicit WSL
/// actions in that fallback branch; background fetch never calls it.
pub(crate) fn allow_credential_helper_ui(a: &mut [String]) {
    for value in a.iter_mut() {
        if value == "credential.interactive=false" {
            *value = "credential.interactive=true".into();
        }
    }
}

/// `askpass` is the per-operation guard of a native interactive action; its token
/// (never the app-lifetime one) is what the helper process presents.
pub(crate) fn network_args(
    interactive: bool,
    askpass: Option<&crate::askpass::AskpassGuard<'_>>,
) -> (Vec<String>, Vec<(String, String)>) {
    let interactive = interactive && askpass.is_some();
    let mut a = args(&[
        "-c",
        "protocol.file.allow=always",
        "-c",
        "protocol.ssh.allow=always",
        "-c",
        "protocol.https.allow=always",
        "-c",
        "protocol.http.allow=always",
        "-c",
        "protocol.git.allow=always",
        "-c",
        "protocol.ext.allow=never",
        "-c",
        "ssh.variant=ssh",
        "-c",
        "fetch.recurseSubmodules=false",
        "-c",
        "submodule.recurse=false",
    ]);

    let mut env = Vec::new();
    if !interactive {
        // GCM environment settings override Git configuration; background work must stay silent.
        env.push(("GCM_INTERACTIVE".into(), "false".into()));
    }

    if let Some(guard) = askpass.filter(|_| interactive) {
        let registry = guard.registry();
        registry.ensure_script();
        a.extend(args(&[
            "-c",
            "core.sshCommand=ssh -oStrictHostKeyChecking=yes",
            "-c",
            "credential.interactive=true",
            "-c",
            &format!("core.askPass={}", registry.script_path.to_string_lossy()),
        ]));

        let script_path = registry.script_path.display().to_string();
        env.push(("GIT_ASKPASS".into(), script_path.clone()));
        env.push(("SSH_ASKPASS".into(), script_path));
        env.push(("SSH_ASKPASS_REQUIRE".into(), "force".into()));
        if std::env::var_os("DISPLAY").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_none() {
            env.push(("DISPLAY".into(), ":0".into()));
        }
        env.push(("GITTY_ASKPASS_PORT".into(), registry.port.to_string()));
        env.push(("GITTY_ASKPASS_TOKEN".into(), guard.token().to_string()));
    } else {
        a.extend(args(&[
            "-c",
            if interactive {
                "credential.interactive=true"
            } else {
                "credential.interactive=false"
            },
            "-c",
            "core.askPass=",
            "-c",
            "core.sshCommand=ssh -oBatchMode=yes -oStrictHostKeyChecking=yes",
        ]));
    }

    (a, env)
}

pub(crate) fn network_args_wsl(
    executable: &str,
    registry: &crate::askpass::AskpassRegistry,
    token: &str,
) -> (Vec<String>, Vec<(String, String)>) {
    let (mut args, mut env) = network_args(false, None);
    env.retain(|(key, _)| key != "GCM_INTERACTIVE");
    args.extend(crate::process::args(&[
        "-c",
        "credential.interactive=true",
        "-c",
        &format!("core.askPass={executable}"),
        "-c",
        "core.sshCommand=ssh -oBatchMode=no -oStrictHostKeyChecking=yes",
    ]));
    env.extend([
        ("GIT_ASKPASS".into(), executable.into()),
        ("SSH_ASKPASS".into(), executable.into()),
        ("SSH_ASKPASS_REQUIRE".into(), "force".into()),
        ("GITTY_ASKPASS_PORT".into(), registry.port.to_string()),
        ("GITTY_ASKPASS_TOKEN".into(), token.into()),
    ]);
    (args, env)
}

/// Short verb shown with askpass prompts ("fetch origin", "push origin").
fn action_verb(action: &RemoteAction) -> &'static str {
    match action {
        RemoteAction::Fetch { .. } | RemoteAction::BackgroundFetch => "fetch",
        RemoteAction::Pull { .. } => "pull",
        RemoteAction::Push { .. } | RemoteAction::PushTag { .. } => "push",
        RemoteAction::DeleteRemoteTag { .. } => "delete tag on",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headless_network_actions_never_invoke_an_implicit_prompt() {
        let (interactive, env) = network_args(true, None);
        assert!(interactive
            .iter()
            .any(|v| v == "credential.interactive=false"));
        assert!(interactive.iter().any(|v| v == "core.askPass="));
        assert!(interactive
            .iter()
            .any(|v| { v == "core.sshCommand=ssh -oBatchMode=yes -oStrictHostKeyChecking=yes" }));
        assert!(!env.iter().any(|(key, _)| {
            matches!(
                key.as_str(),
                "GIT_ASKPASS" | "SSH_ASKPASS" | "GITTY_ASKPASS_TOKEN"
            )
        }));
        assert!(env
            .iter()
            .any(|(key, value)| key == "GCM_INTERACTIVE" && value == "false"));
        let (background, env) = network_args(false, None);
        assert!(background
            .iter()
            .any(|v| v == "credential.interactive=false"));
        assert!(background.iter().any(|v| v == "core.askPass="));
        assert!(env
            .iter()
            .any(|(key, value)| key == "GCM_INTERACTIVE" && value == "false"));
    }

    #[test]
    fn credential_helper_ui_keeps_every_other_prompt_disabled() {
        let (mut a, env) = network_args(false, None);
        allow_credential_helper_ui(&mut a);
        assert!(env
            .iter()
            .any(|(key, value)| key == "GCM_INTERACTIVE" && value == "false"));
        assert!(a.iter().any(|v| v == "credential.interactive=true"));
        assert!(!a.iter().any(|v| v == "credential.interactive=false"));
        assert!(a.iter().any(|v| v == "core.askPass="));
        assert!(a
            .iter()
            .any(|v| v == "core.sshCommand=ssh -oBatchMode=yes -oStrictHostKeyChecking=yes"));
    }
}
