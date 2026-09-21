use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum OperationKind {
    None,
    Merge,
    Rebase,
    CherryPick,
    Revert,
    Unsupported,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationState {
    pub kind: OperationKind,
    pub label: String,
    pub current: Option<String>,
    pub incoming: Option<String>,
    pub step: Option<usize>,
    pub total: Option<usize>,
    pub conflicts: Vec<String>,
    pub can_continue: bool,
    pub can_skip: bool,
    pub fingerprint: String,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum GitAction {
    CreateBranch {
        name: String,
        start_point: String,
        checkout: bool,
    },
    SwitchBranch {
        branch: String,
    },
    Merge {
        source: String,
        no_fast_forward: bool,
    },
    Rebase {
        onto: String,
    },
    CherryPick {
        commits: Vec<String>,
        mainline: Option<usize>,
    },
    CreateTag {
        name: String,
        oid: String,
        message: Option<String>,
    },
    Continue,
    Skip,
    Abort,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationRequest {
    pub action: GitAction,
    pub expected_head: Option<String>,
    pub expected_head_ref: Option<String>,
    pub expected_operation: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub head: Option<String>,
    pub operation: OperationState,
    pub output: String,
}

#[derive(Debug, Serialize)]
pub struct ConflictVersion {
    pub oid: String,
    pub mode: String,
    pub content: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    pub fingerprint: String,
    pub base: Option<ConflictVersion>,
    pub ours: Option<ConflictVersion>,
    pub theirs: Option<ConflictVersion>,
    pub result: Option<String>,
    pub editable: bool,
    pub reason: Option<String>,
    pub ours_label: String,
    pub theirs_label: String,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ConflictResolution {
    Text { content: String },
    Ours,
    Theirs,
    Delete,
    Working,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    pub fetch_url: String,
    pub push_url: String,
    pub branches: Vec<String>,
    pub current_upstream: Option<String>,
}
