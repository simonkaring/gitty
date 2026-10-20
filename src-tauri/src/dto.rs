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
    Native {
        path: String,
    },
    Wsl {
        distribution: String,
        path: String,
    },
    /// A working tree on another machine, reached with the user's own `ssh`
    /// configuration. Git runs on that host; only its output crosses the socket.
    Ssh {
        host: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        port: Option<u16>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        user: Option<String>,
        path: String,
    },
}

/// Characters allowed in a host alias, hostname or SSH user. Anything else could
/// change how `ssh` parses the destination (options, `@`, path separators).
pub fn valid_ssh_word(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && !value.starts_with('-')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// The remote destination is interpolated into argv and therefore validated for
/// every call, not only when a session is opened.
pub fn validate_ssh_destination(host: &str, user: Option<&str>, port: Option<u16>) -> Result<()> {
    if !valid_ssh_word(host) {
        return Err(Error::new(
            "invalidHost",
            "Enter an SSH host alias or hostname using letters, digits, dots, dashes or underscores.",
        ));
    }
    if let Some(user) = user {
        if !valid_ssh_word(user) {
            return Err(Error::new(
                "invalidUser",
                "Enter an SSH user name using letters, digits, dots, dashes or underscores.",
            ));
        }
    }
    if port == Some(0) {
        return Err(Error::new(
            "invalidPort",
            "SSH ports must be between 1 and 65535.",
        ));
    }
    Ok(())
}

/// Remote paths are absolute POSIX paths. Control characters are refused even
/// though they would be safely single-quoted, because no Git directory is named
/// with one and a rejected value is easier to explain than a mangled argv.
pub fn validate_ssh_path(path: &str) -> Result<()> {
    let invalid = path.is_empty()
        || path.len() > 4096
        || !path.starts_with('/')
        || path.chars().any(char::is_control)
        || path.split('/').any(|part| part == "..");
    if invalid {
        return Err(Error::new(
            "invalidPath",
            "Remote repository paths must be absolute POSIX paths without control characters or '..' segments.",
        ));
    }
    Ok(())
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
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    #[serde(flatten)]
    pub summary: CommitSummary,
    pub body: String,
    pub can_edit_message: bool,
    pub edit_disabled_reason: Option<String>,
}
/// The commit that HEAD points at after a successful `repository_create_commit`,
/// which is the commit Git created unless a post-commit hook moved HEAD again.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedCommit {
    pub oid: String,
}
#[derive(Debug, Clone, Deserialize)]
pub struct CommitIdentity {
    pub name: String,
    pub email: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentityValues {
    pub name: Option<String>,
    pub email: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryGitIdentity {
    pub local: GitIdentityValues,
    pub effective: GitIdentityValues,
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
#[serde(rename_all = "camelCase")]
pub struct HunkAction {
    pub fingerprint: Option<String>,
    pub reason: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub hunks: Vec<DiffHunk>,
    pub binary: bool,
    pub truncated: bool,
    pub message: Option<String>,
    pub hunk_action: Option<HunkAction>,
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
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTarget {
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
}
/// What a connection test learned: the remote Git version, and the repository
/// name when a path was supplied and resolved.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshProbe {
    pub git_version: String,
    pub name: Option<String>,
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
