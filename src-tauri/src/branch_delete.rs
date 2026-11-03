use crate::{
    dto::{Error, RepositoryLocation, Result},
    process::{self, args},
    repository::{resolve, Repository, Service},
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Upper bound on one batch request; larger folders are reviewed in parts.
pub const MAX_BATCH_BRANCHES: usize = 500;

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchBatchDeleteItem {
    pub branch: String,
    pub expected_local_oid: Option<String>,
    pub expected_origin_oid: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchBatchDeleteRequest {
    pub branches: Vec<BranchBatchDeleteItem>,
    pub expected_head: Option<String>,
    pub expected_head_ref: Option<String>,
    pub expected_push_url: Option<String>,
    pub delete_local: bool,
    pub delete_origin: bool,
    /// Branch names, each already in `branches`, confirmed for forced local deletion.
    pub force_local: Vec<String>,
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
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchBatchDeleteOutcome {
    pub branch: String,
    pub local: Option<BranchDeleteTargetResult>,
    pub origin: Option<BranchDeleteTargetResult>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchBatchDeleteResult {
    pub branches: Vec<BranchBatchDeleteOutcome>,
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
fn origin_skipped(local: &BranchDeleteTargetResult) -> BranchDeleteTargetResult {
    outcome(
        "origin",
        "notAttempted",
        None,
        Some(if local.status == "unverified" {
            "Local deletion outcome is unverified; origin was left untouched.".into()
        } else {
            "Local deletion did not succeed; origin was left untouched.".into()
        }),
    )
}

/// Finds the porcelain status line for one pushed destination ref:
/// `<flag>\t<from>:<to>\t<summary>`.
fn porcelain_status<'a>(stdout: &'a str, destination: &str) -> Option<(&'a str, &'a str)> {
    stdout.lines().find_map(|line| {
        let mut fields = line.splitn(3, '\t');
        let flag = fields.next()?;
        let (_, to) = fields.next()?.split_once(':')?;
        (flag.len() == 1 && to == destination).then(|| (flag, fields.next().unwrap_or("")))
    })
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

    pub fn delete_branches(
        &self,
        handle: &str,
        request: BranchBatchDeleteRequest,
        askpass: Option<&crate::askpass::AskpassRegistry>,
    ) -> Result<BranchBatchDeleteResult> {
        self.mutate(handle, |repo| repo.delete_branches(request, askpass))
    }
}

impl Repository {
    /// Checks shared by single and batch deletion; returns the symbolic HEAD.
    fn deletion_preflight(
        &self,
        expected_head: &Option<String>,
        expected_head_ref: &Option<String>,
    ) -> Result<Option<String>> {
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
        if head != *expected_head || head_ref.as_deref() != expected_head_ref.as_deref() {
            return Err(Error::new(
                "staleOperation",
                "HEAD changed. Review the branch deletion again.",
            ));
        }
        Ok(head_ref)
    }

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
        let head_ref = self.deletion_preflight(&expected_head, &expected_head_ref)?;
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
        if delete_local && self.branch_checked_out(&local_ref)? {
            return Err(Error::new(
                "branchInUse",
                "This branch is checked out in a worktree.",
            ));
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
        if delete_local {
            let result =
                self.delete_local_checked(&branch, expected_local_oid.as_deref(), force_local);
            // Every local path (including successful commands whose verification
            // failed) must pass the same gate before any remote deletion is attempted.
            if result.status != "deleted" {
                let origin = delete_origin.then(|| origin_skipped(&result));
                return Ok(BranchDeleteResult {
                    local: Some(result),
                    origin,
                });
            }
            local = Some(result);
        }
        let mut origin = None;
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
                let (output, wsl) = self.push_origin_deletions(
                    &current_preflight.push_url,
                    format!("delete origin/{branch}"),
                    &[(branch.as_str(), current.as_str())],
                    askpass,
                )?;
                if !output.success {
                    return Err(crate::remote::network_result(output, wsl).unwrap_err());
                }
                Ok(self.remove_tracking_ref(&branch, &current))
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

    /// Deletes many branches under one mutation lock. Whole-request checks (HEAD,
    /// writability, operation state, origin destination) fail before any write;
    /// after that every branch reports its own outcome and the rest continue.
    fn delete_branches(
        &self,
        request: BranchBatchDeleteRequest,
        askpass: Option<&crate::askpass::AskpassRegistry>,
    ) -> Result<BranchBatchDeleteResult> {
        let BranchBatchDeleteRequest {
            branches,
            expected_head,
            expected_head_ref,
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
        if branches.is_empty() || branches.len() > MAX_BATCH_BRANCHES {
            return Err(Error::new(
                "invalidRequest",
                format!("Select between 1 and {MAX_BATCH_BRANCHES} branches to delete."),
            ));
        }
        if !force_local.is_empty() && !delete_local {
            return Err(Error::new(
                "invalidRequest",
                "Forced deletion applies only to local branch targets.",
            ));
        }
        let mut names = HashSet::new();
        for item in &branches {
            self.remote_branch_name(&item.branch)?;
            if !names.insert(item.branch.as_str()) {
                return Err(Error::new(
                    "invalidRequest",
                    "Each branch may appear only once.",
                ));
            }
            if delete_local && item.expected_local_oid.is_none()
                || delete_origin && item.expected_origin_oid.is_none()
            {
                return Err(Error::new(
                    "invalidRequest",
                    "Expected branch OIDs are required for selected targets.",
                ));
            }
        }
        if force_local
            .iter()
            .any(|name| !names.contains(name.as_str()))
        {
            return Err(Error::new(
                "invalidRequest",
                "Forced deletion may name only branches in this request.",
            ));
        }
        if delete_origin && expected_push_url.is_none() {
            return Err(Error::new(
                "invalidRequest",
                "The reviewed origin push URL is required.",
            ));
        }
        let head_ref = self.deletion_preflight(&expected_head, &expected_head_ref)?;
        let reviewed_url = if delete_origin {
            Some(self.origin_destination(expected_push_url.as_deref())?)
        } else {
            None
        };
        let forced: HashSet<&str> = force_local.iter().map(String::as_str).collect();
        let mut outcomes = Vec::with_capacity(branches.len());
        let mut pending = Vec::new();
        for item in &branches {
            let branch = item.branch.clone();
            let local_ref = format!("refs/heads/{branch}");
            let refuse = |error: Error| {
                let local =
                    delete_local.then(|| outcome("local", "failed", Some(error.clone()), None));
                let origin = delete_origin.then(|| {
                    if delete_local {
                        outcome(
                            "origin",
                            "notAttempted",
                            None,
                            Some("Local preflight failed; origin was left untouched.".into()),
                        )
                    } else {
                        outcome("origin", "failed", Some(error.clone()), None)
                    }
                });
                BranchBatchDeleteOutcome {
                    branch: branch.clone(),
                    local,
                    origin,
                }
            };
            if delete_local {
                let checked = (|| -> Result<()> {
                    if self.branch_oid(&local_ref)?.as_deref() != item.expected_local_oid.as_deref()
                    {
                        return Err(Error::new(
                            "staleOperation",
                            "The local branch changed. Review the deletion again.",
                        ));
                    }
                    if head_ref.as_deref() == Some(local_ref.as_str()) {
                        return Err(Error::new(
                            "currentBranch",
                            "Switch to another branch before deleting the current branch.",
                        ));
                    }
                    if self.branch_checked_out(&local_ref)? {
                        return Err(Error::new(
                            "branchInUse",
                            "This branch is checked out in a worktree.",
                        ));
                    }
                    Ok(())
                })();
                if let Err(error) = checked {
                    outcomes.push(refuse(error));
                    continue;
                }
            }
            if delete_origin {
                if let Err(error) =
                    self.origin_tracking(&branch, item.expected_origin_oid.as_deref())
                {
                    outcomes.push(BranchBatchDeleteOutcome {
                        branch,
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
                    });
                    continue;
                }
            }
            let local = delete_local.then(|| {
                self.delete_local_checked(
                    &branch,
                    item.expected_local_oid.as_deref(),
                    forced.contains(branch.as_str()),
                )
            });
            if let Some(result) = local.as_ref().filter(|result| result.status != "deleted") {
                let origin = delete_origin.then(|| origin_skipped(result));
                outcomes.push(BranchBatchDeleteOutcome {
                    branch,
                    local,
                    origin,
                });
                continue;
            }
            if delete_origin {
                pending.push(outcomes.len());
            }
            outcomes.push(BranchBatchDeleteOutcome {
                branch,
                local,
                origin: None,
            });
        }
        if pending.is_empty() {
            return Ok(BranchBatchDeleteResult { branches: outcomes });
        }
        let reviewed_url = reviewed_url.expect("origin destination preflighted");
        let destination = self.origin_destination(Some(&reviewed_url));
        let mut leased = Vec::new();
        for index in pending {
            let expected = branches
                .iter()
                .find(|item| item.branch == outcomes[index].branch)
                .and_then(|item| item.expected_origin_oid.clone());
            let checked = destination.clone().and_then(|_| {
                self.origin_tracking(&outcomes[index].branch, expected.as_deref())
                    .map_err(|_| {
                        Error::new(
                            "staleOperation",
                            "Origin branch changed during local deletion.",
                        )
                    })
            });
            match checked {
                Ok(oid) => leased.push((index, oid)),
                Err(error) => {
                    outcomes[index].origin = Some(outcome("origin", "failed", Some(error), None))
                }
            }
        }
        if leased.is_empty() {
            return Ok(BranchBatchDeleteResult { branches: outcomes });
        }
        let deletions: Vec<(&str, &str)> = leased
            .iter()
            .map(|(index, oid)| (outcomes[*index].branch.as_str(), oid.as_str()))
            .collect();
        let label = if deletions.len() == 1 {
            format!("delete origin/{}", deletions[0].0)
        } else {
            format!("delete {} origin branches", deletions.len())
        };
        let pushed = self.push_origin_deletions(&reviewed_url, label, &deletions, askpass);
        let results: Vec<BranchDeleteTargetResult> = match pushed {
            Err(error) => {
                let status = if error.code == "mutationUnverified" {
                    "unverified"
                } else {
                    "failed"
                };
                leased
                    .iter()
                    .map(|_| outcome("origin", status, Some(error.clone()), None))
                    .collect()
            }
            Ok((output, wsl)) => {
                let success = output.success;
                let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
                let failure = (!success)
                    .then(|| crate::remote::network_result(output, wsl).err())
                    .flatten()
                    .unwrap_or_else(|| Error::new("git", "Origin refused the deletion."));
                leased
                    .iter()
                    .map(|(index, oid)| {
                        let branch = &outcomes[*index].branch;
                        match porcelain_status(&stdout, &format!("refs/heads/{branch}")) {
                            Some(("-", _)) => outcome(
                                "origin",
                                "deleted",
                                None,
                                self.remove_tracking_ref(branch, oid),
                            ),
                            _ if success => outcome(
                                "origin",
                                "deleted",
                                None,
                                self.remove_tracking_ref(branch, oid),
                            ),
                            Some(("!", summary)) => outcome(
                                "origin",
                                "failed",
                                Some(Error::new(
                                    "git",
                                    format!("Origin refused deleting {branch}: {summary}"),
                                )),
                                None,
                            ),
                            _ => outcome("origin", "failed", Some(failure.clone()), None),
                        }
                    })
                    .collect()
            }
        };
        for ((index, _), result) in leased.iter().zip(results) {
            outcomes[*index].origin = Some(result);
        }
        Ok(BranchBatchDeleteResult { branches: outcomes })
    }

    /// Safe local deletion, then forced deletion only when requested and Git's
    /// refusal is verifiably the not-merged rule for the unchanged reviewed tip.
    fn delete_local_checked(
        &self,
        branch: &str,
        expected_local_oid: Option<&str>,
        force_local: bool,
    ) -> BranchDeleteTargetResult {
        let local_ref = format!("refs/heads/{branch}");
        match self.write(&args(&["branch", "-d", "--", branch]), &[], &[], 0) {
            Ok(out) if out.success => match self.branch_oid(&local_ref) {
                Ok(None) => outcome("local", "deleted", None, None),
                Ok(Some(_)) => outcome("local", "unverified", Some(Error::new("mutationUnverified", "The safe delete succeeded but the reviewed local ref still exists or moved.")), None),
                Err(error) => outcome("local", "unverified", Some(Error::new("mutationUnverified", format!("Safe deletion succeeded, but its result could not be verified: {}", error.message))), None),
            },
            Ok(out) => {
                let error = self.failed(&out);
                let actual = match self.branch_oid(&local_ref) {
                    Ok(actual) => actual,
                    Err(error) => {
                        return outcome("local", "unverified", Some(Error::new("mutationUnverified", format!("Safe deletion failed and the local ref could not be rechecked: {}", error.message))), None);
                    }
                };
                let unchanged = actual.as_deref() == expected_local_oid;
                let competing = self.branch_ref_lock_present(branch).unwrap_or(true)
                    || self.branch_checked_out(&local_ref).unwrap_or(true);
                let not_merged = unchanged
                    && !competing
                    && matches!(
                        self.branch_is_not_merged(branch, expected_local_oid),
                        Ok(true)
                    );
                if force_local && not_merged {
                    match self.write(&args(&["branch", "-D", "--", branch]), &[], &[], 0) {
                        Ok(forced) if forced.success => match self.branch_oid(&local_ref) {
                            Ok(None) => outcome("local", "deleted", None, None),
                            Ok(Some(_)) => outcome("local", "unverified", Some(Error::new("mutationUnverified", "The forced delete succeeded but the reviewed local ref still exists or moved.")), None),
                            Err(error) => outcome("local", "unverified", Some(Error::new("mutationUnverified", format!("Forced deletion succeeded, but its result could not be verified: {}", error.message))), None),
                        },
                        Ok(forced) => match self.branch_oid(&local_ref) {
                            Ok(after) if after.as_deref() != expected_local_oid => outcome("local", "unverified", Some(Error::new("mutationUnverified", "Forced deletion failed and the reviewed local ref changed.")), None),
                            Err(error) => outcome("local", "unverified", Some(Error::new("mutationUnverified", format!("Forced deletion failed and the local ref could not be rechecked: {}", error.message))), None),
                            Ok(_) => outcome("local", "failed", Some(self.failed(&forced)), None),
                        },
                        Err(error) => outcome("local", "unverified", Some(error), None),
                    }
                } else if !unchanged {
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
                }
            }
            Err(error) => outcome("local", "unverified", Some(error), None),
        }
    }

    /// One leased `git push` deleting every listed `(branch, expectedOid)` on origin.
    fn push_origin_deletions(
        &self,
        url: &str,
        label: String,
        deletions: &[(&str, &str)],
        askpass: Option<&crate::askpass::AskpassRegistry>,
    ) -> Result<(process::Output, bool)> {
        let wsl = matches!(self.location(), RepositoryLocation::Wsl { .. });
        // An SSH repository pushes from its own host with its own keys;
        // there is no local askpass bridge to lend it.
        let ssh = matches!(self.location(), RepositoryLocation::Ssh { .. });
        let mut a = Vec::new();
        crate::credentials::configure(&mut a, self.location(), url)?;
        let prompt_context =
            || crate::askpass::AskpassContext::new(&self.session.name, label.clone());
        #[cfg(windows)]
        let wsl_bridge = if let (RepositoryLocation::Wsl { distribution, .. }, Some(registry)) =
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
        let native_bridge = match (wsl || ssh, askpass) {
            (false, Some(registry)) => Some(registry.start_operation_with(prompt_context())),
            _ => None,
        };
        let (network, env) = match (&wsl_bridge, askpass) {
            (Some((path, guard)), Some(registry)) => {
                crate::remote::network_args_wsl(path, registry, guard.token())
            }
            _ => {
                let (mut network, env) = crate::remote::network_args(true, native_bridge.as_ref());
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
        ]));
        for (branch, oid) in deletions {
            a.push(format!("--force-with-lease=refs/heads/{branch}:{oid}"));
        }
        a.extend(args(&["--", "origin"]));
        for (branch, _) in deletions {
            a.push(format!(":refs/heads/{branch}"));
        }
        let output = self.write(&a, &env, &[], 0)?;
        Ok((output, wsl))
    }

    /// Removes the local tracking ref only if it still has the leased OID.
    fn remove_tracking_ref(&self, branch: &str, oid: &str) -> Option<String> {
        let cleanup = self.write(
            &args(&[
                "update-ref",
                "-d",
                &format!("refs/remotes/origin/{branch}"),
                oid,
            ]),
            &[],
            &[],
            0,
        );
        match cleanup {
            Ok(o) if o.success => None,
            _ => Some(
                "Remote branch deleted, but its local tracking ref could not be removed.".into(),
            ),
        }
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
        let push_url = self.origin_destination(expected_push_url)?;
        let tracking_oid = self.origin_tracking(branch, expected_oid)?;
        Ok(OriginPreflight {
            push_url,
            tracking_oid,
        })
    }

    /// Origin must have exactly the reviewed single push URL and not be a mirror.
    fn origin_destination(&self, expected_push_url: Option<&str>) -> Result<String> {
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
        Ok(push_url)
    }

    /// The locally known origin branch must still have the reviewed OID.
    fn origin_tracking(&self, branch: &str, expected_oid: Option<&str>) -> Result<String> {
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
        Ok(tracking_oid)
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
            // A destructive delete is worth a few round trips; the control
            // connection makes them cheap after the first one.
            RepositoryLocation::Ssh { .. } => {
                for path in locks {
                    for flag in ["-e", "-L"] {
                        let command = process::ssh_exec(
                            self.location(),
                            &[],
                            &["test".to_string(), flag.into(), path.clone()],
                        )?;
                        let out = process::run(command)?;
                        match out.code {
                            Some(0) => return Ok(true),
                            Some(1) => {}
                            _ => {
                                return Err(Error::new(
                                    "ssh",
                                    "Unable to verify Git ref-lock state on the remote host.",
                                ))
                            }
                        }
                    }
                }
                Ok(false)
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
