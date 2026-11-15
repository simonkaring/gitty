use crate::{
    clone_dto::CloneProgress,
    dto::{self, *},
    events::{EventEnvelope, EventQueue},
    mutate, process,
    protocol::{self, parse_params},
    repository::Service,
    watcher::Watchers,
};
use std::{path::PathBuf, sync::Arc, thread, time::Duration};

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableReview {
    pub version: u8,
    pub method: String,
    pub location: dto::RepositoryLocation,
    pub root: String,
    pub common_dir: String,
    pub expected_head: Option<String>,
    pub expected_head_ref: Option<String>,
    pub expected_status_fingerprint: String,
    pub params: serde_json::Value,
    pub worktree_token: Option<String>,
    pub preview: Option<String>,
}

/// Restricted, non-interactive repository API for the local agent CLI.
pub struct AgentService {
    service: Service,
    events: Arc<EventQueue>,
    watchers: Watchers,
    accounts: Option<Arc<crate::provider_accounts::AccountStore>>,
    oauth: crate::provider_oauth::OAuth,
    askpass: Option<Arc<crate::askpass::AskpassRegistry>>,
    editor: Option<Arc<crate::editor::EditorRegistry>>,
}

fn agent_value(value: impl serde::Serialize) -> Result<serde_json::Value> {
    serde_json::to_value(value).map_err(|error| dto::Error::new("serialization", error.to_string()))
}

impl AgentService {
    pub fn new(data_dir: std::path::PathBuf) -> Self {
        Self::with_accounts(data_dir, None)
    }

    /// Enables explicit access to the OS keyring-backed account store. The
    /// default constructor never reads accounts or credentials.
    pub fn with_system_accounts(data_dir: PathBuf, accounts_path: PathBuf) -> Self {
        Self::with_accounts(
            data_dir,
            Some(Arc::new(crate::provider_accounts::AccountStore::new(
                accounts_path,
            ))),
        )
    }

    fn with_accounts(
        data_dir: PathBuf,
        accounts: Option<Arc<crate::provider_accounts::AccountStore>>,
    ) -> Self {
        let events = Arc::new(EventQueue::default());
        let watcher_events = events.clone();
        Self {
            service: Service::new(data_dir),
            watchers: Watchers::new(move |handle| {
                watcher_events.push("repository_changed", serde_json::json!({"handle":handle}));
            }),
            events,
            accounts,
            oauth: crate::provider_oauth::OAuth::default(),
            askpass: None,
            editor: None,
        }
    }

    /// Enables scoped askpass/editor events. No prompt listener is opened by
    /// default; the caller must also route reply requests from its reader thread.
    pub fn with_event_prompts(mut self) -> std::io::Result<Self> {
        let (askpass_listener, askpass) = crate::askpass::bind()?;
        let (editor_listener, editor) = match crate::editor::bind() {
            Ok(bound) => bound,
            Err(error) => {
                askpass.cleanup();
                return Err(error);
            }
        };
        let events = self.events.clone();
        let expired_events = events.clone();
        let askpass_events = events.clone();
        let askpass_server = askpass.clone();
        thread::Builder::new()
            .name("gitty-agent-askpass".into())
            .spawn(move || {
                crate::askpass::serve(
                    askpass_listener,
                    askpass_server,
                    move |request_id, prompt, context| {
                        askpass_events.push(
                            "askpass_prompt",
                            serde_json::json!({
                                "requestId": request_id,
                                "prompt": prompt,
                                "context": context,
                                "replyMethod": "repository_prompt_reply"
                            }),
                        );
                        Ok(())
                    },
                    move |request_id| {
                        expired_events.push(
                            "askpass_expired",
                            serde_json::json!({"requestId":request_id}),
                        );
                    },
                );
            })?;
        let editor_events = events.clone();
        let expired_events = events.clone();
        let editor_server = editor.clone();
        thread::Builder::new()
            .name("gitty-agent-editor".into())
            .spawn(move || {
                crate::editor::serve(
                    editor_listener,
                    editor_server,
                    move |request_id, file_name, content| {
                        editor_events.push(
                            "editor_prompt",
                            serde_json::json!({
                                "requestId": request_id,
                                "fileName": file_name,
                                "content": content,
                                "replyMethod": "repository_prompt_reply"
                            }),
                        );
                        Ok(())
                    },
                    move |request_id| {
                        expired_events.push(
                            "editor_expired",
                            serde_json::json!({"requestId":request_id}),
                        );
                    },
                );
            })?;
        self.askpass = Some(askpass);
        self.editor = Some(editor);
        Ok(self)
    }

