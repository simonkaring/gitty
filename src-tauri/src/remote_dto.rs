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
    },
    Pop {
        oid: String,
    },
    Drop {
        oid: String,
    },
}
