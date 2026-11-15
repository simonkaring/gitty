use crate::{
    branch_delete::{BranchBatchDeleteRequest, BranchDeleteRequest},
    clone_dto::CloneRequest,
    dto::{
        CommitEditEligibility, CommitIdentity, CreatedCommit, DiffFile, DiffSpec, FileDiff,
        GitIdentityValues, HistoryPage, HistoryQuery, RepositoryGitIdentity, RepositoryLocation,
        RepositoryState, RepositoryStatus, SearchQuery, SearchResult,
    },
    dto::{DirectoryEntry, SshProbe, SshTarget, WslDistribution},
    operation_dto::{
        ConflictFile, ConflictResolution, OperationRequest, OperationState, RemoteInfo,
        RepositorySnapshot, SnapshotHistory,
    },
    provider_accounts::Provider,
    provider_accounts::ProviderAccount,
    provider_oauth::{DeviceAuthorization, PollResult},
    provider_pr::{CreatePullRequest, ProviderPullRequest},
    provider_repositories::RepositoryPage,
    remote_dto::{ActionOutput, RemoteAction, StashAction, StashEntry, SyncInfo},
    watcher::WatchStatus,
    worktrees::{Worktree, WorktreeRequest, WorktreeReview},
};
use schemars::{schema_for, JsonSchema};
use serde::Deserialize;
use serde_json::{json, Map, Value};

macro_rules! params {
    ($name:ident { $($field:ident: $kind:ty),* $(,)? }) => {
        #[derive(Deserialize, JsonSchema)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[allow(dead_code)]
        struct $name { $(pub $field: $kind),* }
    };
}

params!(Empty {});
params!(Open {
    location: RepositoryLocation
});
params!(Handle { handle: String });
params!(History {
    handle: String,
    cursor: Option<String>,
    limit: Option<usize>,
    query: Option<HistoryQuery>,
});
params!(Snapshot { handle: String, history: Option<SnapshotHistory> });
params!(Commit {
    handle: String,
    oid: String
});
params!(BranchRelation {
    handle: String,
    first: String,
    second: String
});
params!(Search {
    handle: String,
    query: SearchQuery
});
params!(SyncInfoRequest { handle: String, branch: Option<String> });
params!(WorktreeReviewRequest {
    handle: String,
    request: WorktreeRequest
});
params!(WorktreeExecuteRequest {
    handle: String,
    request: WorktreeRequest,
    token: String,
});
params!(PathRequest {
    handle: String,
    path: String
});
params!(ResolveConflict {
    handle: String,
    path: String,
    fingerprint: String,
    resolution: ConflictResolution,
});
params!(SetIdentity {
    handle: String,
    identity: CommitIdentity,
    expected_local: GitIdentityValues,
});
params!(StashActionRequest {
    handle: String,
    action: StashAction
});
params!(RemoteActionRequest {
    handle: String,
    action: RemoteAction
});
params!(Operation {
    handle: String,
    request: OperationRequest
});
params!(BranchDelete {
    handle: String,
    request: BranchDeleteRequest
});
params!(BranchBatchDelete {
    handle: String,
    request: BranchBatchDeleteRequest
});
params!(Discard {
    handle: String,
    paths: Vec<String>,
    expected_status_fingerprint: String,
});
params!(Hunk {
    handle: String,
    path: String,
    hunk_index: usize,
    fingerprint: String,
    line_indices: Option<Vec<usize>>,
});
params!(Amend {
    handle: String,
    message: String,
    identity: Option<CommitIdentity>,
    expected_head: String,
    expected_head_ref: Option<String>,
    expected_status_fingerprint: String,
    message_only: Option<bool>,
    require_unpushed: Option<bool>,
});
params!(DiffFiles {
    handle: String,
    spec: DiffSpec
});
params!(Diff {
    handle: String,
    spec: DiffSpec,
    path: String
});
params!(Paths { handle: String, paths: Vec<String> });
params!(CreateCommit {
    handle: String,
    message: String,
    identity: Option<CommitIdentity>,
});
params!(Clone {
    operation_id: String,
    request: CloneRequest,
});
params!(CancelClone {
    operation_id: String
});
params!(PromptReply {
    kind: String,
    request_id: usize,
    response: Option<String>,
});
params!(ProviderDisconnect { account_id: String });
params!(ProviderRepositories {
    account_id: String,
    organization: Option<String>,
    cursor: Option<String>,
});
params!(ProviderOrganizations { account_id: String });
params!(ProviderPullRequestsRequest {
    handle: String,
    remote: String,
    account_id: String,
});
params!(CreateProviderPullRequest {
    handle: String,
    remote: String,
    account_id: String,
    request: CreatePullRequest,
});
params!(ProviderConnectToken {
    provider: Provider,
    username: String,
    token: String,
});
params!(ProviderOAuthStart { provider: Provider });
params!(ProviderOAuthSession { id: String });
params!(WslDirectories {
    distribution: String,
    path: String,
});

