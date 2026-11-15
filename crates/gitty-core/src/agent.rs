use crate::{
    clone_dto::{CloneProgress, CloneRequest},
    dto::{self, *},
    events::{EventEnvelope, EventQueue},
    mutate,
    operation_dto::*,
    process,
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

const REVIEWABLE_METHODS: &[&str] = &[
    "repository_stage",
    "repository_unstage",
    "repository_discard",
    "repository_stage_hunk",
    "repository_unstage_hunk",
    "repository_create_commit",
    "repository_amend_commit",
    "repository_resolve_conflict",
    "repository_run_operation",
    "repository_delete_branch",
    "repository_delete_branches",
    "repository_worktree_execute",
    "repository_stash_action",
    "repository_remote_action",
    "repository_write_commit_graph",
    "repository_ignore_path",
];

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

fn agent_fields<'a>(
    value: &'a serde_json::Value,
    allowed: &[&str],
) -> Result<&'a serde_json::Map<String, serde_json::Value>> {
    let fields = value
        .as_object()
        .ok_or_else(|| dto::Error::new("invalidRequest", "params must be an object"))?;
    if fields.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(dto::Error::new(
            "invalidRequest",
            "params contains an unknown field",
        ));
    }
    Ok(fields)
}

fn agent_string(fields: &serde_json::Map<String, serde_json::Value>, key: &str) -> Result<String> {
    fields
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| dto::Error::new("invalidRequest", format!("{key} must be a string")))
}

fn agent_optional_string(
    fields: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<Option<String>> {
    match fields.get(key) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(dto::Error::new(
            "invalidRequest",
            format!("{key} must be a string or null"),
        )),
    }
}

