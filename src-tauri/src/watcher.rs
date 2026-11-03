//! Filesystem watching for native sessions, so the frontend refreshes when the
//! repository changes instead of re-running the full status read on a short timer.
//!
//! Events are classified on the notifier's thread, coalesced on one worker thread
//! per session, and reported as `repository_changed`. Classification only drops
//! events that cannot change what Gitty shows: object-store writes, Git's transient
//! `*.lock` files inside Git directories, access-only notifications, and working
//! paths Git itself reports as ignored. Anything uncertain is a change.

use crate::{
    dto::{Error, RepositoryLocation, RepositorySession, Result},
    process,
    repository::{lock, Service},
};
use notify::{
    event::{AccessKind, AccessMode, MetadataKind, ModifyKind},
    Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

/// A burst ends after this much silence.
const QUIET: Duration = Duration::from_millis(300);
/// Continuous churn (a build, a long checkout) still reports at this cadence.
const MAX_DELAY: Duration = Duration::from_secs(2);
/// Events queued between batches; beyond this the batch is simply a change.
const QUEUE: usize = 8192;
/// Working paths checked against ignore rules per batch; beyond this, a change.
const MAX_PATHS: usize = 4096;
const CHECK_IGNORE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStatus {
    /// True while change events are delivered for this session.
    pub active: bool,
    /// Why watching is off: `unsupportedLocation` (WSL/SSH) or `unavailable`
    /// (the platform watcher could not be created, such as an inotify limit).
    pub reason: Option<String>,
    pub message: Option<String>,
}

impl WatchStatus {
    fn active() -> Self {
        Self {
            active: true,
            reason: None,
            message: None,
        }
    }
    fn off(reason: &str, message: impl Into<String>) -> Self {
        Self {
            active: false,
            reason: Some(reason.into()),
            message: Some(message.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryChanged {
    pub handle: String,
}

type Emit = Arc<dyn Fn(&str) + Send + Sync>;

struct Session {
    // Dropping the watcher drops the event sender, which ends the worker.
    _watcher: RecommendedWatcher,
    stop: Arc<AtomicBool>,
}
impl Drop for Session {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// One watcher per open native session. The registry lock only guards map
/// updates: watcher setup and teardown (which can walk a large tree on inotify or
/// join a run loop on FSEvents) never run under it or under the session registry.
pub struct Watchers {
    emit: Emit,
    sessions: Mutex<HashMap<String, Session>>,
}

impl Watchers {
    pub fn new(emit: impl Fn(&str) + Send + Sync + 'static) -> Self {
        Self {
            emit: Arc::new(emit),
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn start(&self, service: &Service, handle: &str) -> Result<WatchStatus> {
        if lock(&self.sessions)?.contains_key(handle) {
            return Ok(WatchStatus::active());
        }
        let repo = service.repo(handle)?;
        if !matches!(repo.session.location, RepositoryLocation::Native { .. }) {
            return Ok(WatchStatus::off(
                "unsupportedLocation",
                "Filesystem events are only watched for local repositories",
            ));
        }
        let roots = Roots::new(&repo.session);
        let location = repo.session.location.clone();
        drop(repo);
        let session = match self.spawn(handle, roots, location) {
            Ok(session) => session,
            Err(e) => return Ok(WatchStatus::off("unavailable", e.message)),
        };
        let replaced = lock(&self.sessions)?.insert(handle.to_string(), session);
        drop(replaced);
        // A close that raced setup has already tried to stop this handle.
        if service.repo(handle).is_err() {
            self.stop(handle);
            return Err(Error::new(
                "invalidHandle",
                "Repository session is closed or unknown",
            ));
        }
        Ok(WatchStatus::active())
    }

    pub fn stop(&self, handle: &str) {
        let removed = self.sessions.lock().ok().and_then(|mut s| s.remove(handle));
        drop(removed);
    }

    pub fn stop_all(&self) {
        let removed: Vec<_> = self
            .sessions
            .lock()
            .map(|mut s| s.drain().map(|(_, v)| v).collect())
            .unwrap_or_default();
        drop(removed);
    }

    #[cfg(test)]
    pub fn is_watching(&self, handle: &str) -> bool {
        self.sessions.lock().unwrap().contains_key(handle)
    }

    fn spawn(&self, handle: &str, roots: Roots, location: RepositoryLocation) -> Result<Session> {
        let unavailable = |e: notify::Error| {
            Error::new(
                "watcherUnavailable",
                format!("Filesystem watcher unavailable: {e}"),
            )
        };
        let (tx, rx) = mpsc::sync_channel::<Change>(QUEUE);
        let overflow = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let classify = roots.clone();
        let full = overflow.clone();
        let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
            for change in classify.event(event) {
                if let Err(mpsc::TrySendError::Full(_)) = tx.try_send(change) {
                    full.store(true, Ordering::Relaxed);
                }
            }
        })
        .map_err(unavailable)?;
        for path in roots.watch_paths() {
            watcher
                .watch(&path, RecursiveMode::Recursive)
                .map_err(unavailable)?;
        }
        let emit = self.emit.clone();
        let handle = handle.to_string();
        let worker_stop = stop.clone();
        thread::Builder::new()
            .name("gitty-watch".into())
            .spawn(move || worker(rx, overflow, worker_stop, &location, &handle, &*emit))
            .map_err(|e| Error::new("watcherUnavailable", e.to_string()))?;
        Ok(Session {
            _watcher: watcher,
            stop,
        })
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Change {
    /// Something Gitty shows may have changed.
    Refresh,
    /// A working-tree path, relative to the root with `/` separators, that is a
    /// change unless Git reports it as ignored.
    Working(String),
}

#[derive(Clone)]
struct Roots {
    /// Git and common directories, including canonical aliases.
    git: Vec<PathBuf>,
    /// The working tree, absent for bare repositories.
    work: Vec<PathBuf>,
    watch: Vec<PathBuf>,
}

fn aliases(path: &str) -> Vec<PathBuf> {
    let mut out = vec![PathBuf::from(path)];
    // Windows canonicalization yields verbatim `\\?\` paths the notifier never reports.
    if !cfg!(windows) {
        if let Ok(real) = std::fs::canonicalize(path) {
            if !out.contains(&real) {
                out.push(real);
            }
        }
    }
    out
}

impl Roots {
    fn new(session: &RepositorySession) -> Self {
        let mut git = aliases(&session.git_dir);
        for alias in aliases(&session.common_dir) {
            if !git.contains(&alias) {
                git.push(alias);
            }
        }
        let work = if session.bare {
            vec![]
        } else {
            aliases(&session.root)
        };
        let mut watch: Vec<PathBuf> = Vec::new();
        let candidates = (!session.bare)
            .then(|| PathBuf::from(&session.root))
            .into_iter()
            .chain([
                PathBuf::from(&session.git_dir),
                PathBuf::from(&session.common_dir),
            ]);
        for path in candidates {
            if !watch.iter().any(|w| path.starts_with(w)) {
                watch.retain(|w| !w.starts_with(&path));
                watch.push(path);
            }
        }
        Self { git, work, watch }
    }

    fn watch_paths(&self) -> Vec<PathBuf> {
        self.watch.clone()
    }

    fn event(&self, event: notify::Result<Event>) -> Vec<Change> {
        let event = match event {
            Ok(event) => event,
            Err(_) => return vec![Change::Refresh],
        };
        if event.need_rescan() {
            return vec![Change::Refresh];
        }
        match event.kind {
            EventKind::Access(AccessKind::Close(AccessMode::Write)) => {}
            EventKind::Access(_) => return vec![],
            EventKind::Modify(ModifyKind::Metadata(MetadataKind::AccessTime)) => return vec![],
            _ => {}
        }
        if event.paths.is_empty() {
            return vec![Change::Refresh];
        }
        event
            .paths
            .iter()
            .filter_map(|path| self.path(path))
            .collect()
    }

    fn path(&self, path: &Path) -> Option<Change> {
        for git in &self.git {
            if let Ok(rel) = path.strip_prefix(git) {
                let first = rel.components().next();
                if matches!(first, Some(Component::Normal(name)) if name == "objects") {
                    return None;
                }
                // Git's lock files are renamed onto their target (which reports
                // its own event) or deleted without effect.
                if rel
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.ends_with(".lock"))
                {
                    return None;
                }
                return Some(Change::Refresh);
            }
        }
        for work in &self.work {
            if let Ok(rel) = path.strip_prefix(work) {
                let mut parts = Vec::new();
                for component in rel.components() {
                    match component {
                        Component::Normal(name) => parts.push(name.to_str()?.to_string()),
                        _ => return Some(Change::Refresh),
                    }
                }
                // The root itself, or a linked worktree's `.git` file.
                if parts.is_empty() || parts[0] == ".git" {
                    return Some(Change::Refresh);
                }
                return Some(Change::Working(parts.join("/")));
            }
        }
        Some(Change::Refresh)
    }
}

#[derive(Default)]
struct Batch {
    refresh: bool,
    paths: HashSet<String>,
}
impl Batch {
    fn add(&mut self, change: Change) {
        match change {
            Change::Refresh => self.refresh = true,
            Change::Working(_) if self.refresh => {}
            Change::Working(path) => {
                if self.paths.len() >= MAX_PATHS {
                    self.refresh = true;
                    self.paths.clear();
                } else {
                    self.paths.insert(path);
                }
            }
        }
    }
    fn relevant(&self, location: &RepositoryLocation) -> bool {
        if self.refresh {
            return true;
        }
        if self.paths.is_empty() {
            return false;
        }
        match ignored(location, &self.paths) {
            Ok(ignored) => self.paths.iter().any(|p| !ignored.contains(p)),
            Err(_) => true,
        }
    }
}

/// Working paths Git would leave out of status. Tracked files are never reported
/// as ignored, even when an ignore pattern matches them.
fn ignored(location: &RepositoryLocation, paths: &HashSet<String>) -> Result<HashSet<String>> {
    let mut input = Vec::new();
    for path in paths {
        input.extend_from_slice(path.as_bytes());
        input.push(0);
    }
    let mut command =
        process::git_command(location, &process::args(&["check-ignore", "-z", "--stdin"]))?;
    // check-ignore refuses literal pathspec magic. Its stdin paths are matched
    // against ignore rules, not expanded; a path it misreads counts as a change.
    command.env_remove("GIT_LITERAL_PATHSPECS");
    let output =
        process::run_with_input_for(command, &input, CHECK_IGNORE_TIMEOUT, input.len().max(1))?;
    // Exit 1 means none matched; anything else is a failure.
    if !output.success && output.code != Some(1) {
        return Err(Error::new(
            "git",
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(output
        .stdout
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .map(|p| String::from_utf8_lossy(p).into_owned())
        .collect())
}

fn worker(
    rx: mpsc::Receiver<Change>,
    overflow: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    location: &RepositoryLocation,
    handle: &str,
    emit: &(dyn Fn(&str) + Send + Sync),
) {
    loop {
        let Ok(first) = rx.recv() else { return };
        let start = Instant::now();
        let mut last = start;
        let mut batch = Batch::default();
        batch.add(first);
        loop {
            let deadline = (last + QUIET).min(start + MAX_DELAY);
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            match rx.recv_timeout(deadline - now) {
                Ok(change) => {
                    batch.add(change);
                    last = Instant::now();
                }
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
        if overflow.swap(false, Ordering::Relaxed) {
            batch.refresh = true;
        }
        if stop.load(Ordering::Relaxed) {
            return;
        }
        if batch.relevant(location) && !stop.load(Ordering::Relaxed) {
            emit(handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{commit, git, init};
    use std::sync::mpsc::Receiver;

    fn service() -> (Service, tempfile::TempDir) {
        let data = tempfile::tempdir().unwrap();
        (Service::new(data.path().into()), data)
    }

    fn watchers() -> (Arc<Watchers>, Receiver<String>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let watchers = Arc::new(Watchers::new(move |handle| {
            let _ = tx.lock().unwrap().send(handle.to_string());
        }));
        (watchers, rx)
    }

    fn open(service: &Service, path: &Path) -> String {
        service
            .open(RepositoryLocation::Native {
                path: path.to_str().unwrap().into(),
            })
            .unwrap()
            .session
            .handle
    }

    /// Discards anything reported while the platform watcher settles.
    fn settle(rx: &Receiver<String>) {
        thread::sleep(Duration::from_millis(800));
        while rx.try_recv().is_ok() {}
    }

    fn expect_event(rx: &Receiver<String>, handle: &str) {
        let got = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("change event");
        assert_eq!(got, handle);
    }

    fn expect_quiet(rx: &Receiver<String>, wait: Duration) {
        if let Ok(handle) = rx.recv_timeout(wait) {
            panic!("unexpected change event for {handle}");
        }
    }

    fn count(rx: &Receiver<String>, wait: Duration) -> usize {
        let end = Instant::now() + wait;
        let mut n = 0;
        while let Some(left) = end.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(_) => n += 1,
                Err(_) => break,
            }
        }
        n
    }

    fn repository() -> tempfile::TempDir {
        let d = init();
        std::fs::write(d.path().join("tracked.txt"), "one\n").unwrap();
        std::fs::write(d.path().join(".gitignore"), "build/\n").unwrap();
        commit(d.path(), "initial");
        d
    }

    #[test]
    fn working_file_edit_reports_a_change() {
        let d = repository();
        let (service, _data) = service();
        let handle = open(&service, d.path());
        let (watchers, rx) = watchers();
        assert_eq!(
            watchers.start(&service, &handle).unwrap(),
            WatchStatus::active()
        );
        settle(&rx);
        std::fs::write(d.path().join("tracked.txt"), "two\n").unwrap();
        expect_event(&rx, &handle);
        std::fs::write(d.path().join("new.txt"), "untracked\n").unwrap();
        expect_event(&rx, &handle);
    }

    #[test]
    fn commits_and_branches_report_a_change() {
        let d = repository();
        let (service, _data) = service();
        let handle = open(&service, d.path());
        let (watchers, rx) = watchers();
        watchers.start(&service, &handle).unwrap();
        settle(&rx);
        git(d.path(), &["branch", "topic"]);
        expect_event(&rx, &handle);
        settle(&rx);
        git(d.path(), &["commit", "--allow-empty", "-m", "empty"]);
        expect_event(&rx, &handle);
    }

    #[test]
    fn ignored_paths_and_object_writes_are_quiet() {
        let d = repository();
        let (service, _data) = service();
        let handle = open(&service, d.path());
        let (watchers, rx) = watchers();
        watchers.start(&service, &handle).unwrap();
        settle(&rx);
        std::fs::create_dir_all(d.path().join("build/out")).unwrap();
        std::fs::write(d.path().join("build/out/artifact.o"), "bin").unwrap();
        // Writes an object without moving any ref or the index.
        std::fs::write(d.path().join("build/blob"), "blob").unwrap();
        git(d.path(), &["hash-object", "-w", "build/blob"]);
        expect_quiet(&rx, Duration::from_secs(2));
    }

    #[test]
    fn bursts_are_coalesced() {
        let d = repository();
        let (service, _data) = service();
        let handle = open(&service, d.path());
        let (watchers, rx) = watchers();
        watchers.start(&service, &handle).unwrap();
        settle(&rx);
        for i in 0..20 {
            std::fs::write(d.path().join("tracked.txt"), format!("{i}\n")).unwrap();
            thread::sleep(Duration::from_millis(30));
        }
        let n = count(&rx, Duration::from_secs(3));
        assert!((1..=2).contains(&n), "{n} events for one burst");
    }

    #[test]
    fn continuous_churn_still_reports_within_max_delay() {
        let d = repository();
        let (service, _data) = service();
        let handle = open(&service, d.path());
        let (watchers, rx) = watchers();
        watchers.start(&service, &handle).unwrap();
        settle(&rx);
        let started = Instant::now();
        let path = d.path().join("tracked.txt");
        let writer = thread::spawn(move || {
            for i in 0..60 {
                std::fs::write(&path, format!("{i}\n")).unwrap();
                thread::sleep(Duration::from_millis(100));
            }
        });
        rx.recv_timeout(Duration::from_secs(5))
            .expect("event during churn");
        assert!(started.elapsed() < Duration::from_secs(5));
        writer.join().unwrap();
    }

    #[test]
    fn snapshot_reads_do_not_report_changes() {
        let d = repository();
        // Dirty and untracked entries make status hash content and refresh stat data.
        std::fs::write(d.path().join("tracked.txt"), "changed\n").unwrap();
        std::fs::write(d.path().join("untracked.txt"), "new\n").unwrap();
        let (service, _data) = service();
        let handle = open(&service, d.path());
        let (watchers, rx) = watchers();
        watchers.start(&service, &handle).unwrap();
        settle(&rx);
        let repo = service.repo(&handle).unwrap();
        for _ in 0..3 {
            process::request(|| repo.snapshot()).unwrap();
            process::request(|| repo.status()).unwrap();
        }
        expect_quiet(&rx, Duration::from_secs(2));
    }

    #[test]
    fn close_stops_watching() {
        let d = repository();
        let (service, _data) = service();
        let handle = open(&service, d.path());
        let (watchers, rx) = watchers();
        watchers.start(&service, &handle).unwrap();
        assert!(watchers.is_watching(&handle));
        service.close(&handle).unwrap();
        watchers.stop(&handle);
        assert!(!watchers.is_watching(&handle));
        settle(&rx);
        std::fs::write(d.path().join("tracked.txt"), "after close\n").unwrap();
        expect_quiet(&rx, Duration::from_secs(2));
        assert!(watchers.start(&service, &handle).is_err());
    }

    #[test]
    fn linked_worktree_watches_its_git_dir_and_common_refs() {
        let d = repository();
        let parent = tempfile::tempdir().unwrap();
        let linked = parent.path().join("linked");
        git(
            d.path(),
            &["worktree", "add", "-b", "linked", linked.to_str().unwrap()],
        );
        let (service, _data) = service();
        let handle = open(&service, &linked);
        let (watchers, rx) = watchers();
        watchers.start(&service, &handle).unwrap();
        settle(&rx);
        // Refs live in the common directory, outside this worktree.
        git(d.path(), &["branch", "from-main"]);
        expect_event(&rx, &handle);
        settle(&rx);
        std::fs::write(linked.join("tracked.txt"), "linked edit\n").unwrap();
        expect_event(&rx, &handle);
    }

    #[test]
    fn classification_is_conservative() {
        let session = RepositorySession {
            handle: "h".into(),
            location: RepositoryLocation::Native {
                path: "/w/repo".into(),
            },
            name: "repo".into(),
            root: "/w/repo".into(),
            git_dir: "/w/repo/.git".into(),
            common_dir: "/w/repo/.git".into(),
            linked_worktree: false,
            shallow: false,
            bare: false,
            head: None,
            head_ref: None,
        };
        let roots = Roots::new(&session);
        assert_eq!(roots.watch_paths(), vec![PathBuf::from("/w/repo")]);
        let at = |p: &str| roots.path(Path::new(p));
        assert_eq!(at("/w/repo/.git/objects/ab/cdef"), None);
        assert_eq!(at("/w/repo/.git/objects"), None);
        assert_eq!(at("/w/repo/.git/index.lock"), None);
        assert_eq!(at("/w/repo/.git/refs/heads/main.lock"), None);
        assert_eq!(at("/w/repo/.git/index"), Some(Change::Refresh));
        assert_eq!(at("/w/repo/.git/refs/heads/main"), Some(Change::Refresh));
        assert_eq!(at("/w/repo/.git/MERGE_HEAD"), Some(Change::Refresh));
        assert_eq!(at("/w/repo/.git/logs/refs/stash"), Some(Change::Refresh));
        // Tracked lock files in the working tree are ordinary content.
        assert_eq!(
            at("/w/repo/Cargo.lock"),
            Some(Change::Working("Cargo.lock".into()))
        );
        assert_eq!(
            at("/w/repo/src/a b.rs"),
            Some(Change::Working("src/a b.rs".into()))
        );
        assert_eq!(at("/w/repo"), Some(Change::Refresh));
        assert_eq!(at("/elsewhere"), Some(Change::Refresh));
        let access =
            Event::new(EventKind::Access(AccessKind::Read)).add_path("/w/repo/.git/index".into());
        assert!(roots.event(Ok(access)).is_empty());
        let close_write = Event::new(EventKind::Access(AccessKind::Close(AccessMode::Write)))
            .add_path("/w/repo/.git/index".into());
        assert_eq!(roots.event(Ok(close_write)), vec![Change::Refresh]);
        assert_eq!(
            roots.event(Err(notify::Error::generic("lost"))),
            vec![Change::Refresh]
        );

        let mut bare = session.clone();
        bare.bare = true;
        bare.root = "/w/bare.git".into();
        bare.git_dir = "/w/bare.git".into();
        bare.common_dir = "/w/bare.git".into();
        let roots = Roots::new(&bare);
        assert_eq!(roots.watch_paths(), vec![PathBuf::from("/w/bare.git")]);
        assert_eq!(
            roots.path(Path::new("/w/bare.git/HEAD")),
            Some(Change::Refresh)
        );

        let mut linked = session;
        linked.root = "/w/linked".into();
        linked.git_dir = "/w/repo/.git/worktrees/linked".into();
        let roots = Roots::new(&linked);
        assert_eq!(
            roots.watch_paths(),
            vec![PathBuf::from("/w/linked"), PathBuf::from("/w/repo/.git")]
        );
        assert_eq!(
            roots.path(Path::new("/w/linked/.git")),
            Some(Change::Refresh)
        );
    }

    #[test]
    fn unknown_handles_are_refused() {
        let (watchers, _rx) = watchers();
        let (service, _data) = service();
        assert!(watchers.start(&service, "missing").is_err());
    }
}
