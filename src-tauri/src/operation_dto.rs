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

/// Everything a refresh needs, read once and consistent with each other.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySnapshot {
    pub state: crate::dto::RepositoryState,
    pub status: crate::dto::RepositoryStatus,
    pub operation: OperationState,
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
        /// Carry staged/unstaged work to the target branch, merging it where
        /// the branches differ. Conflicts are left for the conflict editor.
        #[serde(default)]
        carry_changes: bool,
    },
    Merge {
        source: String,
        destination: Option<String>,
        no_fast_forward: bool,
        message: Option<String>,
        #[serde(default)]
        stash_changes: bool,
    },
    Rebase {
        onto: String,
    },
    InteractiveRebase {
        onto: String,
        steps: Vec<RebaseStep>,
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

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RebaseStep {
    pub oid: String,
    pub instruction: RebaseInstruction,
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RebaseInstruction {
    Pick,
    Drop,
    Reword,
    Squash,
    Fixup,
}

impl RebaseInstruction {
    pub fn git(self) -> &'static str {
        match self {
            Self::Pick => "pick",
            Self::Drop => "drop",
            Self::Reword => "reword",
            Self::Squash => "squash",
            Self::Fixup => "fixup",
        }
    }
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
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