fn agent_optional_bool(
    fields: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<bool> {
    match fields.get(key) {
        None => Ok(false),
        Some(serde_json::Value::Bool(value)) => Ok(*value),
        _ => Err(dto::Error::new(
            "invalidRequest",
            format!("{key} must be a boolean when provided"),
        )),
    }
}

fn agent_value(value: impl serde::Serialize) -> Result<serde_json::Value> {
    serde_json::to_value(value).map_err(|error| dto::Error::new("serialization", error.to_string()))
}

fn agent_location(value: &serde_json::Value) -> Result<dto::RepositoryLocation> {
    let object = value
        .as_object()
        .ok_or_else(|| dto::Error::new("invalidRequest", "location must be an object"))?;
    let kind = object
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| dto::Error::new("invalidRequest", "location.kind is required"))?;
    let allowed: &[&str] = match kind {
        "native" => &["kind", "path"],
        "wsl" => &["kind", "distribution", "path"],
        "ssh" => &["kind", "host", "port", "user", "path"],
        _ => return Err(dto::Error::new("invalidRequest", "unknown location kind")),
    };
    agent_fields(value, allowed)?;
    let required: &[&str] = match kind {
        "native" | "wsl" => &["path"],
        "ssh" => &["host", "path"],
        _ => unreachable!(),
    };
    if required.iter().any(|key| !object.contains_key(*key))
        || (kind == "wsl" && !object.contains_key("distribution"))
    {
        return Err(dto::Error::new(
            "invalidRequest",
            "location is missing required fields",
        ));
    }
    serde_json::from_value(value.clone())
        .map_err(|_| dto::Error::new("invalidRequest", "location is invalid"))
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
        if !REVIEWABLE_METHODS.contains(&method) {
            return Err(dto::Error::new(
                "unsupportedOperation",
                "This action does not have a portable review form",
            ));
        }
        let params = crate::protocol::validate_portable_params(method, params)?;
        let repo = self.service.repo(handle)?;
        let status = repo.status()?;
        let session = &repo.session;
        let mut reviewed_method = method.to_string();
        let params = params;
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
            reviewed_method = "repository_worktree_execute".into();
        }
        Ok(PortableReview {
            version: 1,
            method: reviewed_method,
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
        if review.version != 1 || !REVIEWABLE_METHODS.contains(&review.method.as_str()) {
            return Err(dto::Error::new(
                "invalidReview",
                "Unsupported portable review version or action",
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
            let params = crate::protocol::validate_params(method, params)?;
            let fields = params
                .as_object()
                .expect("validated method params are an object");
            let handle = || agent_string(fields, "handle");
            match method {
                "repository_open" => {
                    let location_value = fields
                        .get("location")
                        .ok_or_else(|| dto::Error::new("invalidRequest", "location is required"))?;
                    let location = agent_location(location_value)?;
                    agent_value(self.service.open(location)?)
                }
                "repository_close" => {
                    let handle = handle()?;
                    self.watchers.stop(&handle);
                    self.service.close(&handle)?;
                    Ok(serde_json::Value::Null)
                }
                "repository_clone" => {
                    let operation_id = agent_string(fields, "operationId")?;
                    let request: CloneRequest = serde_json::from_value(
                        fields.get("request").cloned().ok_or_else(|| {
                            dto::Error::new("invalidRequest", "request is required")
                        })?,
                    )
                    .map_err(|_| dto::Error::new("invalidRequest", "clone request is invalid"))?;
                    let credential = match (&request.account_id, &self.accounts) {
                        (Some(_), None) => {
                            return Err(dto::Error::new(
                                "accountPolicy",
                                "Enable the system account policy before selecting an account",
                            ))
                        }
                        (Some(_), Some(accounts)) => Some(
                            crate::provider_repositories::clone_credential(accounts, &request)?,
                        ),
                        (None, _) => None,
                    };
                    let credential = credential.flatten();
                    let events = self.events.clone();
                    let event_operation_id = operation_id.clone();
                    agent_value(self.service.clone_repository_with_account(
                        &operation_id,
                        request,
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
                    self.service
                        .cancel_clone(&agent_string(fields, "operationId")?)?;
                    Ok(serde_json::Value::Null)
                }
                "repository_prompt_reply" => {
                    let kind = agent_string(fields, "kind")?;
                    let request_id = fields
                        .get("requestId")
                        .and_then(serde_json::Value::as_u64)
                        .and_then(|value| usize::try_from(value).ok())
                        .ok_or_else(|| {
                            dto::Error::new("invalidRequest", "requestId must be an integer")
                        })?;
                    let response = agent_optional_string(fields, "response")?;
                    let result = match kind.as_str() {
                        "askpass" => self
                            .askpass
                            .as_ref()
                            .ok_or_else(|| {
                                dto::Error::new(
                                    "interactionRequired",
                                    "Prompt events are disabled for this CLI session",
                                )
                            })?
                            .reply(request_id, response),
                        "editor" => self
                            .editor
                            .as_ref()
                            .ok_or_else(|| {
                                dto::Error::new(
                                    "interactionRequired",
                                    "Prompt events are disabled for this CLI session",
                                )
                            })?
                            .reply(request_id, response),
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
                    let accounts = self.accounts.as_ref().ok_or_else(|| {
                        dto::Error::new(
                            "accountPolicy",
                            "Select an account metadata file with --accounts-file to enable system keychain access",
                        )
                    })?;
                    agent_value(accounts.list()?)
                }
                "provider_connect_token" => {
                    let accounts = self.accounts.as_ref().ok_or_else(|| {
                        dto::Error::new("accountPolicy", "System account access is disabled")
                    })?;
                    let provider =
                        serde_json::from_value(fields.get("provider").cloned().unwrap_or_default())
                            .map_err(|_| {
                                dto::Error::new("invalidRequest", "provider is invalid")
                            })?;
                    agent_value(accounts.connect_token(
                        provider,
                        agent_string(fields, "username")?,
                        agent_string(fields, "token")?,
                    )?)
                }
                "provider_oauth_start" => {
                    if self.accounts.is_none() {
                        return Err(dto::Error::new(
                            "accountPolicy",
                            "System account access is disabled",
                        ));
                    }
                    let provider =
                        serde_json::from_value(fields.get("provider").cloned().unwrap_or_default())
                            .map_err(|_| {
                                dto::Error::new("invalidRequest", "provider is invalid")
                            })?;
                    agent_value(self.oauth.start(provider)?)
                }
                "provider_oauth_poll" => {
                    let accounts = self.accounts.as_ref().ok_or_else(|| {
                        dto::Error::new("accountPolicy", "System account access is disabled")
                    })?;
                    agent_value(self.oauth.poll(accounts, &agent_string(fields, "id")?)?)
                }
                "provider_oauth_cancel" => {
                    if self.accounts.is_none() {
                        return Err(dto::Error::new(
                            "accountPolicy",
                            "System account access is disabled",
                        ));
                    }
                    self.oauth.cancel(&agent_string(fields, "id")?)?;
                    Ok(serde_json::Value::Null)
                }
                "provider_disconnect" => {
                    let accounts = self.accounts.as_ref().ok_or_else(|| {
                        dto::Error::new("accountPolicy", "System account access is disabled")
                    })?;
                    accounts.disconnect(&agent_string(fields, "accountId")?)?;
                    Ok(serde_json::Value::Null)
                }
                "provider_repositories" => {
                    let accounts = self.accounts.as_ref().ok_or_else(|| {
                        dto::Error::new("accountPolicy", "System account access is disabled")
                    })?;
                    let organization = agent_optional_string(fields, "organization")?;
                    let cursor = agent_optional_string(fields, "cursor")?;
                    agent_value(crate::provider_repositories::repositories(
                        accounts,
                        &agent_string(fields, "accountId")?,
                        organization.as_deref(),
                        cursor.as_deref(),
                    )?)
                }
                "provider_organizations" => {
                    let accounts = self.accounts.as_ref().ok_or_else(|| {
                        dto::Error::new("accountPolicy", "System account access is disabled")
                    })?;
                    agent_value(crate::provider_repositories::organizations(
                        accounts,
                        &agent_string(fields, "accountId")?,
                    )?)
                }
                "provider_pull_requests" => {
                    let accounts = self.accounts.as_ref().ok_or_else(|| {
                        dto::Error::new("accountPolicy", "System account access is disabled")
                    })?;
                    agent_value(self.service.provider_pull_requests(
                        accounts,
                        &agent_string(fields, "handle")?,
                        &agent_string(fields, "remote")?,
                        &agent_string(fields, "accountId")?,
                    )?)
                }
                "provider_create_pull_request" => {
                    let accounts = self.accounts.as_ref().ok_or_else(|| {
                        dto::Error::new("accountPolicy", "System account access is disabled")
                    })?;
                    let request =
                        serde_json::from_value(fields.get("request").cloned().ok_or_else(
                            || dto::Error::new("invalidRequest", "request is required"),
                        )?)
                        .map_err(|_| {
                            dto::Error::new("invalidRequest", "pull request input is invalid")
                        })?;
                    agent_value(self.service.provider_create_pull_request(
                        accounts,
                        &agent_string(fields, "handle")?,
                        &agent_string(fields, "remote")?,
                        &agent_string(fields, "accountId")?,
                        request,
                    )?)
                }
                "ssh_test" => {
                    let target = serde_json::from_value(params.clone())
                        .map_err(|_| dto::Error::new("invalidRequest", "SSH target is invalid"))?;
                    agent_value(crate::ssh::test(target)?)
                }
                "ssh_directories" => {
                    let target = serde_json::from_value(params.clone())
                        .map_err(|_| dto::Error::new("invalidRequest", "SSH target is invalid"))?;
                    agent_value(crate::ssh::directories(target)?)
                }
                "wsl_distributions" => agent_value(crate::wsl::distributions()?),
                "wsl_directories" => agent_value(crate::wsl::directories(
                    &agent_string(fields, "distribution")?,
                    &agent_string(fields, "path")?,
                )?),
                "repository_state" => agent_value(self.service.repo(&handle()?)?.state()?),
                "repository_git_identity" => {
                    agent_value(self.service.repo(&handle()?)?.git_identity()?)
                }
                "repository_set_git_identity" => {
                    let identity =
                        agent_value(fields.get("identity").cloned().unwrap_or_default())?;
                    let identity = serde_json::from_value(identity)
                        .map_err(|_| dto::Error::new("invalidRequest", "identity is invalid"))?;
                    let expected = fields.get("expectedLocal").cloned().ok_or_else(|| {
                        dto::Error::new("invalidRequest", "expectedLocal is required")
                    })?;
                    let expected = serde_json::from_value(expected).map_err(|_| {
                        dto::Error::new("invalidRequest", "expectedLocal is invalid")
                    })?;
                    agent_value(
                        self.service
                            .set_git_identity(&handle()?, &identity, &expected)?,
                    )
                }
                "repository_status" => agent_value(self.service.repo(&handle()?)?.status()?),
                "repository_operation_state" => {
                    agent_value(self.service.repo(&handle()?)?.operation_state()?)
                }
                "repository_branch_relation" => {
                    agent_value(self.service.repo(&handle()?)?.branch_relation(
                        &agent_string(fields, "first")?,
                        &agent_string(fields, "second")?,
                    )?)
                }
                "repository_search" => {
                    let query = fields
                        .get("query")
                        .cloned()
                        .ok_or_else(|| dto::Error::new("invalidRequest", "query is required"))?;
                    let query = serde_json::from_value(query)
                        .map_err(|_| dto::Error::new("invalidRequest", "query is invalid"))?;
                    agent_value(self.service.repo(&handle()?)?.search(query)?)
                }
                "repository_cancel_search" => {
                    self.service.cancel_search(&handle()?)?;
                    Ok(serde_json::Value::Null)
                }
                "repository_sync_info" => {
                    let repo = self.service.repo(&handle()?)?;
                    match agent_optional_string(fields, "branch")? {
                        Some(branch) => agent_value(repo.sync_info_for(&branch)?),
                        None => agent_value(repo.sync_info()?),
                    }
                }
                "repository_worktrees" => agent_value(self.service.repo(&handle()?)?.worktrees()?),
                "repository_snapshot" => {
                    let repo = self.service.repo(&handle()?)?;
                    let history = fields
                        .get("history")
                        .cloned()
                        .filter(|value| !value.is_null())
                        .map(serde_json::from_value::<SnapshotHistory>)
                        .transpose()
                        .map_err(|_| {
                            dto::Error::new("invalidRequest", "history options are invalid")
                        })?;
                    agent_value(match history {
                        Some(history) => repo.snapshot_with_history(Some(history))?,
                        None => repo.snapshot()?,
                    })
                }
                "repository_history" => {
                    let cursor = agent_optional_string(fields, "cursor")?;
                    let limit = match fields.get("limit") {
                        Some(value) => value.as_u64().and_then(|n| usize::try_from(n).ok()),
                        None => Some(200),
                    }
                    .ok_or_else(|| dto::Error::new("invalidRequest", "limit must be an integer"))?;
                    let query = fields
                        .get("query")
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!({}));
                    let query_fields = agent_fields(&query, &["branch"])?;
                    let _ = agent_optional_string(query_fields, "branch")?;
                    let query: dto::HistoryQuery = serde_json::from_value(query)
                        .map_err(|_| dto::Error::new("invalidRequest", "query is invalid"))?;
                    agent_value(
                        self.service
                            .repo(&handle()?)?
                            .history(cursor, limit, query)?,
                    )
                }
                "repository_commit" => agent_value(
                    self.service
                        .repo(&handle()?)?
                        .commit(&agent_string(fields, "oid")?)?,
                ),
                "repository_conflict_file" => agent_value(
                    self.service
                        .repo(&handle()?)?
                        .conflict_file(&agent_string(fields, "path")?)?,
                ),
                "repository_resolve_conflict" => {
                    let resolution = fields.get("resolution").cloned().ok_or_else(|| {
                        dto::Error::new("invalidRequest", "resolution is required")
                    })?;
                    let resolution = serde_json::from_value(resolution)
                        .map_err(|_| dto::Error::new("invalidRequest", "resolution is invalid"))?;
                    self.service.resolve_conflict(
                        &handle()?,
                        &agent_string(fields, "path")?,
                        &agent_string(fields, "fingerprint")?,
                        resolution,
                    )?;
                    Ok(serde_json::Value::Null)
                }
                "repository_commit_edit_eligibility" => agent_value(
                    self.service
                        .repo(&handle()?)?
                        .commit_edit_eligibility(&agent_string(fields, "oid")?)?,
                ),
                "repository_commit_graph_status" => {
                    agent_value(self.service.repo(&handle()?)?.commit_graph_status()?)
                }
                "repository_diff_files" => {
                    let spec =
                        serde_json::from_value(fields.get("spec").cloned().ok_or_else(|| {
                            dto::Error::new("invalidRequest", "spec is required")
                        })?)
                        .map_err(|_| dto::Error::new("invalidRequest", "spec is invalid"))?;
                    agent_value(self.service.repo(&handle()?)?.diff_files(&spec)?)
                }
                "repository_diff" => {
                    let spec =
                        serde_json::from_value(fields.get("spec").cloned().ok_or_else(|| {
                            dto::Error::new("invalidRequest", "spec is required")
                        })?)
                        .map_err(|_| dto::Error::new("invalidRequest", "spec is invalid"))?;
                    agent_value(
                        self.service
                            .repo(&handle()?)?
                            .diff(&spec, &agent_string(fields, "path")?)?,
                    )
                }
                "repository_stage" | "repository_unstage" => {
                    let paths = fields
                        .get("paths")
                        .and_then(serde_json::Value::as_array)
                        .ok_or_else(|| {
                            dto::Error::new("invalidRequest", "paths must be an array of strings")
                        })?
                        .iter()
                        .map(|path| {
                            path.as_str().map(str::to_owned).ok_or_else(|| {
                                dto::Error::new(
                                    "invalidRequest",
                                    "paths must be an array of strings",
                                )
                            })
                        })
                        .collect::<Result<Vec<_>>>()?;
                    if method == "repository_stage" {
                        self.service.stage(&handle()?, &paths)?;
                    } else {
                        self.service.unstage(&handle()?, &paths)?;
                    }
                    Ok(serde_json::Value::Null)
                }
                "repository_discard" => {
                    let paths = fields
                        .get("paths")
                        .and_then(serde_json::Value::as_array)
                        .ok_or_else(|| dto::Error::new("invalidRequest", "paths must be an array"))?
                        .iter()
                        .map(|p| {
                            p.as_str().map(str::to_owned).ok_or_else(|| {
                                dto::Error::new("invalidRequest", "paths must contain strings")
                            })
                        })
                        .collect::<Result<Vec<_>>>()?;
                    self.service.discard(
                        &handle()?,
                        &paths,
                        &agent_string(fields, "expectedStatusFingerprint")?,
                    )?;
                    Ok(serde_json::Value::Null)
                }
                "repository_stage_hunk" | "repository_unstage_hunk" => {
                    let index = fields
                        .get("hunkIndex")
                        .and_then(serde_json::Value::as_u64)
                        .and_then(|v| usize::try_from(v).ok())
                        .ok_or_else(|| {
                            dto::Error::new("invalidRequest", "hunkIndex must be an integer")
                        })?;
                    let lines = match fields.get("lineIndices") {
                        None | Some(serde_json::Value::Null) => None,
                        Some(serde_json::Value::Array(values)) => Some(
                            values
                                .iter()
                                .map(|value| {
                                    value
                                        .as_u64()
                                        .and_then(|n| usize::try_from(n).ok())
                                        .ok_or_else(|| {
                                            dto::Error::new(
                                                "invalidRequest",
                                                "lineIndices must contain integers",
                                            )
                                        })
                                })
                                .collect::<Result<Vec<_>>>()?,
                        ),
                        Some(_) => {
                            return Err(dto::Error::new(
                                "invalidRequest",
                                "lineIndices must be an array or null",
                            ))
                        }
                    };
                    let path = agent_string(fields, "path")?;
                    let fingerprint = agent_string(fields, "fingerprint")?;
                    if method == "repository_stage_hunk" {
                        self.service
                            .stage_hunk(&handle()?, &path, index, &fingerprint, lines)?;
                    } else {
                        self.service
                            .unstage_hunk(&handle()?, &path, index, &fingerprint, lines)?;
                    }
                    Ok(serde_json::Value::Null)
                }
                "repository_create_commit" => {
                    let message = agent_string(fields, "message")?;
                    let identity = fields
                        .get("identity")
                        .cloned()
                        .filter(|value| !value.is_null())
                        .map(serde_json::from_value::<dto::CommitIdentity>)
                        .transpose()
                        .map_err(|_| dto::Error::new("invalidRequest", "identity is invalid"))?;
                    agent_value(self.service.create_commit_with_identity(
                        &handle()?,
                        &message,
                        identity.as_ref(),
                    )?)
                }
                "repository_amend_commit" => {
                    let message = agent_string(fields, "message")?;
                    let identity = fields
                        .get("identity")
                        .cloned()
                        .filter(|v| !v.is_null())
                        .map(serde_json::from_value::<dto::CommitIdentity>)
                        .transpose()
                        .map_err(|_| dto::Error::new("invalidRequest", "identity is invalid"))?;
                    let head_ref = agent_optional_string(fields, "expectedHeadRef")?;
                    let options = mutate::AmendOptions {
                        message_only: agent_optional_bool(fields, "messageOnly")?,
                        require_unpushed: agent_optional_bool(fields, "requireUnpushed")?,
                    };
                    agent_value(self.service.amend_commit_with_identity(
                        &handle()?,
                        &message,
                        identity.as_ref(),
                        &agent_string(fields, "expectedHead")?,
                        head_ref.as_deref(),
                        &agent_string(fields, "expectedStatusFingerprint")?,
                        options,
                    )?)
                }
                "repository_worktree_review" => {
                    let request = fields
                        .get("request")
                        .cloned()
                        .ok_or_else(|| dto::Error::new("invalidRequest", "request is required"))?;
                    let request = serde_json::from_value(request)
                        .map_err(|_| dto::Error::new("invalidRequest", "request is invalid"))?;
                    agent_value(self.service.repo(&handle()?)?.worktree_review(&request)?)
                }
                "repository_worktree_execute" => {
                    let request = fields
                        .get("request")
                        .cloned()
                        .ok_or_else(|| dto::Error::new("invalidRequest", "request is required"))?;
                    let request = serde_json::from_value(request)
                        .map_err(|_| dto::Error::new("invalidRequest", "request is invalid"))?;
                    self.service.worktree_execute(
                        &handle()?,
                        &request,
                        &agent_string(fields, "token")?,
                    )?;
                    Ok(serde_json::Value::Null)
                }
                "repository_remotes" => agent_value(self.service.repo(&handle()?)?.remotes()?),
                "repository_stashes" => agent_value(self.service.repo(&handle()?)?.stashes()?),
                "repository_stash_action" => {
                    let action = fields
                        .get("action")
                        .cloned()
                        .ok_or_else(|| dto::Error::new("invalidRequest", "action is required"))?;
                    let action = serde_json::from_value(action)
                        .map_err(|_| dto::Error::new("invalidRequest", "action is invalid"))?;
                    agent_value(self.service.stash_action(&handle()?, action)?)
                }
                "repository_remote_action" => {
                    let action = fields
                        .get("action")
                        .cloned()
                        .ok_or_else(|| dto::Error::new("invalidRequest", "action is required"))?;
                    let action = serde_json::from_value(action)
                        .map_err(|_| dto::Error::new("invalidRequest", "action is invalid"))?;
                    agent_value(self.service.remote_action(
                        &handle()?,
                        action,
                        self.askpass.as_deref(),
                    )?)
                }
                "repository_run_operation" => {
                    let request = fields
                        .get("request")
                        .cloned()
                        .ok_or_else(|| dto::Error::new("invalidRequest", "request is required"))?;
                    let request = serde_json::from_value(request)
                        .map_err(|_| dto::Error::new("invalidRequest", "request is invalid"))?;
                    agent_value(self.service.run_operation(
                        &handle()?,
                        request,
                        self.editor.as_deref(),
                    )?)
                }
                "repository_delete_branch" => {
                    let request = fields
                        .get("request")
                        .cloned()
                        .ok_or_else(|| dto::Error::new("invalidRequest", "request is required"))?;
                    let request = serde_json::from_value(request)
                        .map_err(|_| dto::Error::new("invalidRequest", "request is invalid"))?;
                    agent_value(self.service.delete_branch(&handle()?, request, None)?)
                }
                "repository_delete_branches" => {
                    let request = fields
                        .get("request")
                        .cloned()
                        .ok_or_else(|| dto::Error::new("invalidRequest", "request is required"))?;
                    let request = serde_json::from_value(request)
                        .map_err(|_| dto::Error::new("invalidRequest", "request is invalid"))?;
                    agent_value(self.service.delete_branches(&handle()?, request, None)?)
                }
                "repository_write_commit_graph" => {
                    self.service.write_commit_graph(&handle()?)?;
                    Ok(serde_json::Value::Null)
                }
                "repository_ignore_path" => {
                    self.service
                        .ignore_path(&handle()?, &agent_string(fields, "path")?)?;
                    Ok(serde_json::Value::Null)
                }
                "repository_open_path" | "repository_reveal_path" => Err(dto::Error::new(
                    "desktopOnly",
                    "This operation requires desktop integration",
                )),
                "repository_watch" => agent_value(self.watchers.start(&self.service, &handle()?)?),
                _ => unreachable!(),
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