    pub fn next_event(&self, timeout: Duration) -> Option<EventEnvelope> {
        self.events.recv(timeout)
    }

    pub fn accounts_enabled(&self) -> bool {
        self.accounts.is_some()
    }

    pub fn prompts_enabled(&self) -> bool {
        self.askpass.is_some() && self.editor.is_some()
    }

    /// Installs the process activity sink for this CLI process. The callback is
    /// deliberately opt-in; ordinary one-shot invocations do not emit events.
    pub fn enable_activity_events(&self) {
        let events = self.events.clone();
        process::set_git_log(move |log| events.push("git_command", log));
    }

    pub fn shutdown(&self) {
        self.watchers.stop_all();
        self.service.cancel_all_clones();
        self.service.cancel_all_commit_graphs();
        self.service.close_all();
        if let Some(registry) = &self.askpass {
            registry.cancel_all();
            registry.cleanup();
        }
        if let Some(registry) = &self.editor {
            registry.cancel_all();
            registry.cleanup();
        }
    }

    pub fn review(
        &self,
        handle: &str,
        method: &str,
        params: serde_json::Value,
    ) -> Result<PortableReview> {
        process::request(|| self.review_inner(handle, method, params))
    }

    fn review_inner(
        &self,
        handle: &str,
        method: &str,
        params: serde_json::Value,
    ) -> Result<PortableReview> {
        let params = protocol::validate_portable_params(method, params)?;
        let repo = self.service.repo(handle)?;
        let status = repo.status()?;
        let session = &repo.session;
        let mut worktree_token = None;
        let mut preview = None;
        if method == "repository_worktree_execute" {
            let request = params
                .get("request")
                .cloned()
                .ok_or_else(|| dto::Error::new("invalidRequest", "request is required"))?;
            let review = self.dispatch(
                "repository_worktree_review",
                serde_json::json!({"handle":handle,"request":request}),
            )?;
            worktree_token = review["token"].as_str().map(str::to_owned);
            preview = review["preview"].as_str().map(str::to_owned);
            if worktree_token.is_none() {
                return Err(dto::Error::new(
                    "serialization",
                    "worktree review returned no token",
                ));
            }
        }
        Ok(PortableReview {
            version: 1,
            method: method.to_string(),
            location: session.location.clone(),
            root: session.root.clone(),
            common_dir: session.common_dir.clone(),
            expected_head: status.head,
            expected_head_ref: status.head_ref,
            expected_status_fingerprint: status.fingerprint,
            params,
            worktree_token,
            preview,
        })
    }

    pub fn execute_review(&self, review: PortableReview) -> Result<serde_json::Value> {
        process::request(|| self.execute_review_inner(review))
    }

    fn execute_review_inner(&self, review: PortableReview) -> Result<serde_json::Value> {
        if review.version != 1 {
            return Err(dto::Error::new(
                "invalidReview",
                "Unsupported portable review version",
            ));
        }
        let validated =
            crate::protocol::validate_portable_params(&review.method, review.params.clone())
                .map_err(|_| {
                    dto::Error::new("invalidReview", "Review action params are invalid")
                })?;
        let mut params = validated.as_object().unwrap().clone();
        let opened = self.service.open(review.location.clone())?;
        let handle = opened.session.handle;
        let result = self.service.mutate_reviewed(&handle, |repo| {
            let status = repo.status()?;
            if repo.session.root != review.root
                || repo.session.common_dir != review.common_dir
                || status.head != review.expected_head
                || status.head_ref != review.expected_head_ref
                || status.fingerprint != review.expected_status_fingerprint
            {
                return Err(dto::Error::new(
                    "staleOperation",
                    "Repository identity or reviewed state changed. Review the action again.",
                ));
            }
            if review.method == "repository_worktree_execute" {
                let request: crate::worktrees::WorktreeRequest =
                    serde_json::from_value(params.get("request").cloned().ok_or_else(|| {
                        dto::Error::new("invalidReview", "Worktree request is missing")
                    })?)
                    .map_err(|_| dto::Error::new("invalidReview", "Worktree request is invalid"))?;
                let current = repo.worktree_review(&request)?;
                if review.worktree_token.as_deref() != Some(current.token.as_str()) {
                    return Err(dto::Error::new(
                        "staleOperation",
                        "Worktree review changed. Review the action again.",
                    ));
                }
                params.insert("token".into(), serde_json::json!(current.token));
            }
            params.insert("handle".into(), serde_json::json!(handle));
            self.dispatch(&review.method, serde_json::Value::Object(params))
        });
        self.watchers.stop(&handle);
        let _ = self.service.close(&handle);
        result
    }

