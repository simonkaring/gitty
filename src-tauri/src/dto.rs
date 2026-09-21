use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
pub struct Error {
    pub code: String,
    pub message: String,
}
impl Error {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::new("io", e.to_string())
    }
}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RepositoryLocation {
    Native { path: String },
    Wsl { distribution: String, path: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySession {
    pub handle: String,
    pub location: RepositoryLocation,
    pub name: String,
    pub root: String,
    pub git_dir: String,
    pub common_dir: String,
    pub linked_worktree: bool,
    pub shallow: bool,
    pub bare: bool,
    pub head: Option<String>,
    pub head_ref: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryRef {
    pub name: String,
    pub full_name: String,
    pub commit_id: String,
    pub kind: String,
}
#[derive(Debug, Clone, Serialize)]
pub struct CommitSummary {
    pub id: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub author: String,
    pub email: String,
    pub timestamp: i64,
}
#[derive(Debug, Clone, Serialize)]
pub struct CommitDetail {
    #[serde(flatten)]
    pub summary: CommitSummary,
    pub body: String,
}
#[derive(Debug, Serialize)]
pub struct HistoryPage {
    pub commits: Vec<CommitSummary>,
    pub cursor: Option<String>,
    pub generation: String,
    pub shallow: bool,
}
#[derive(Debug, Default, Deserialize)]
pub struct HistoryQuery {
    pub branch: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub path: String,
    pub old_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
    pub conflicted: bool,
    pub untracked: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryStatus {
    pub entries: Vec<StatusEntry>,
    pub head: Option<String>,
    pub head_ref: Option<String>,
    pub fingerprint: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DiffSpec {
    Commit { oid: String, parent: Option<String> },
    Compare { base: String, target: String },
    Staged,
    Unstaged,
    Untracked,
    Conflict,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    pub binary: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: String,
    pub content: String,
    pub old_line: Option<u64>,
    pub new_line: Option<u64>,
}
#[derive(Debug, Serialize)]
pub struct DiffHunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}
#[derive(Debug, Serialize)]
pub struct FileDiff {
    pub path: String,
    pub hunks: Vec<DiffHunk>,
    pub binary: bool,
    pub truncated: bool,
    pub message: Option<String>,
}
#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub text: String,
    pub branch: Option<String>,
    pub since: Option<String>,
    pub until: Option<String>,
    pub path: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub commits: Vec<CommitSummary>,
    pub truncated: bool,
}
#[derive(Debug, Serialize)]
pub struct RepositoryState {
    pub session: RepositorySession,
    pub refs: Vec<RepositoryRef>,
    pub remotes: Vec<String>,
    pub fingerprint: String,
}
#[derive(Debug, Serialize)]
pub struct WslDistribution {
    pub name: String,
    pub running: bool,
}
#[derive(Debug, Serialize)]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
}