fn schema<T: JsonSchema>() -> Value {
    serde_json::to_value(schema_for!(T)).expect("JSON Schema serializes")
}

fn insert<T: JsonSchema>(schemas: &mut Map<String, Value>, method: &str) {
    schemas.insert(
        method.into(),
        json!({ "request": schema::<T>(), "response": response_schema(method) }),
    );
}

fn response_schema(method: &str) -> Value {
    macro_rules! response {
        ($type:ty) => {
            schema::<$type>()
        };
    }
    match method {
        "capabilities" => json!({"type":"object"}),
        "repository_open" => response!(RepositoryState),
        "repository_close"
        | "repository_cancel_search"
        | "repository_resolve_conflict"
        | "repository_stage"
        | "repository_unstage"
        | "repository_discard"
        | "repository_stage_hunk"
        | "repository_unstage_hunk"
        | "repository_worktree_execute"
        | "repository_write_commit_graph"
        | "repository_ignore_path"
        | "repository_cancel_clone"
        | "provider_disconnect"
        | "repository_prompt_reply" => response!(()),
        "repository_snapshot" => response!(RepositorySnapshot),
        "repository_status" => response!(RepositoryStatus),
        "repository_operation_state" => response!(OperationState),
        "repository_state" => response!(RepositoryState),
        "repository_git_identity" | "repository_set_git_identity" => {
            response!(RepositoryGitIdentity)
        }
        "repository_sync_info" => response!(SyncInfo),
        "repository_worktrees" => response!(Vec<Worktree>),
        "repository_worktree_review" => response!(WorktreeReview),
        "repository_remotes" => response!(Vec<RemoteInfo>),
        "repository_stashes" => response!(Vec<StashEntry>),
        "repository_stash_action" | "repository_remote_action" => response!(ActionOutput),
        "repository_run_operation" => response!(crate::operation_dto::OperationResult),
        "repository_delete_branch" => response!(crate::branch_delete::BranchDeleteResult),
        "repository_delete_branches" => response!(crate::branch_delete::BranchBatchDeleteResult),
        "repository_history" => response!(HistoryPage),
        "repository_search" => response!(SearchResult),
        "repository_commit" => response!(crate::dto::CommitDetail),
        "repository_conflict_file" => response!(ConflictFile),
        "repository_branch_relation" => response!((usize, usize)),
        "repository_diff_files" => response!(Vec<DiffFile>),
        "repository_commit_edit_eligibility" => response!(CommitEditEligibility),
        "repository_commit_graph_status" => response!(crate::commit_graph::CommitGraphStatus),
        "repository_diff" => response!(FileDiff),
        "repository_create_commit" | "repository_amend_commit" => response!(CreatedCommit),
        "repository_watch" => response!(WatchStatus),
        "repository_clone" => response!(RepositoryLocation),
        "list_provider_accounts" => response!(Vec<ProviderAccount>),
        "provider_repositories" => response!(RepositoryPage),
        "provider_organizations" => response!(Vec<String>),
        "provider_pull_requests" => response!(crate::provider_pr::ProviderPullRequests),
        "provider_create_pull_request" => response!(ProviderPullRequest),
        "provider_connect_token" => response!(ProviderAccount),
        "provider_oauth_start" => response!(DeviceAuthorization),
        "provider_oauth_poll" => response!(PollResult),
        "provider_oauth_cancel" => response!(()),
        "ssh_test" => response!(SshProbe),
        "ssh_directories" | "wsl_directories" => response!(Vec<DirectoryEntry>),
        "wsl_distributions" => response!(Vec<WslDistribution>),
        _ => json!({"notSupported":true}),
    }
}

