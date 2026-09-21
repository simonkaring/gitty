use crate::{
    dto::*,
    process::{self, args},
};
use std::{
    collections::{hash_map::DefaultHasher, HashMap, HashSet},
    hash::{Hash, Hasher},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};

pub fn fingerprint(data: impl Hash) -> String {
    let mut h = DefaultHasher::new();
    data.hash(&mut h);
    format!("{:016x}", h.finish())
}
pub fn token() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn string(location: &RepositoryLocation, values: &[&str]) -> Result<String> {
    let text = process::text(process::checked(location, &args(values))?)?;
    Ok(text.strip_suffix('\n').unwrap_or(&text).to_string())
}
pub fn resolve(location: &RepositoryLocation, revision: &str) -> Result<String> {
    if revision.is_empty()
        || revision.starts_with('-')
        || revision.contains('\0')
        || revision.len() > 4096
    {
        return Err(Error::new("invalidRevision", "Invalid revision"));
    }
    string(
        location,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{revision}^{{commit}}"),
        ],
    )
}
fn optional(location: &RepositoryLocation, values: &[&str]) -> Result<Option<String>> {
    let o = process::git(location, &args(values))?;
    if o.success {
        Ok(Some(process::text(o.stdout)?.trim_end_matches('\n').into()))
    } else {
        Ok(None)
    }
}
pub struct Walk {
    stream: Option<crate::stream::GitStream>,
    cache: std::fs::File,
    pub cached_count: usize,
    oid_width: usize,
    pub shallow: bool,
}
impl Walk {
    fn new(location: &RepositoryLocation, tips: Vec<String>, shallow: bool) -> Result<Self> {
        let cache = tempfile::tempfile()?;
        let stream = if tips.is_empty() {
            None
        } else {
            let mut a = args(&["rev-list", "--topo-order"]);
            a.extend(tips);
            a.push("--".into());
            Some(crate::stream::GitStream::git(location, &a, b'\n', 128)?)
        };
        Ok(Self {
            stream,
            cache,
            cached_count: 0,
            oid_width: 0,
            shallow,
        })
    }
    pub(crate) fn page(&mut self, start: usize, limit: usize) -> Result<(Vec<String>, bool)> {
        // Cache only requested IDs plus one lookahead; disk storage makes cursor replay cheap
        // without retaining the entire visited graph in application memory.
        let wanted = start
            .checked_add(limit + 1)
            .ok_or_else(|| Error::new("invalidCursor", "History offset overflow"))?;
        while self.cached_count < wanted {
            let Some(stream) = self.stream.as_mut() else {
                break;
            };
            let Some(id) = stream.next()? else {
                self.stream.take();
                break;
            };
            if !matches!(id.len(), 40 | 64)
                || !id.iter().all(u8::is_ascii_hexdigit)
                || (self.oid_width != 0 && id.len() != self.oid_width)
            {
                return Err(Error::new(
                    "gitParse",
                    "Invalid object ID in pinned history stream",
                ));
            }
            self.oid_width = id.len();
            self.cache.seek(SeekFrom::End(0))?;
            self.cache.write_all(&id)?;
            self.cache.write_all(b"\n")?;
            self.cached_count += 1;
        }
        let end = (start + limit).min(self.cached_count);
        self.cache
            .seek(SeekFrom::Start((start * (self.oid_width + 1)) as u64))?;
        let mut bytes = vec![0; (end - start) * (self.oid_width + 1)];
        self.cache.read_exact(&mut bytes)?;
        let ids = process::text(bytes)?.lines().map(String::from).collect();
        Ok((ids, end < self.cached_count))
    }
}
pub struct Repository {
    pub session: RepositorySession,
    pub(crate) history: Mutex<History>,
}
#[derive(Default)]
pub(crate) struct History {
    pub walks: HashMap<String, Walk>,
    pub cursors: HashMap<String, (String, usize)>,
}
pub struct Service {
    repositories: Mutex<HashMap<String, Arc<Repository>>>,
    pub recent_path: PathBuf,
    recent_lock: Mutex<()>,
}
fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>> {
    mutex
        .lock()
        .map_err(|_| Error::new("worker", "Repository lock poisoned"))
}
impl Service {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            repositories: Mutex::new(HashMap::new()),
            recent_path: data_dir.join("recent-repositories.json"),
            recent_lock: Mutex::new(()),
        }
    }
    pub fn recent(&self) -> Result<Vec<RepositoryLocation>> {
        let _guard = lock(&self.recent_lock)?;
        self.read_recent()
    }
    fn read_recent(&self) -> Result<Vec<RepositoryLocation>> {
        match std::fs::File::open(&self.recent_path) {
            Ok(file) => {
                let mut v = Vec::new();
                file.take(128 * 1024 + 1).read_to_end(&mut v)?;
                if v.len() > 128 * 1024 {
                    return Err(Error::new(
                        "recentData",
                        "Recent repository data exceeds 128 KiB",
                    ));
                }
                serde_json::from_slice(&v).map_err(|e| Error::new("recentData", e.to_string()))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
            Err(e) => Err(e.into()),
        }
    }
    pub fn open(&self, mut location: RepositoryLocation) -> Result<RepositoryState> {
        if let RepositoryLocation::Wsl { path, .. } = &location {
            if !path.starts_with('/') || path.contains('\0') {
                return Err(Error::new(
                    "invalidPath",
                    "WSL repository paths must be absolute Linux paths",
                ));
            }
        }
        if let RepositoryLocation::Native { path } = &mut location {
            if path.to_ascii_lowercase().starts_with("\\\\wsl") {
                return Err(Error::new(
                    "wslLocationRequired",
                    "Select a WSL distribution instead of opening a WSL UNC path",
                ));
            }
            *path = std::fs::canonicalize(&*path)?
                .to_str()
                .ok_or_else(|| Error::new("unsupportedEncoding", "Repository path is not UTF-8"))?
                .into();
        }
        if lock(&self.repositories)?.len() >= 32 {
            return Err(Error::new(
                "sessionLimit",
                "Close a repository before opening more than 32 sessions",
            ));
        }
        let bare = string(&location, &["rev-parse", "--is-bare-repository"])? == "true";
        let root = if bare {
            string(&location, &["rev-parse", "--absolute-git-dir"])?
        } else {
            string(&location, &["rev-parse", "--show-toplevel"])?
        };
        match &mut location {
            RepositoryLocation::Native { path } | RepositoryLocation::Wsl { path, .. } => {
                *path = root.clone()
            }
        }
        let git_dir = string(&location, &["rev-parse", "--absolute-git-dir"])?;
        let common_dir = string(
            &location,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )?;
        // Reject promisor repositories rather than letting older Git versions implicitly fetch missing objects.
        let partial = process::git(
            &location,
            &args(&[
                "config",
                "--includes",
                "--get-regexp",
                "^(extensions\\.partialclone|remote\\..*\\.promisor)$",
            ]),
        )?;
        if partial.success && !partial.stdout.is_empty() {
            return Err(Error::new(
                "unsupportedPartialClone",
                "Partial/promisor clones are unsupported for guaranteed offline reads",
            ));
        }
        let session = RepositorySession {
            handle: token(),
            location,
            name: root.rsplit(['/', '\\']).next().unwrap_or(&root).to_string(),
            root,
            linked_worktree: git_dir != common_dir,
            git_dir,
            common_dir,
            shallow: false,
            bare,
            head: None,
            head_ref: None,
        };
        let repo = Repository {
            session,
            history: Mutex::new(History::default()),
        };
        let state = repo.state()?;
        // Only recent-file updates serialize with one another; discovery and every
        // Git subprocess above run without holding the session registry lock.
        let _recent_guard = lock(&self.recent_lock)?;
        // Concurrent opens may have filled the registry during discovery.
        if lock(&self.repositories)?.len() >= 32 {
            return Err(Error::new(
                "sessionLimit",
                "Close a repository before opening more than 32 sessions",
            ));
        }
        let mut recent = self.read_recent()?;
        recent.retain(|x| x != &repo.session.location);
        recent.insert(0, repo.session.location.clone());
        recent.truncate(20);
        std::fs::create_dir_all(self.recent_path.parent().unwrap())?;
        let bytes = serde_json::to_vec_pretty(&recent)
            .map_err(|e| Error::new("recentData", e.to_string()))?;
        let mut tmp = tempfile::NamedTempFile::new_in(self.recent_path.parent().unwrap())?;
        tmp.write_all(&bytes)?;
        tmp.as_file().sync_all()?;
        tmp.persist(&self.recent_path)
            .map_err(|e| Error::from(e.error))?;
        lock(&self.repositories)?.insert(repo.session.handle.clone(), Arc::new(repo));
        Ok(state)
    }
    pub fn repo(&self, handle: &str) -> Result<Arc<Repository>> {
        lock(&self.repositories)?
            .get(handle)
            .cloned()
            .ok_or_else(|| Error::new("invalidHandle", "Repository session is closed or unknown"))
    }
    pub fn close(&self, handle: &str) -> Result<()> {
        let removed = lock(&self.repositories)?.remove(handle);
        // Reaping pinned streams must never hold the registry lock. In-flight
        // requests retain their Arc and may finish; subsequent lookups fail.
        drop(removed);
        Ok(())
    }
}
impl Repository {
    pub fn location(&self) -> &RepositoryLocation {
        &self.session.location
    }
    pub fn state(&self) -> Result<RepositoryState> {
        let mut session = self.session.clone();
        session.head = optional(self.location(), &["rev-parse", "--verify", "HEAD^{commit}"])?;
        session.head_ref = optional(self.location(), &["symbolic-ref", "-q", "HEAD"])?;
        session.shallow =
            string(self.location(), &["rev-parse", "--is-shallow-repository"])? == "true";
        // Deepening a shallow clone can change the graph without moving any ref
        // or changing the boolean shallow flag. Hash the actual boundary file
        // through Git so WSL uses Linux paths and no objects are written.
        let shallow_boundary = if session.shallow {
            let path = string(
                self.location(),
                &[
                    "rev-parse",
                    "--path-format=absolute",
                    "--git-path",
                    "shallow",
                ],
            )?;
            Some(string(
                self.location(),
                &["hash-object", "--no-filters", "--", &path],
            )?)
        } else {
            None
        };
        let raw = string(self.location(), &["for-each-ref", "--format=%(refname)%00%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)", "refs/heads", "refs/remotes", "refs/tags"])?;
        let mut refs = vec![];
        for line in raw.lines().filter(|s| !s.is_empty()) {
            let f: Vec<_> = line.split('\0').collect();
            if f.len() != 5 {
                return Err(Error::new("gitParse", "Malformed reference record"));
            }
            let id = if f[1] == "commit" {
                f[2].to_string()
            } else if f[3] == "commit" {
                f[4].to_string()
            } else {
                match resolve(self.location(), f[0]) {
                    Ok(id) => id,
                    Err(_) => continue,
                }
            };
            let (prefix, kind) = if f[0].starts_with("refs/heads/") {
                ("refs/heads/", "local")
            } else if f[0].starts_with("refs/remotes/") {
                ("refs/remotes/", "remote")
            } else {
                ("refs/tags/", "tag")
            };
            refs.push(RepositoryRef {
                name: f[0].trim_start_matches(prefix).into(),
                full_name: f[0].into(),
                commit_id: id,
                kind: kind.into(),
            });
        }
        let remotes: Vec<String> = string(self.location(), &["remote"])?
            .lines()
            .map(String::from)
            .collect();
        let fingerprint = fingerprint((
            &raw,
            &session.head,
            &session.head_ref,
            session.shallow,
            &shallow_boundary,
            &remotes,
        ));
        Ok(RepositoryState {
            session,
            refs,
            remotes,
            fingerprint,
        })
    }
    pub fn tips(&self, branch: Option<&str>) -> Result<(Vec<String>, bool)> {
        let state = self.state()?;
        if let Some(branch) = branch.filter(|s| !s.is_empty()) {
            return Ok((
                vec![resolve(self.location(), branch)?],
                state.session.shallow,
            ));
        }
        let mut tips: Vec<_> = state.refs.into_iter().map(|r| r.commit_id).collect();
        tips.extend(state.session.head);
        tips.sort();
        tips.dedup();
        Ok((tips, state.session.shallow))
    }
    pub fn history(
        &self,
        cursor: Option<String>,
        limit: usize,
        query: HistoryQuery,
    ) -> Result<HistoryPage> {
        let limit = limit.clamp(1, 200);
        let mut history = lock(&self.history)?;
        let (generation, start) = if let Some(cursor) = cursor {
            history.cursors.get(&cursor).cloned().ok_or_else(|| {
                Error::new("staleCursor", "History cursor expired; reload history")
            })?
        } else {
            if history.walks.len() >= 8 {
                history.walks.clear();
                history.cursors.clear();
            }
            let (tips, shallow) = self.tips(query.branch.as_deref())?;
            let generation = token();
            let walk = Walk::new(self.location(), tips, shallow)?;
            history.walks.insert(generation.clone(), walk);
            (generation, 0)
        };
        let walk = history
            .walks
            .get_mut(&generation)
            .ok_or_else(|| Error::new("staleCursor", "History generation expired"))?;
        let shallow = walk.shallow;
        let (ids, more) = match walk.page(start, limit) {
            Ok(page) => page,
            Err(e) => {
                history.walks.remove(&generation);
                history.cursors.retain(|_, (g, _)| g != &generation);
                return Err(e);
            }
        };
        let end = start + ids.len();
        let cursor = if more {
            if let Some((cursor, _)) = history
                .cursors
                .iter()
                .find(|(_, value)| value.0 == generation && value.1 == end)
            {
                Some(cursor.clone())
            } else {
                let c = token();
                history.cursors.insert(c.clone(), (generation.clone(), end));
                Some(c)
            }
        } else {
            None
        };
        drop(history);
        let commits = crate::commit::batch(self.location(), &ids)?;
        Ok(HistoryPage {
            commits,
            cursor,
            generation,
            shallow,
        })
    }
    pub fn commit(&self, revision: &str) -> Result<CommitDetail> {
        let id = resolve(self.location(), revision)?;
        let raw = process::checked(self.location(), &args(&["cat-file", "commit", &id]))?;
        crate::commit::parse(&id, &raw)
    }
    pub fn require_worktree(&self) -> Result<()> {
        if self.session.bare {
            Err(Error::new(
                "bareRepository",
                "This operation requires a working tree",
            ))
        } else {
            Ok(())
        }
    }
    pub fn status(&self) -> Result<RepositoryStatus> {
        let mut status = self.status_entries()?;
        let mut hash = DefaultHasher::new();
        status.fingerprint.hash(&mut hash);
        // Porcelain includes index object IDs, but only status letters for working
        // files. Hash actual binary-capable patches so repeated same-size edits
        // invalidate the inspector, including files with restored mtimes.
        if status
            .entries
            .iter()
            .any(|e| !e.untracked && e.worktree_status != ".")
        {
            let a = args(&[
                "diff",
                "--ours",
                "--binary",
                "--full-index",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--no-renames",
                "--ignore-submodules=none",
                "--",
            ]);
            let mut stream = crate::stream::GitStream::diff(self.location(), &a)?;
            while let Some(record) = stream.next()? {
                record.hash(&mut hash);
            }
        }
        for entry in status.entries.iter().filter(|e| e.untracked) {
            entry.path.hash(&mut hash);
            // Git reports untracked embedded repositories as a single directory
            // even with -uall. A no-index file patch cannot represent a directory.
            if entry.path.ends_with('/') {
                continue;
            }
            let a = args(&[
                "diff",
                "--no-index",
                "--binary",
                "--full-index",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--",
                "/dev/null",
                &entry.path,
            ]);
            let mut stream = crate::stream::GitStream::diff(self.location(), &a)?;
            while let Some(record) = stream.next()? {
                record.hash(&mut hash);
            }
        }
        status.fingerprint = format!("{:016x}", hash.finish());
        Ok(status)
    }
    // Internal diff validation needs paths/status only, not refresh fingerprints.
    pub(crate) fn status_entries(&self) -> Result<RepositoryStatus> {
        self.require_worktree()?;
        let bytes = process::checked(
            self.location(),
            &args(&[
                "status",
                "--porcelain=v2",
                "-z",
                "--branch",
                "--untracked-files=all",
                "--ignore-submodules=none",
            ]),
        )?;
        let fingerprint = fingerprint(&bytes);
        let raw = process::text(bytes)?;
        let mut fields = raw.split('\0').filter(|s| !s.is_empty());
        let mut entries = vec![];
        let mut head = None;
        let mut head_ref = None;
        while let Some(record) = fields.next() {
            if let Some(v) = record.strip_prefix("# branch.oid ") {
                if v != "(initial)" {
                    head = Some(v.into());
                }
                continue;
            }
            if let Some(v) = record.strip_prefix("# branch.head ") {
                if v != "(detached)" {
                    head_ref = Some(format!("refs/heads/{v}"));
                }
                continue;
            }
            if record.starts_with('#') || record.starts_with('!') {
                continue;
            }
            let kind = record.as_bytes()[0];
            let (path, xy, old_path) = match kind {
                b'?' => (&record[2..], "??", None),
                b'1' | b'2' | b'u' => {
                    let n = if kind == b'1' {
                        9
                    } else if kind == b'2' {
                        10
                    } else {
                        11
                    };
                    let f: Vec<_> = record.splitn(n, ' ').collect();
                    if f.len() != n {
                        return Err(Error::new("gitParse", "Malformed porcelain status"));
                    }
                    let old = if kind == b'2' {
                        Some(
                            fields
                                .next()
                                .ok_or_else(|| Error::new("gitParse", "Missing rename source"))?
                                .into(),
                        )
                    } else {
                        None
                    };
                    (f[n - 1], f[1], old)
                }
                _ => return Err(Error::new("gitParse", "Unknown porcelain status record")),
            };
            if xy.len() != 2 {
                return Err(Error::new("gitParse", "Invalid status code"));
            }
            entries.push(StatusEntry {
                path: path.into(),
                old_path,
                index_status: xy[0..1].into(),
                worktree_status: xy[1..2].into(),
                conflicted: kind == b'u',
                untracked: kind == b'?',
            });
        }
        Ok(RepositoryStatus {
            entries,
            head,
            head_ref,
            fingerprint,
        })
    }
    pub fn search(&self, query: SearchQuery) -> Result<SearchResult> {
        if query.text.len() > 4096 {
            return Err(Error::new("invalidQuery", "Search text is too long"));
        }
        let state = self.state()?;
        let needle = query.text.to_lowercase();
        let mut ref_matches: HashSet<String> = state
            .refs
            .iter()
            .filter(|r| {
                (needle.starts_with("refs/") && r.full_name.to_lowercase().contains(&needle))
                    || r.name.to_lowercase().contains(&needle)
            })
            .map(|r| r.commit_id.clone())
            .collect();
        if "head".contains(&needle) {
            ref_matches.extend(state.session.head.clone());
        }
        let mut tips = if let Some(branch) = query.branch.as_deref().filter(|b| !b.is_empty()) {
            vec![resolve(self.location(), branch)?]
        } else {
            let mut ids: Vec<_> = state.refs.into_iter().map(|r| r.commit_id).collect();
            ids.extend(state.session.head);
            ids
        };
        tips.sort();
        tips.dedup();
        if tips.is_empty() {
            return Ok(SearchResult {
                commits: vec![],
                truncated: false,
            });
        }
        let mut a = args(&[
            "log",
            "--topo-order",
            "--no-show-signature",
            "--format=%H%x00%an%x00%ae%x00%B%x00",
        ]);
        if let Some(since) = query.since {
            a.push(format!("--since-as-filter={since}"));
        }
        if let Some(until) = query.until {
            a.push(format!("--until={until}"));
        }
        a.extend(tips);
        a.push("--".into());
        if let Some(path) = query.path {
            validate_path(&path)?;
            a.push(path);
        }
        // Apply structural filters in Git once, then OR textual fields on that same
        // topological stream. --grep plus --author would incorrectly be an AND.
        let mut stream = crate::stream::GitStream::git(self.location(), &a, 0, 32 * 1024 * 1024)?;
        let mut ids = Vec::new();
        while let Some(raw) = stream.next()? {
            let id = process::text(raw)?.trim_start_matches('\n').to_string();
            if id.is_empty() {
                continue;
            }
            if !matches!(id.len(), 40 | 64) || !id.as_bytes().iter().all(u8::is_ascii_hexdigit) {
                return Err(Error::new("gitParse", "Malformed search commit ID"));
            }
            let mut field = || -> Result<String> {
                process::text(
                    stream
                        .next()?
                        .ok_or_else(|| Error::new("gitParse", "Incomplete search record"))?,
                )
            };
            let author = field()?;
            let email = field()?;
            let message = field()?;
            if needle.is_empty()
                || id.starts_with(&needle)
                || author.to_lowercase().contains(&needle)
                || email.to_lowercase().contains(&needle)
                || message.to_lowercase().contains(&needle)
                || ref_matches.contains(&id)
            {
                ids.push(id);
                if ids.len() == 501 {
                    break;
                }
            }
        }
        drop(stream);
        let commits = ids
            .iter()
            .take(500)
            .map(|id| self.commit(id).map(|c| c.summary))
            .collect::<Result<_>>()?;
        Ok(SearchResult {
            commits,
            truncated: ids.len() > 500,
        })
    }
}
pub fn validate_path(path: &str) -> Result<()> {
    if path.is_empty()
        || path.contains('\0')
        || path.starts_with('/')
        || path.split('/').any(|p| p == "..")
        || Path::new(path).is_absolute()
        || Path::new(path).components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::Prefix(_)
            )
        })
    {
        return Err(Error::new(
            "invalidPath",
            "Expected a repository-relative file path",
        ));
    }
    Ok(())
}
