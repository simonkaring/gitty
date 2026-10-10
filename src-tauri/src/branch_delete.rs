use crate::{
    dto::{Error, RepositoryLocation, Result},
    process::{self, args},
    repository::{resolve, Repository, Service},
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchDeleteRequest {
    pub branch: String,
    pub expected_head: Option<String>,
    pub expected_head_ref: Option<String>,
    pub expected_local_oid: Option<String>,
    pub expected_origin_oid: Option<String>,
    pub expected_push_url: Option<String>,
    pub delete_local: bool,
    pub delete_origin: bool,
    pub force_local: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchDeleteTargetResult {
    pub target: &'static str,
    pub status: &'static str,
    pub error: Option<Error>,
    pub note: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchDeleteResult {
    pub local: Option<BranchDeleteTargetResult>,
    pub origin: Option<BranchDeleteTargetResult>,
}

struct OriginPreflight {
    push_url: String,
    tracking_oid: String,
}
fn outcome(
    target: &'static str,
    status: &'static str,
    error: Option<Error>,
    note: Option<String>,
) -> BranchDeleteTargetResult {
    BranchDeleteTargetResult {
        target,
        status,
        error,
        note,
    }
}

impl Service {
    pub fn delete_branch(
        &self,
        handle: &str,
        request: BranchDeleteRequest,
        askpass: Option<&crate::askpass::AskpassRegistry>,
    ) -> Result<BranchDeleteResult> {
        self.mutate(handle, |repo| repo.delete_branch(request, askpass))
    }
}

impl Repository {
    fn delete_branch(
        &self,
        request: BranchDeleteRequest,
        askpass: Option<&crate::askpass::AskpassRegistry>,
    ) -> Result<BranchDeleteResult> {
        let BranchDeleteRequest {
            branch,
            expected_head,
            expected_head_ref,
            expected_local_oid,
            expected_origin_oid,
            expected_push_url,
            delete_local,
            delete_origin,
            force_local,
        } = request;
        if !delete_local && !delete_origin {
            return Err(Error::new(
                "invalidRequest",
                "Select a branch target to delete.",
            ));
        }
        if force_local && !delete_local {
            return Err(Error::new(
                "invalidRequest",
                "Forced deletion applies only to the local branch target.",
            ));
        }
        self.remote_branch_name(&branch)?;
        if delete_local && expected_local_oid.is_none()
            || delete_origin && (expected_origin_oid.is_none() || expected_push_url.is_none())
        {
            return Err(Error::new(
                "invalidRequest",
                "Expected branch OIDs and push URL are required for selected targets.",
            ));
        }
        self.require_writable()?;
        if self.session.bare {
            return Err(Error::new(
                "bareRepository",
                "Branches cannot be deleted from a bare repository.",
            ));
        }
        if !self.unmerged()?.is_empty() {
            return Err(Error::new(
                "unresolvedConflict",
                "Resolve conflicts before deleting a branch.",
            ));
        }
        let op = self.operation_state()?;
        if op.kind != crate::operation_dto::OperationKind::None || !op.conflicts.is_empty() {
            return Err(Error::new(
                "operationInProgress",
                "Finish or abort the current Git operation before deleting a branch.",
            ));
        }
        let head = self.head_commit()?;
        let symbolic = self.check(&["symbolic-ref", "--quiet", "HEAD"])?;
        let head_ref = match symbolic.code {
            Some(0) => Some(process::text(symbolic.stdout)?.trim_end().to_owned()),
            Some(1) => None,
            _ => return Err(self.failed(&symbolic)),
        };
        if head != expected_head || head_ref.as_deref() != expected_head_ref.as_deref() {
            return Err(Error::new(
                "staleOperation",
                "HEAD changed. Review the branch deletion again.",
            ));
        }
        let local_ref = format!("refs/heads/{branch}");
        if let Some(expected) = &expected_local_oid {
            if self.branch_oid(&local_ref)?.as_deref() != Some(expected) {
                return Err(Error::new(
                    "staleOperation",
                    "The local branch changed. Review the deletion again.",
                ));
            }
        }
        if delete_local && head_ref.as_deref() == Some(local_ref.as_str()) {
            return Err(Error::new(
                "currentBranch",
                "Switch to another branch before deleting the current branch.",
            ));
        }
        if delete_local {
            if self.branch_checked_out(&local_ref)? {
                return Err(Error::new(
                    "branchInUse",
                    "This branch is checked out in a worktree.",
                ));
            }
        }
        let mut origin_preflight = None;
        if delete_origin {
            match self.origin_preflight(
                &branch,
                expected_origin_oid.as_deref(),
                expected_push_url.as_deref(),
            ) {
                Ok(value) => origin_preflight = Some(value),
                Err(error) => {
                    return Ok(BranchDeleteResult {
                        local: delete_local.then(|| {
                            outcome(
                                "local",
                                "notAttempted",
                                None,
                                Some(
                                    "Origin preflight failed; local deletion was not started."
                                        .into(),
                                ),
                            )
                        }),
                        origin: Some(outcome("origin", "failed", Some(error), None)),
                    })
                }
            }
        }
        let mut local = None;
        let mut origin = None;
        if delete_local {
            let out = self.write(&args(&["branch", "-d", "--", &branch]), &[], &[], 0);
            match out {
                Ok(out) if out.success => {
                    local = Some(match self.branch_oid(&local_ref) {
                        Ok(None) => outcome("local", "deleted", None, None),
                        Ok(Some(_)) => outcome("local", "unverified", Some(Error::new("mutationUnverified", "The safe delete succeeded but the reviewed local ref still exists or moved.")), None),
                        Err(error) => outcome("local", "unverified", Some(Error::new("mutationUnverified", format!("Safe deletion succeeded, but its result could not be verified: {}", error.message))), None),
                    });
                }
                Ok(out) => {
                    let error = self.failed(&out);
                    let actual = match self.branch_oid(&local_ref) {
                        Ok(actual) => actual,
                        Err(error) => {
                            local = Some(outcome("local", "unverified", Some(Error::new("mutationUnverified", format!("Safe deletion failed and the local ref could not be rechecked: {}", error.message))), None));
                            if delete_origin {
                                origin = Some(outcome(
                                    "origin",
                                    "notAttempted",
                                    None,
                                    Some("Local deletion outcome is unverified.".into()),
                                ));
                            }
                            return Ok(BranchDeleteResult { local, origin });
                        }
                    };
                    let unchanged = actual.as_deref() == expected_local_oid.as_deref();
                    let competing = self.branch_ref_lock_present(&branch).unwrap_or(true)
                        || self.branch_checked_out(&local_ref).unwrap_or(true);
                    let not_merged = unchanged
                        && !competing
                        && matches!(
                            self.branch_is_not_merged(&branch, expected_local_oid.as_deref()),
                            Ok(true)
                        );
                    if force_local && not_merged {
                        local = Some(
                            match self.write(&args(&["branch", "-D", "--", &branch]), &[], &[], 0) {
                                Ok(forced) if forced.success => match self.branch_oid(&local_ref) {
                                    Ok(None) => outcome("local", "deleted", None, None),
                                    Ok(Some(_)) => outcome("local", "unverified", Some(Error::new("mutationUnverified", "The forced delete succeeded but the reviewed local ref still exists or moved.")), None),
                                    Err(error) => outcome("local", "unverified", Some(Error::new("mutationUnverified", format!("Forced deletion succeeded, but its result could not be verified: {}", error.message))), None),
                                },
                                Ok(forced) => match self.branch_oid(&local_ref) {
                                    Ok(after) if after.as_deref() != expected_local_oid.as_deref() => outcome("local", "unverified", Some(Error::new("mutationUnverified", "Forced deletion failed and the reviewed local ref changed.")), None),
                                    Err(error) => outcome("local", "unverified", Some(Error::new("mutationUnverified", format!("Forced deletion failed and the local ref could not be rechecked: {}", error.message))), None),
                                    Ok(_) => outcome("local", "failed", Some(self.failed(&forced)), None),
                                },
                                Err(error) => outcome("local", "unverified", Some(error), None),
                            },
                        );
                    } else {
                        local = Some(if !unchanged {
                            outcome(
                                "local",
                                "unverified",
                                Some(Error::new(
                                    "mutationUnverified",
                                    "Safe deletion failed and the reviewed local ref changed.",
                                )),
                                None,
                            )
                        } else if not_merged {
                            outcome("local", "failed", Some(Error::new("branchNotMerged", "Git's safe delete refused because the branch is not merged into its configured upstream (if resolvable), otherwise HEAD.")), None)
                        } else {
                            outcome("local", "failed", Some(error), None)
                        });
                    }
                    if local
                        .as_ref()
                        .is_some_and(|result| result.status != "deleted")
                    {
                        if delete_origin {
                            origin = Some(outcome(
                                "origin",
                                "notAttempted",
                                None,
                                Some("Local deletion did not succeed.".into()),
                            ));
                        }
                        return Ok(BranchDeleteResult { local, origin });
                    }
                }
                Err(error) => {
                    local = Some(outcome("local", "unverified", Some(error), None));
                    if delete_origin {
                        origin = Some(outcome(
                            "origin",
                            "notAttempted",
                            None,
                            Some("Local deletion outcome is unverified.".into()),
                        ));
                    }
                    return Ok(BranchDeleteResult { local, origin });
                }
            }
        }
        if delete_origin {
            let result = (|| -> Result<_> {
                let current_preflight = self.origin_preflight(
                    &branch,
                    expected_origin_oid.as_deref(),
                    expected_push_url.as_deref(),
                )?;
                let reviewed = origin_preflight
                    .as_ref()
                    .expect("origin target preflighted before local mutation");
                if current_preflight.tracking_oid != reviewed.tracking_oid
                    || current_preflight.push_url != reviewed.push_url
                {
                    return Err(Error::new(
                        "staleOperation",
                        "Origin branch or push destination changed during local deletion.",
                    ));
                }
                let current = current_preflight.tracking_oid;
                let url = current_preflight.push_url;
                let wsl = matches!(self.location(), RepositoryLocation::Wsl { .. });
                let mut a = Vec::new();
                crate::credentials::configure(&mut a, self.location(), &url)?;
                let prompt_context = || {
                    crate::askpass::AskpassContext::new(
                        &self.session.name,
                        format!("delete origin/{branch}"),
                    )
                };
                #[cfg(windows)]
                let wsl_bridge =
                    if let (RepositoryLocation::Wsl { distribution, .. }, Some(registry)) =
                        (self.location(), askpass)
                    {
                        crate::askpass::wsl_executable_path(distribution)
                            .ok()
                            .map(|path| (path, registry.start_operation_with(prompt_context())))
                    } else {
                        None
                    };
                #[cfg(not(windows))]
                let wsl_bridge: Option<(String, crate::askpass::AskpassGuard<'_>)> = None;
                let native_bridge = match (wsl, askpass) {
                    (false, Some(registry)) => {
                        Some(registry.start_operation_with(prompt_context()))
                    }
                    _ => None,
                };
                let (network, env) = match (&wsl_bridge, askpass) {
                    (Some((path, guard)), Some(registry)) => {
                        crate::remote::network_args_wsl(path, registry, guard.token())
                    }
                    _ => {
                        let (mut network, env) =
                            crate::remote::network_args(true, native_bridge.as_ref());
                        if wsl {
                            crate::remote::allow_credential_helper_ui(&mut network);
                        }
                        (network, env)
                    }
                };
                a.extend(network);
                a.extend(args(&[
                    "push",
                    "--porcelain",
                    "--no-force",
                    "--no-mirror",
                    "--no-follow-tags",
                    "--recurse-submodules=no",
                    &format!("--force-with-lease=refs/heads/{branch}:{current}"),
                    "--",
                    "origin",
                    &format!(":refs/heads/{branch}"),
                ]));
                let output = self.write(&a, &env, &[], 0)?;
                if !output.success {
                    return Err(crate::remote::network_error(output, wsl).unwrap_err());
                }
                let cleanup = self.write(
                    &args(&[
                        "update-ref",
                        "-d",
                        &format!("refs/remotes/origin/{branch}"),
                        &current,
                    ]),
                    &[],
                    &[],
                    0,
                );
                let note = match cleanup {
                    Ok(o) if o.success => None,
                    _ => Some(
                        "Remote branch deleted, but its local tracking ref could not be removed."
                            .into(),
                    ),
                };
                Ok(note)
            })();
            origin = Some(match result {
                Ok(note) => outcome("origin", "deleted", None, note),
                Err(error) => outcome(
                    "origin",
                    if error.code == "mutationUnverified" {
                        "unverified"
                    } else {
                        "failed"
                    },
                    Some(error),
                    None,
                ),
            });
        }
        Ok(BranchDeleteResult { local, origin })
    }

    fn branch_oid(&self, full_ref: &str) -> Result<Option<String>> {
        let out = self.check(&[
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            &format!("{full_ref}^{{commit}}"),
        ])?;
        match out.code {
            Some(0) => Ok(Some(process::text(out.stdout)?.trim_end().to_owned())),
            Some(1) => Ok(None),
            _ => Err(self.failed(&out)),
        }
    }

    fn branch_checked_out(&self, full_ref: &str) -> Result<bool> {
        let worktrees = self.check_text(&["worktree", "list", "--porcelain"])?;
        Ok(worktrees
            .lines()
            .filter_map(|line| line.strip_prefix("branch "))
            .any(|branch| branch == full_ref))
    }

    fn origin_preflight(
        &self,
        branch: &str,
        expected_oid: Option<&str>,
        expected_push_url: Option<&str>,
    ) -> Result<OriginPreflight> {
        let push_url = self.check_text(&["remote", "get-url", "--push", "--", "origin"])?;
        let all_urls =
            self.check_text(&["remote", "get-url", "--push", "--all", "--", "origin"])?;
        if all_urls.lines().count() != 1 {
            return Err(Error::new(
                "multiplePushUrls",
                "Origin must have exactly one push URL.",
            ));
        }
        let push_url = push_url.trim_end().to_owned();
        if Some(push_url.as_str()) != expected_push_url {
            return Err(Error::new(
                "staleOperation",
                "Origin push URL changed. Review the deletion again.",
            ));
        }
        let mirror = self.check(&["config", "--bool", "--get", "remote.origin.mirror"])?;
        if mirror.success && process::text_ref(&mirror.stdout)?.trim() == "true" {
            return Err(Error::new(
                "mirrorRemote",
                "Mirror remotes cannot be pushed from Gitty.",
            ));
        }
        if !mirror.success && mirror.code != Some(1) {
            return Err(self.failed(&mirror));
        }
        let full_ref = format!("refs/remotes/origin/{branch}");
        let tracking_oid = self.branch_oid(&full_ref)?.ok_or_else(|| {
            Error::new(
                "staleOperation",
                "The locally known origin branch no longer exists. Review the deletion again.",
            )
        })?;
        if Some(tracking_oid.as_str()) != expected_oid {
            return Err(Error::new(
                "staleOperation",
                "The locally known origin branch changed. Review the deletion again.",
            ));
        }
        Ok(OriginPreflight {
            push_url,
            tracking_oid,
        })
    }

    fn branch_ref_lock_present(&self, branch: &str) -> Result<bool> {
        let root = self.session.common_dir.trim_end_matches(['/', '\\']);
        let locks = [
            format!("{root}/refs/heads/{branch}.lock"),
            format!("{root}/packed-refs.lock"),
            format!("{root}/reftable/tables.list.lock"),
        ];
        match self.location() {
            RepositoryLocation::Native { .. } => {
                for path in &locks {
                    match std::fs::symlink_metadata(path) {
                        Ok(_) => return Ok(true),
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => return Err(error.into()),
                    }
                }
                Ok(false)
            }
            RepositoryLocation::Wsl { distribution, .. } => {
                #[cfg(windows)]
                {
                    crate::process::validate_distribution(distribution)?;
                    for path in locks {
                        let mut command = std::process::Command::new("wsl.exe");
                        command.args([
                            "--distribution",
                            distribution,
                            "--exec",
                            "test",
                            "-e",
                            &path,
                        ]);
                        let out = process::run(command)?;
                        match out.code {
                            Some(0) => return Ok(true),
                            Some(1) => {
                                let mut symlink = std::process::Command::new("wsl.exe");
                                symlink.args([
                                    "--distribution",
                                    distribution,
                                    "--exec",
                                    "test",
                                    "-L",
                                    &path,
                                ]);
                                let out = process::run(symlink)?;
                                match out.code {
                                    Some(0) => return Ok(true),
                                    Some(1) => {}
                                    _ => {
                                        return Err(Error::new(
                                            "wsl",
                                            "Unable to verify Git ref-lock state.",
                                        ))
                                    }
                                }
                            }
                            _ => {
                                return Err(Error::new(
                                    "wsl",
                                    "Unable to verify Git ref-lock state.",
                                ))
                            }
                        }
                    }
                    Ok(false)
                }
                #[cfg(not(windows))]
                {
                    let _ = distribution;
                    Err(Error::new(
                        "unsupportedPlatform",
                        "WSL ref-lock checks require Windows.",
                    ))
                }
            }
        }
    }

    fn branch_is_not_merged(&self, branch: &str, oid: Option<&str>) -> Result<bool> {
        let Some(oid) = oid else { return Ok(false) };
        let upstream = self.check_text(&[
            "for-each-ref",
            "--format=%(upstream)",
            &format!("refs/heads/{branch}"),
        ])?;
        let destination = if upstream.is_empty() {
            "HEAD".to_string()
        } else {
            match resolve(self.location(), &upstream) {
                Ok(value) => value,
                Err(_) => "HEAD".into(),
            }
        };
        let check = self.check(&["merge-base", "--is-ancestor", oid, &destination])?;
        match check.code {
            Some(0) => Ok(false),
            Some(1) => Ok(true),
            _ => Err(self.failed(&check)),
        }
    }
}