fn event_schema() -> Value {
    let event = |kind: &str, data: Value| {
        json!({
            "type":"object",
            "required":["kind","data"],
            "properties":{
                "kind":{"const":kind},
                "data":data
            },
            "additionalProperties":false
        })
    };
    let required_fields = |required: &[&str], properties: Value| {
        json!({
            "type":"object",
            "required":required,
            "properties":properties,
            "additionalProperties":false
        })
    };
    json!({
        "type":"object",
        "required":["version","eventId","event"],
        "properties":{
            "version":{"const":1},
            "eventId":{"type":"integer","minimum":1},
            "event":{
                "oneOf":[
                    event("repository_changed",required_fields(&["handle"],json!({"handle":{"type":"string"}}))),
                    event("git_command",required_fields(&["command","stdin","success","code","millis"],json!({
                        "command":{"type":"string"},
                        "stdin":{"type":["string","null"]},
                        "success":{"type":"boolean"},
                        "code":{"type":["integer","null"]},
                        "millis":{"type":"integer","minimum":0}
                    }))),
                    event("repository_clone",required_fields(&["operationId","phase","percent","message"],json!({
                        "operationId":{"type":"string"},
                        "phase":{"type":"string"},
                        "percent":{"type":["integer","null"],"minimum":0,"maximum":100},
                        "message":{"type":"string"}
                    }))),
                    event("askpass_prompt",required_fields(&["requestId","prompt","context","replyMethod"],json!({
                        "requestId":{"type":"integer","minimum":0},
                        "prompt":{"type":"string"},
                        "context":{"oneOf":[required_fields(&["repository","operation"],json!({
                            "repository":{"type":"string"},
                            "operation":{"type":"string"}
                        })),{"type":"null"}]},
                        "replyMethod":{"const":"repository_prompt_reply"}
                    }))),
                    event("editor_prompt",required_fields(&["requestId","fileName","content","replyMethod"],json!({
                        "requestId":{"type":"integer","minimum":0},
                        "fileName":{"type":"string"},
                        "content":{"type":"string"},
                        "replyMethod":{"const":"repository_prompt_reply"}
                    }))),
                    event("askpass_expired",required_fields(&["requestId"],json!({"requestId":{"type":"integer","minimum":0}}))),
                    event("editor_expired",required_fields(&["requestId"],json!({"requestId":{"type":"integer","minimum":0}}))),
                    event("events_dropped",required_fields(&["count"],json!({"count":{"type":"integer","minimum":1}})))
                ]
            }
        },
        "additionalProperties":false
    })
}

