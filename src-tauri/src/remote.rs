//! Only these explicitly requested actions opt into network protocols. All
//! discovery, upstream counts and validation use the offline read contract.
use crate::{
    dto::{Error, Result},
    mutate::report,
    process::{self, args, Output},
    remote_dto::{ActionOutput, PullMode, RemoteAction, SyncInfo},
    repository::{resolve, Repository, Service},
};

impl Service {
    pub fn remote_action(&self, handle: &str, action: RemoteAction) -> Result<ActionOutput> {
        self.mutate(handle, |repo| repo.remote_action(action))
    }
}

impl Repository {
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
        let branch = self.sync_branch()?;
        let remotes = crate::repository::string(self.location(), &["remote"])?
            .lines()
            .map(String::from)
            .collect();
        let mut info = SyncInfo {
            branch,
            upstream: None,
            ahead: None,
            behind: None,
            remotes,
        };
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
                        &format!("HEAD...{}", fields[2]),
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

    fn remote_branch_name(&self, branch: &str) -> Result<()> {
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

    fn network_args() -> Vec<String> {
        args(&[
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
            "credential.interactive=false",
            "-c",
            "core.askPass=",
            // Use the existing SSH agent and config, but never prompt for keys,
            // passwords or unknown hosts. No credentials are retained by Gitty.
            "-c",
            "core.sshCommand=ssh -oBatchMode=yes -oStrictHostKeyChecking=yes",
            "-c",
            "ssh.variant=ssh",
            "-c",
            "fetch.recurseSubmodules=false",
            "-c",
            "submodule.recurse=false",
        ])
    }

    fn remote_action(&self, action: RemoteAction) -> Result<ActionOutput> {
        self.require_writable()?;
        if !self.unmerged()?.is_empty() {
            return Err(Error::new(
                "unresolvedConflict",
                "Resolve existing conflicts before syncing.",
            ));
        }
        let info = self.sync_info()?;
        let configured_remote = info
            .branch
            .as_ref()
            .map(|b| self.sync_config(&format!("branch.{b}.remote")))
            .transpose()?
            .flatten();
        let configured_branch = info
            .branch
            .as_ref()
            .map(|b| self.sync_config(&format!("branch.{b}.merge")))
            .transpose()?
            .flatten();
        let (remote, branch) = match &action {
            RemoteAction::Fetch { remote, branch }
            | RemoteAction::Pull { remote, branch, .. }
            | RemoteAction::Push { remote, branch, .. } => (remote.as_deref(), branch.as_deref()),
        };
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

        match &action {
            RemoteAction::Fetch { .. } => {
                let mut a = Self::network_args();
                a.extend(args(&[
                    "fetch",
                    "--no-all",
                    "--no-recurse-submodules",
                    "--no-prune",
                    "--no-prune-tags",
                    "--refmap=",
                    "--",
                    &remote,
                ]));
                // Ignore configured fetch refspecs (including mirror mappings
                // into local heads). Only remote-tracking branches may move.
                a.push(match branch {
                    Some(branch) => format!("refs/heads/{branch}:refs/remotes/{remote}/{branch}"),
                    None => format!("refs/heads/*:refs/remotes/{remote}/*"),
                });
                let output = self.write(&a, &[], 0)?;
                action_result(output)
            }
            RemoteAction::Push { set_upstream, .. } => {
                let current = info.branch.as_deref().ok_or_else(|| {
                    Error::new("detachedHead", "Switch to a local branch before pushing.")
                })?;
                self.remote_branch_name(current)?;
                resolve(self.location(), &format!("refs/heads/{current}"))?;
                if tracking_branch.is_none() && !set_upstream {
                    return Err(Error::new(
                        "noUpstream",
                        "Publish this branch with setUpstream enabled for its first push.",
                    ));
                }
                let destination = branch.or(tracking_branch).unwrap_or(current);
                self.remote_branch_name(destination)?;
                // Even an explicit refspec does not neutralize remote.*.mirror.
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
                let urls =
                    self.check_text(&["remote", "get-url", "--push", "--all", "--", &remote])?;
                if urls.lines().count() != 1 {
                    return Err(Error::new(
                        "multiplePushUrls",
                        "Choose a remote with exactly one push URL.",
                    ));
                }
                let mut a = Self::network_args();
                a.extend(args(&[
                    "push",
                    "--porcelain",
                    "--no-force",
                    "--no-mirror",
                    "--no-follow-tags",
                    "--recurse-submodules=no",
                ]));
                if *set_upstream {
                    a.push("--set-upstream".into());
                }
                a.extend(args(&[
                    "--",
                    &remote,
                    &format!("refs/heads/{current}:refs/heads/{destination}"),
                ]));
                action_result(self.write(&a, &[], 0)?)
            }
            RemoteAction::Pull { pull_mode, .. } => {
                let current = info.branch.as_ref().ok_or_else(|| {
                    Error::new("detachedHead", "Switch to a local branch before pulling.")
                })?;
                if !self.status_entries()?.entries.is_empty() {
                    return Err(Error::new("dirtyWorktree", "Commit or explicitly stash staged, unstaged and untracked changes before pulling."));
                }
                let branch = branch.or(tracking_branch).ok_or_else(|| {
                    Error::new(
                        "noUpstream",
                        "Configure an upstream or explicitly choose a remote branch to pull.",
                    )
                })?;
                self.remote_branch_name(branch)?;
                // Fetch precisely one branch, then integrate its pinned object ID.
                // No merge/rebase ever runs after an uncertain or failed fetch.
                let mut fetch = Self::network_args();
                fetch.extend(args(&[
                    "fetch",
                    "--no-all",
                    "--no-recurse-submodules",
                    "--no-tags",
                    "--no-prune",
                    "--no-prune-tags",
                    "--refmap=",
                    "--",
                    &remote,
                    &format!("refs/heads/{branch}:refs/remotes/{remote}/{branch}"),
                ]));
                let fetched = action_result(self.write(&fetch, &[], 0)?)?;
                let incoming = resolve(self.location(), "FETCH_HEAD")?;
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
                let integrated = action_result(self.write(&a, &[], 0)?)?;
                Ok(ActionOutput {
                    output: [fetched.output, integrated.output]
                        .into_iter()
                        .filter(|s| !s.is_empty())
                        .collect::<Vec<_>>()
                        .join("\n"),
                })
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
