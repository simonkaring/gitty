use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncInfo {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: Option<u64>,
    pub behind: Option<u64>,
    pub remotes: Vec<String>,
}

#[derive(Debug, Deserialize, Default, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum PullMode {
    #[default]
    FfOnly,
    Merge,
    Rebase,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RemoteAction {
    Fetch {
        remote: Option<String>,
        branch: Option<String>,
    },
    Pull {
        remote: Option<String>,
        branch: Option<String>,
        #[serde(default)]
        pull_mode: PullMode,
    },
    BackgroundFetch,

    Push {
        remote: Option<String>,
        branch: Option<String>,
        #[serde(default)]
        set_upstream: bool,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionOutput {
    pub output: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub oid: String,
    pub selector: String,
    pub message: String,
    /// Parents of the stash commit; the graph shows only the base commit (first).
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub timestamp: i64,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum StashAction {
    Save {
        message: Option<String>,
        #[serde(default)]
        include_untracked: bool,
    },
    Apply {
        oid: String,
        #[serde(default)]
        restore_index: bool,
    },
    Pop {
        oid: String,
        #[serde(default)]
        restore_index: bool,
    },
    Drop {
        oid: String,
    },
    /// Rewrite a stash's reflog message. Git has no in-place reflog edit, so the
    /// entry is re-stored with the new message (moving it to the top of the list).
    EditMessage {
        oid: String,
        message: String,
    },
}