    pub fn dispatch(&self, method: &str, params: serde_json::Value) -> Result<serde_json::Value> {
        process::request(|| {
            if matches!(
                method,
                "repository_pick"
                    | "repository_pick_clone_parent"
                    | "repository_open_path"
                    | "repository_reveal_path"
                    | "open_external_url"
                    | "askpass::repository_provide_password"
                    | "editor::editor_reply"
                    | "app_start_dragging"
                    | "app_window_button_layout"
                    | "app_launch_path"
            ) {
                return Err(dto::Error::new(
                    "desktopOnly",
                    "This operation requires the desktop host",
                ));
            }
            let accounts = || {
                self.accounts.as_ref().ok_or_else(|| {
                    dto::Error::new("accountPolicy", "System account access is disabled")
                })
            };
            let handle = |params| parse_params::<protocol::Handle>(params).map(|p| p.handle);
            match method {
                "repository_open" => {
                    let p: protocol::Open = parse_params(params)?;
                    agent_value(self.service.open(p.location)?)
                }
                "repository_close" => {
                    let handle = handle(params)?;
                    self.watchers.stop(&handle);
                    self.service.close(&handle)?;
                    Ok(serde_json::Value::Null)
                }
                "repository_clone" => {
                    let p: protocol::Clone = parse_params(params)?;
                    let credential = match (&p.request.account_id, &self.accounts) {
                        (Some(_), None) => {
                            return Err(dto::Error::new(
                                "accountPolicy",
                                "Enable the system account policy before selecting an account",
                            ))
                        }
                        (Some(_), Some(accounts)) => Some(
                            crate::provider_repositories::clone_credential(accounts, &p.request)?,
                        ),
                        (None, _) => None,
                    };
                    let credential = credential.flatten();
                    let events = self.events.clone();
                    let event_operation_id = p.operation_id.clone();
                    agent_value(self.service.clone_repository_with_account(
                        &p.operation_id,
                        p.request,
                        move |progress: CloneProgress| {
                            events.push(
                                "repository_clone",
                                serde_json::json!({
                                    "operationId": event_operation_id,
                                    "phase": progress.phase,
                                    "percent": progress.percent,
                                    "message": progress.message
                                }),
                            )
                        },
                        self.askpass.as_deref(),
                        credential,
                    )?)
                }
                "repository_cancel_clone" => {
                    let p: protocol::CancelClone = parse_params(params)?;
                    self.service.cancel_clone(&p.operation_id)?;
                    Ok(serde_json::Value::Null)
                }
                "repository_prompt_reply" => {
                    let p: protocol::PromptReply = parse_params(params)?;
                    let result = match p.kind.as_str() {
                        "askpass" => self
                            .askpass
                            .as_ref()
                            .ok_or_else(|| {
                                dto::Error::new(
                                    "interactionRequired",
                                    "Prompt events are disabled for this CLI session",
                                )
                            })?
                            .reply(p.request_id, p.response),
                        "editor" => self
                            .editor
                            .as_ref()
                            .ok_or_else(|| {
                                dto::Error::new(
                                    "interactionRequired",
                                    "Prompt events are disabled for this CLI session",
                                )
                            })?
                            .reply(p.request_id, p.response),
                        _ => {
                            return Err(dto::Error::new(
                                "invalidRequest",
                                "kind must be askpass or editor",
                            ))
                        }
                    };
                    result.map_err(|message| dto::Error::new("invalidRequest", message))?;
                    Ok(serde_json::Value::Null)
                }
                "list_provider_accounts" => {
                    parse_params::<protocol::Empty>(params)?;
                    let accounts = self.accounts.as_ref().ok_or_else(|| {
                        dto::Error::new(
                            "accountPolicy",
                            "Select an account metadata file with --accounts-file to enable system keychain access",
                        )
                    })?;
                    agent_value(accounts.list()?)
                }
                "provider_connect_token" => {
                    let p: protocol::ProviderConnectToken = parse_params(params)?;
                    agent_value(accounts()?.connect_token(p.provider, p.username, p.token)?)
                }
                "provider_oauth_start" => {
                    let p: protocol::ProviderOAuthStart = parse_params(params)?;
                    accounts()?;
                    agent_value(self.oauth.start(p.provider)?)
                }
                "provider_oauth_poll" => {
                    let p: protocol::ProviderOAuthSession = parse_params(params)?;
                    agent_value(self.oauth.poll(accounts()?, &p.id)?)
                }
                "provider_oauth_cancel" => {
                    let p: protocol::ProviderOAuthSession = parse_params(params)?;
                    accounts()?;
                    self.oauth.cancel(&p.id)?;
                    Ok(serde_json::Value::Null)
                }
                "provider_disconnect" => {
                    let p: protocol::ProviderDisconnect = parse_params(params)?;
                    accounts()?.disconnect(&p.account_id)?;
                    Ok(serde_json::Value::Null)
                }
                "provider_repositories" => {
                    let p: protocol::ProviderRepositories = parse_params(params)?;
                    agent_value(crate::provider_repositories::repositories(
                        accounts()?,
                        &p.account_id,
                        p.organization.as_deref(),
                        p.cursor.as_deref(),
                    )?)
                }
                "provider_organizations" => {
                    let p: protocol::ProviderOrganizations = parse_params(params)?;
                    agent_value(crate::provider_repositories::organizations(
                        accounts()?,
                        &p.account_id,
                    )?)
                }
                "provider_pull_requests" => {
                    let p: protocol::ProviderPullRequestsRequest = parse_params(params)?;
                    agent_value(self.service.provider_pull_requests(
                        accounts()?,
                        &p.handle,
                        &p.remote,
                        &p.account_id,
                    )?)
                }
                "provider_create_pull_request" => {
                    let p: protocol::CreateProviderPullRequest = parse_params(params)?;
                    agent_value(self.service.provider_create_pull_request(
                        accounts()?,
                        &p.handle,
                        &p.remote,
                        &p.account_id,
                        p.request,
                    )?)
                }
                "ssh_test" => agent_value(crate::ssh::test(parse_params(params)?)?),
                "ssh_directories" => agent_value(crate::ssh::directories(parse_params(params)?)?),
                "wsl_distributions" => {
                    parse_params::<protocol::Empty>(params)?;
                    agent_value(crate::wsl::distributions()?)
                }
                "wsl_directories" => {
                    let p: protocol::WslDirectories = parse_params(params)?;
                    agent_value(crate::wsl::directories(&p.distribution, &p.path)?)
                }
                "repository_state" => agent_value(self.service.repo(&handle(params)?)?.state()?),
                "repository_git_identity" => {
                    agent_value(self.service.repo(&handle(params)?)?.git_identity()?)
                }
                "repository_set_git_identity" => {
                    let p: protocol::SetIdentity = parse_params(params)?;
                    agent_value(self.service.set_git_identity(
                        &p.handle,
                        &p.identity,
                        &p.expected_local,
                    )?)
                }
                "repository_status" => agent_value(self.service.repo(&handle(params)?)?.status()?),
                "repository_operation_state" => {
                    agent_value(self.service.repo(&handle(params)?)?.operation_state()?)
                }
                "repository_branch_relation" => {
                    let p: protocol::BranchRelation = parse_params(params)?;
                    agent_value(
                        self.service
                            .repo(&p.handle)?
                            .branch_relation(&p.first, &p.second)?,
                    )
                }
                "repository_search" => {
                    let p: protocol::Search = parse_params(params)?;
                    agent_value(self.service.repo(&p.handle)?.search(p.query)?)
                }
                "repository_cancel_search" => {
                    self.service.cancel_search(&handle(params)?)?;
                    Ok(serde_json::Value::Null)
                }
                "repository_sync_info" => {
                    let p: protocol::SyncInfoRequest = parse_params(params)?;
                    let repo = self.service.repo(&p.handle)?;
                    match p.branch {
                        Some(branch) => agent_value(repo.sync_info_for(&branch)?),
                        None => agent_value(repo.sync_info()?),
                    }
                }
                "repository_worktrees" => {
                    agent_value(self.service.repo(&handle(params)?)?.worktrees()?)
                }
                "repository_snapshot" => {
                    let p: protocol::Snapshot = parse_params(params)?;
                    let repo = self.service.repo(&p.handle)?;
                    agent_value(match p.history {
                        Some(history) => repo.snapshot_with_history(Some(history))?,
                        None => repo.snapshot()?,
                    })
                }
                "repository_history" => {
                    let p: protocol::History = parse_params(params)?;
                    agent_value(self.service.repo(&p.handle)?.history(
                        p.cursor,
                        p.limit.unwrap_or(200),
                        p.query.unwrap_or_default(),
                    )?)
                }
                "repository_commit" => {
                    let p: protocol::Commit = parse_params(params)?;
                    agent_value(self.service.repo(&p.handle)?.commit(&p.oid)?)
                }
                "repository_conflict_file" => {
                    let p: protocol::PathRequest = parse_params(params)?;
                    agent_value(self.service.repo(&p.handle)?.conflict_file(&p.path)?)
                }
                "repository_resolve_conflict" => {
                    let p: protocol::ResolveConflict = parse_params(params)?;
                    self.service.resolve_conflict(
                        &p.handle,
                        &p.path,
                        &p.fingerprint,
                        p.resolution,
                    )?;
                    Ok(serde_json::Value::Null)
                }
                "repository_commit_edit_eligibility" => {
                    let p: protocol::Commit = parse_params(params)?;
                    agent_value(
                        self.service
                            .repo(&p.handle)?
                            .commit_edit_eligibility(&p.oid)?,
                    )
                }
                "repository_commit_graph_status" => {
                    agent_value(self.service.repo(&handle(params)?)?.commit_graph_status()?)
                }
                "repository_diff_files" => {
                    let p: protocol::DiffFiles = parse_params(params)?;
                    agent_value(self.service.repo(&p.handle)?.diff_files(&p.spec)?)
                }
                "repository_diff" => {
                    let p: protocol::Diff = parse_params(params)?;
                    agent_value(self.service.repo(&p.handle)?.diff(&p.spec, &p.path)?)
                }
                "repository_stage" | "repository_unstage" => {
                    let p: protocol::Paths = parse_params(params)?;
                    if method == "repository_stage" {
                        self.service.stage(&p.handle, &p.paths)?;
                    } else {
                        self.service.unstage(&p.handle, &p.paths)?;
                    }
                    Ok(serde_json::Value::Null)
                }
                "repository_discard" => {
                    let p: protocol::Discard = parse_params(params)?;
                    self.service
                        .discard(&p.handle, &p.paths, &p.expected_status_fingerprint)?;
                    Ok(serde_json::Value::Null)
                }
                "repository_stage_hunk" | "repository_unstage_hunk" => {
                    let p: protocol::Hunk = parse_params(params)?;
                    if method == "repository_stage_hunk" {
                        self.service.stage_hunk(
                            &p.handle,
                            &p.path,
                            p.hunk_index,
                            &p.fingerprint,
                            p.line_indices,
                        )?;
                    } else {
                        self.service.unstage_hunk(
                            &p.handle,
                            &p.path,
                            p.hunk_index,
                            &p.fingerprint,
                            p.line_indices,
                        )?;
                    }
                    Ok(serde_json::Value::Null)
                }
                "repository_create_commit" => {
                    let p: protocol::CreateCommit = parse_params(params)?;
                    agent_value(self.service.create_commit_with_identity(
                        &p.handle,
                        &p.message,
                        p.identity.as_ref(),
                    )?)
                }
                "repository_amend_commit" => {
                    let p: protocol::Amend = parse_params(params)?;
                    let options = mutate::AmendOptions {
                        message_only: p.message_only.unwrap_or(false),
                        require_unpushed: p.require_unpushed.unwrap_or(false),
                    };
                    agent_value(self.service.amend_commit_with_identity(
                        &p.handle,
                        &p.message,
                        p.identity.as_ref(),
                        &p.expected_head,
                        p.expected_head_ref.as_deref(),
                        &p.expected_status_fingerprint,
                        options,
                    )?)
                }
                "repository_worktree_review" => {
                    let p: protocol::WorktreeReviewRequest = parse_params(params)?;
                    agent_value(self.service.repo(&p.handle)?.worktree_review(&p.request)?)
                }
                "repository_worktree_execute" => {
                    let p: protocol::WorktreeExecuteRequest = parse_params(params)?;
                    self.service
                        .worktree_execute(&p.handle, &p.request, &p.token)?;
                    Ok(serde_json::Value::Null)
                }
                "repository_remotes" => {
                    agent_value(self.service.repo(&handle(params)?)?.remotes()?)
                }
                "repository_stashes" => {
                    agent_value(self.service.repo(&handle(params)?)?.stashes()?)
                }
                "repository_stash_action" => {
                    let p: protocol::StashActionRequest = parse_params(params)?;
                    agent_value(self.service.stash_action(&p.handle, p.action)?)
                }
                "repository_remote_action" => {
                    let p: protocol::RemoteActionRequest = parse_params(params)?;
                    agent_value(self.service.remote_action(
                        &p.handle,
                        p.action,
                        self.askpass.as_deref(),
                    )?)
                }
                "repository_run_operation" => {
                    let p: protocol::Operation = parse_params(params)?;
                    agent_value(self.service.run_operation(
                        &p.handle,
                        p.request,
                        self.editor.as_deref(),
                    )?)
                }
                "repository_delete_branch" => {
                    let p: protocol::BranchDelete = parse_params(params)?;
                    agent_value(self.service.delete_branch(&p.handle, p.request, None)?)
                }
                "repository_delete_branches" => {
                    let p: protocol::BranchBatchDelete = parse_params(params)?;
                    agent_value(self.service.delete_branches(&p.handle, p.request, None)?)
                }
                "repository_write_commit_graph" => {
                    self.service.write_commit_graph(&handle(params)?)?;
                    Ok(serde_json::Value::Null)
                }
                "repository_ignore_path" => {
                    let p: protocol::PathRequest = parse_params(params)?;
                    self.service.ignore_path(&p.handle, &p.path)?;
                    Ok(serde_json::Value::Null)
                }
                "repository_watch" => {
                    agent_value(self.watchers.start(&self.service, &handle(params)?)?)
                }
                _ => Err(dto::Error::new(
                    "unsupportedOperation",
                    "Unsupported CLI method",
                )),
            }
        })
    }
}