/// The supported method registry is the single source used by capabilities and
/// the schema document. Optional host policies only add their own methods.
pub fn schemas(accounts_enabled: bool, prompts_enabled: bool) -> Value {
    let mut schemas = Map::new();
    insert::<Empty>(&mut schemas, "capabilities");
    insert::<Open>(&mut schemas, "repository_open");
    for method in [
        "repository_close",
        "repository_status",
        "repository_operation_state",
        "repository_state",
        "repository_git_identity",
        "repository_remotes",
        "repository_stashes",
        "repository_commit_graph_status",
        "repository_write_commit_graph",
        "repository_cancel_search",
        "repository_watch",
    ] {
        insert::<Handle>(&mut schemas, method);
    }
    insert::<Snapshot>(&mut schemas, "repository_snapshot");
    insert::<History>(&mut schemas, "repository_history");
    insert::<Commit>(&mut schemas, "repository_commit");
    insert::<Commit>(&mut schemas, "repository_commit_edit_eligibility");
    insert::<BranchRelation>(&mut schemas, "repository_branch_relation");
    insert::<Search>(&mut schemas, "repository_search");
    insert::<SyncInfoRequest>(&mut schemas, "repository_sync_info");
    insert::<Handle>(&mut schemas, "repository_worktrees");
    insert::<WorktreeReviewRequest>(&mut schemas, "repository_worktree_review");
    insert::<WorktreeExecuteRequest>(&mut schemas, "repository_worktree_execute");
    insert::<PathRequest>(&mut schemas, "repository_conflict_file");
    insert::<ResolveConflict>(&mut schemas, "repository_resolve_conflict");
    insert::<SetIdentity>(&mut schemas, "repository_set_git_identity");
    insert::<StashActionRequest>(&mut schemas, "repository_stash_action");
    insert::<RemoteActionRequest>(&mut schemas, "repository_remote_action");
    insert::<Operation>(&mut schemas, "repository_run_operation");
    insert::<BranchDelete>(&mut schemas, "repository_delete_branch");
    insert::<BranchBatchDelete>(&mut schemas, "repository_delete_branches");
    insert::<Discard>(&mut schemas, "repository_discard");
    insert::<Hunk>(&mut schemas, "repository_stage_hunk");
    insert::<Hunk>(&mut schemas, "repository_unstage_hunk");
    insert::<Amend>(&mut schemas, "repository_amend_commit");
    insert::<DiffFiles>(&mut schemas, "repository_diff_files");
    insert::<Diff>(&mut schemas, "repository_diff");
    insert::<Paths>(&mut schemas, "repository_stage");
    insert::<Paths>(&mut schemas, "repository_unstage");
    insert::<CreateCommit>(&mut schemas, "repository_create_commit");
    insert::<Clone>(&mut schemas, "repository_clone");
    insert::<CancelClone>(&mut schemas, "repository_cancel_clone");
    insert::<PathRequest>(&mut schemas, "repository_ignore_path");
    if prompts_enabled {
        insert::<PromptReply>(&mut schemas, "repository_prompt_reply");
    }
    if accounts_enabled {
        insert::<Empty>(&mut schemas, "list_provider_accounts");
        insert::<ProviderConnectToken>(&mut schemas, "provider_connect_token");
        insert::<ProviderOAuthStart>(&mut schemas, "provider_oauth_start");
        insert::<ProviderOAuthSession>(&mut schemas, "provider_oauth_poll");
        insert::<ProviderOAuthSession>(&mut schemas, "provider_oauth_cancel");
        insert::<ProviderDisconnect>(&mut schemas, "provider_disconnect");
        insert::<ProviderRepositories>(&mut schemas, "provider_repositories");
        insert::<ProviderOrganizations>(&mut schemas, "provider_organizations");
        insert::<ProviderPullRequestsRequest>(&mut schemas, "provider_pull_requests");
        insert::<CreateProviderPullRequest>(&mut schemas, "provider_create_pull_request");
    }
    insert::<SshTarget>(&mut schemas, "ssh_test");
    insert::<SshTarget>(&mut schemas, "ssh_directories");
    if cfg!(windows) {
        insert::<Empty>(&mut schemas, "wsl_distributions");
        insert::<WslDirectories>(&mut schemas, "wsl_directories");
    }
    json!({
        "schemaVersion": "https://json-schema.org/draft/2020-12/schema",
        "event": event_schema(),
        "methods": schemas,
        "responseEnvelope": {
            "type":"object",
            "required":["version","id","result","error"],
            "properties":{
                "version":{"const":1},
                "id":{},
                "result":{},
                "error":{"oneOf":[schema::<crate::dto::Error>(),{"type":"null"}]}
            },
            "additionalProperties":false
        }
    })
}