impl Drop for AgentService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod portable_review_lock_tests {
    use super::*;
    use crate::tests::{commit, git, init};
    use serde_json::json;
    use std::{sync::mpsc, thread, time::Duration};

    #[test]
    fn portable_review_revalidates_after_waiting_for_the_write_guard() {
        let repo = init();
        std::fs::write(repo.path().join("base.txt"), "base\n").unwrap();
        git(repo.path(), &["add", "base.txt"]);
        commit(repo.path(), "base");
        std::fs::write(repo.path().join("target.txt"), "target\n").unwrap();
        std::fs::write(repo.path().join("other.txt"), "other\n").unwrap();
        let service = Arc::new(AgentService::new(
            tempfile::tempdir().unwrap().path().into(),
        ));
        let opened = service
            .dispatch(
                "repository_open",
                json!({"location":{"kind":"native","path":repo.path()}}),
            )
            .unwrap();
        let handle = opened["session"]["handle"].as_str().unwrap().to_string();
        let review = service
            .review(&handle, "repository_stage", json!({"paths":["target.txt"]}))
            .unwrap();

        let (locked_tx, locked_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let lock_service = service.clone();
        let lock_handle = handle.clone();
        let lock_thread = thread::spawn(move || {
            lock_service
                .service
                .mutate_reviewed(&lock_handle, |_| {
                    locked_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(())
                })
                .unwrap();
        });
        locked_rx.recv().unwrap();

        let executing = service.clone();
        let (started_tx, started_rx) = mpsc::channel();
        let execute_thread = thread::spawn(move || {
            started_tx.send(()).unwrap();
            executing.execute_review(review)
        });
        started_rx.recv().unwrap();
        thread::sleep(Duration::from_millis(50));
        git(repo.path(), &["add", "--", "other.txt"]);
        release_tx.send(()).unwrap();
        lock_thread.join().unwrap();
        let error = execute_thread.join().unwrap().unwrap_err();
        assert_eq!(error.code, "staleOperation");
        assert_eq!(
            git(repo.path(), &["diff", "--cached", "--name-only"]),
            "other.txt"
        );
    }
}