/// Validate dispatched parameters with the same serde DTOs used to publish their
/// schemas. This rejects unknown nested fields instead of maintaining a looser
/// hand-written dispatcher contract.
pub fn validate_params(method: &str, params: Value) -> crate::dto::Result<Value> {
    macro_rules! validate {
        ($type:ty) => {
            serde_json::from_value::<$type>(params.clone())
                .map(|_| params)
                .map_err(|_| crate::dto::Error::new("invalidRequest", "method params are invalid"))
        };
    }
    match method {
        "list_provider_accounts" | "wsl_distributions" => validate!(Empty),
        "repository_close"
        | "repository_status"
        | "repository_operation_state"
        | "repository_state"
        | "repository_git_identity"
        | "repository_remotes"
        | "repository_stashes"
        | "repository_commit_graph_status"
        | "repository_write_commit_graph"
        | "repository_cancel_search"
        | "repository_watch" => validate!(Handle),
        "repository_open" => validate!(Open),
        "repository_snapshot" => validate!(Snapshot),
        "repository_history" => validate!(History),
        "repository_commit" | "repository_commit_edit_eligibility" => validate!(Commit),
        "repository_branch_relation" => validate!(BranchRelation),
        "repository_search" => validate!(Search),
        "repository_sync_info" => validate!(SyncInfoRequest),
        "repository_worktrees" => validate!(Handle),
        "repository_worktree_review" => validate!(WorktreeReviewRequest),
        "repository_worktree_execute" => validate!(WorktreeExecuteRequest),
        "repository_conflict_file" | "repository_ignore_path" => validate!(PathRequest),
        "repository_resolve_conflict" => validate!(ResolveConflict),
        "repository_set_git_identity" => validate!(SetIdentity),
        "repository_stash_action" => validate!(StashActionRequest),
        "repository_remote_action" => validate!(RemoteActionRequest),
        "repository_run_operation" => validate!(Operation),
        "repository_delete_branch" => validate!(BranchDelete),
        "repository_delete_branches" => validate!(BranchBatchDelete),
        "repository_discard" => validate!(Discard),
        "repository_stage_hunk" | "repository_unstage_hunk" => validate!(Hunk),
        "repository_amend_commit" => validate!(Amend),
        "repository_diff_files" => validate!(DiffFiles),
        "repository_diff" => validate!(Diff),
        "repository_stage" | "repository_unstage" => validate!(Paths),
        "repository_create_commit" => validate!(CreateCommit),
        "repository_clone" => validate!(Clone),
        "repository_cancel_clone" => validate!(CancelClone),
        "repository_prompt_reply" => validate!(PromptReply),
        "provider_connect_token" => validate!(ProviderConnectToken),
        "provider_oauth_start" => validate!(ProviderOAuthStart),
        "provider_oauth_poll" | "provider_oauth_cancel" => validate!(ProviderOAuthSession),
        "provider_disconnect" => validate!(ProviderDisconnect),
        "provider_repositories" => validate!(ProviderRepositories),
        "provider_organizations" => validate!(ProviderOrganizations),
        "provider_pull_requests" => validate!(ProviderPullRequestsRequest),
        "provider_create_pull_request" => validate!(CreateProviderPullRequest),
        "ssh_test" | "ssh_directories" => validate!(SshTarget),
        "wsl_directories" => validate!(WslDirectories),
        _ => Err(crate::dto::Error::new(
            "unsupportedOperation",
            "Unsupported CLI method",
        )),
    }
}

pub fn supported_methods(accounts_enabled: bool, prompts_enabled: bool) -> Vec<String> {
    let mut methods = schemas(accounts_enabled, prompts_enabled)["methods"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    methods.sort();
    methods
}

pub fn validate_portable_params(method: &str, params: Value) -> crate::dto::Result<Value> {
    let mut full = params.as_object().cloned().ok_or_else(|| {
        crate::dto::Error::new("invalidRequest", "review params must be an object")
    })?;
    if full.contains_key("handle") || full.contains_key("token") {
        return Err(crate::dto::Error::new(
            "invalidRequest",
            "Portable review cannot supply a handle or token",
        ));
    }
    full.insert("handle".into(), Value::String("review-validation".into()));
    if method == "repository_worktree_execute" {
        full.insert("token".into(), Value::String("review-validation".into()));
    }
    let mut full = Value::Object(full);
    macro_rules! check {
        ($type:ty) => {
            serde_json::from_value::<$type>(full.clone()).map(|_| ())
        };
    }
    let valid = match method {
        "repository_stage" | "repository_unstage" => check!(Paths),
        "repository_discard" => check!(Discard),
        "repository_stage_hunk" | "repository_unstage_hunk" => check!(Hunk),
        "repository_create_commit" => check!(CreateCommit),
        "repository_amend_commit" => check!(Amend),
        "repository_resolve_conflict" => check!(ResolveConflict),
        "repository_run_operation" => check!(Operation),
        "repository_delete_branch" => check!(BranchDelete),
        "repository_delete_branches" => check!(BranchBatchDelete),
        "repository_worktree_execute" => check!(WorktreeExecuteRequest),
        "repository_stash_action" => check!(StashActionRequest),
        "repository_remote_action" => check!(RemoteActionRequest),
        "repository_write_commit_graph" => check!(Handle),
        "repository_ignore_path" => check!(PathRequest),
        _ => {
            return Err(crate::dto::Error::new(
                "unsupportedOperation",
                "This action does not have a portable review form",
            ))
        }
    };
    valid.map_err(|_| {
        crate::dto::Error::new("invalidRequest", "review action params are invalid")
    })?;
    full.as_object_mut().unwrap().remove("handle");
    full.as_object_mut().unwrap().remove("token");
    Ok(full)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_advertised_method_has_request_and_response_schemas() {
        for (accounts, prompts) in [(false, false), (true, false), (false, true), (true, true)] {
            let document = schemas(accounts, prompts);
            let methods = document["methods"].as_object().unwrap();
            assert_eq!(
                supported_methods(accounts, prompts),
                methods.keys().cloned().collect::<Vec<_>>()
            );
            for (method, contract) in methods {
                assert!(
                    contract["request"].is_object(),
                    "{method} has no request schema"
                );
                assert!(
                    contract["response"].is_object(),
                    "{method} has no response schema"
                );
                assert_ne!(
                    contract["response"]["notSupported"], true,
                    "{method} has no response contract"
                );
            }
            assert_eq!(methods.contains_key("provider_disconnect"), accounts);
            for method in [
                "provider_connect_token",
                "provider_oauth_start",
                "provider_oauth_poll",
                "provider_oauth_cancel",
            ] {
                assert_eq!(methods.contains_key(method), accounts, "{method}");
            }
            assert_eq!(methods.contains_key("repository_prompt_reply"), prompts);
            assert!(methods.contains_key("ssh_test"));
            assert_eq!(methods.contains_key("wsl_distributions"), cfg!(windows));
            assert_eq!(document["event"]["properties"]["version"]["const"], 1);
            assert_eq!(
                document["event"]["properties"]["event"]["oneOf"]
                    .as_array()
                    .unwrap()
                    .len(),
                8
            );
            assert_eq!(
                methods["repository_set_git_identity"]["request"],
                schema::<SetIdentity>()
            );
            assert_eq!(
                methods["repository_remotes"]["response"],
                schema::<Vec<RemoteInfo>>()
            );
            let prompt = document["event"]["properties"]["event"]["oneOf"]
                .as_array()
                .unwrap()
                .iter()
                .find(|variant| variant["properties"]["kind"]["const"] == "askpass_prompt")
                .unwrap();
            assert!(prompt["properties"]["data"]["properties"]["context"]["oneOf"].is_array());
        }
    }

    #[test]
    fn nested_request_schemas_reject_unknown_fields() {
        for (method, input) in [
            (
                "repository_open",
                json!({"location":{"kind":"native","path":".","extra":true}}),
            ),
            (
                "repository_run_operation",
                json!({"handle":"h","request":{"action":{"kind":"continue","extra":true}}}),
            ),
            (
                "repository_remote_action",
                json!({"handle":"h","action":{"kind":"fetch","remote":"origin","extra":true}}),
            ),
        ] {
            let _ = method;
            let rejected = match method {
                "repository_open" => serde_json::from_value::<Open>(input).is_err(),
                "repository_run_operation" => serde_json::from_value::<Operation>(input).is_err(),
                "repository_remote_action" => {
                    serde_json::from_value::<RemoteActionRequest>(input).is_err()
                }
                _ => unreachable!(),
            };
            assert!(rejected, "{method} accepted an unknown nested field");
        }
    }

    #[test]
    fn portable_review_inputs_are_strict_and_action_typed() {
        assert!(validate_portable_params(
            "repository_create_commit",
            json!({"message":"ok","unexpected":true})
        )
        .is_err());
        assert!(validate_portable_params(
            "repository_stage",
            json!({"paths":["one"],"unexpected":true})
        )
        .is_err());
        assert!(validate_portable_params(
            "repository_create_commit",
            json!({"message":"ok","identity":{"name":"N","email":"e","extra":true}})
        )
        .is_err());
        assert!(validate_portable_params("repository_stage", json!({"paths":["one"]})).is_ok());
    }

    #[test]
    fn dispatch_validation_uses_published_typed_parameter_dtos() {
        for (method, params) in [
            (
                "provider_connect_token",
                json!({"provider":"github","username":"user","token":"secret","unexpected":true}),
            ),
            (
                "ssh_test",
                json!({"host":"example.invalid","target":{"extra":true}}),
            ),
            (
                "wsl_directories",
                json!({"distribution":"Ubuntu","path":"/home","unexpected":true}),
            ),
        ] {
            assert_eq!(
                validate_params(method, params).unwrap_err().code,
                "invalidRequest",
                "{method}"
            );
        }
        assert!(validate_params(
            "provider_connect_token",
            json!({"provider":"github","username":"user","token":"secret"})
        )
        .is_ok());
    }
}
