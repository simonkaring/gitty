//! Explicit object-store acceleration; never maintenance during a read.
use crate::{
    dto::*,
    process::{self, args},
    repository::{lock, string, Repository, Service},
};
use serde::Serialize;
use std::{
    collections::HashMap,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Default)]
pub(crate) struct Jobs {
    stopped: bool,
    running: HashMap<String, (String, Arc<Control>)>,
}

#[derive(Default)]
struct Control {
    cancelled: AtomicBool,
    child: Mutex<Option<process::ChildWait>>,
}
impl Control {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        // Window close cannot rely on a worker getting another scheduling turn.
        // Share the spawn/publication lock so no child can escape cancellation.
        if let Ok(child) = self.child.lock() {
            if let Some(child) = child.as_ref() {
                child.kill();
            }
        }
    }
}

struct Job<'a> {
    service: &'a Service,
    key: String,
    cancel: Arc<Control>,
}
impl Drop for Job<'_> {
    fn drop(&mut self) {
        if let Ok(mut jobs) = self.service.commit_graph_jobs.lock() {
            jobs.running.remove(&self.key);
        }
    }
}

/// Bounded capture and tree cleanup, including pipes inherited by descendants.
/// Closing the owning session/window cancels this object-store-only operation.
fn run_write(mut command: Command, control: &Control) -> Result<process::Output> {
    let mut slot = lock(&control.child)?;
    if control.cancelled.load(Ordering::Acquire) {
        return Err(Error::new(
            "cancelled",
            "History acceleration was cancelled",
        ));
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| Error::new("processStart", e.to_string()))?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let overflow = Arc::new(AtomicBool::new(false));
    let (sender, receiver) = mpsc::channel();
    *slot = Some(process::ChildWait::new(child, sender.clone())?);
    drop(slot);
    let readers: Vec<_> = [
        Box::new(stdout) as Box<dyn std::io::Read + Send>,
        Box::new(stderr),
    ]
    .into_iter()
    .map(|reader| {
        let overflow = overflow.clone();
        let sender = sender.clone();
        thread::spawn(move || {
            let result = process::capture(reader, overflow);
            let _ = sender.send(process::ProcessEvent::Captured);
            result
        })
    })
    .collect();
    drop(sender);
    let started = Instant::now();
    let mut exited = None;
    let mut captured = 0;
    let result = loop {
        let failure = if control.cancelled.load(Ordering::Acquire) {
            Some(Error::new(
                "cancelled",
                "History acceleration was cancelled",
            ))
        } else if overflow.load(Ordering::Relaxed) {
            Some(Error::new(
                "outputLimit",
                "Commit-graph output exceeded the capture limit",
            ))
        } else if started.elapsed() >= Duration::from_secs(15 * 60) {
            Some(Error::new(
                "timeout",
                "History acceleration exceeded its 15 minute deadline",
            ))
        } else {
            None
        };
        if let Some(error) = failure {
            break Err(error);
        }
        if captured == 2 {
            if let Some(status) = exited.take() {
                break status;
            }
        }
        match receiver.recv_timeout(process::WAIT_CHECK_INTERVAL) {
            Ok(process::ProcessEvent::Exited(status)) => exited = Some(status.map_err(Error::from)),
            Ok(process::ProcessEvent::Captured) => captured += 1,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                break Err(Error::new("process", "Process waiter ended unexpectedly"))
            }
        }
    };
    let mut child = lock(&control.child)?.take().unwrap();
    if result.is_err() {
        child.kill();
    }
    child.reap();
    if let Err(error) = result {
        let deadline = Instant::now() + process::READER_SHUTDOWN_TIMEOUT;
        while captured < 2 {
            match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(process::ProcessEvent::Captured) => captured += 1,
                Ok(process::ProcessEvent::Exited(_)) => {}
                Err(_) => break,
            }
        }
        for reader in readers {
            if reader.is_finished() {
                let _ = reader.join();
            }
        }
        return Err(error);
    }
    let mut output = Vec::new();
    for reader in readers {
        output.push(
            reader
                .join()
                .map_err(|_| Error::new("process", "Output reader failed"))??,
        );
    }
    let status = result?;
    Ok(process::Output {
        success: status.success(),
        code: status.code(),
        stdout: output.remove(0),
        stderr: output.remove(0),
    })
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CommitGraphStatus {
    Present,
    Missing,
    Disabled,
}

fn disabled(repo: &Repository) -> Result<bool> {
    let output = process::git(
        &repo.session.location,
        &args(&[
            "config",
            "--includes",
            "--type=bool",
            "--get",
            "core.commitGraph",
        ]),
    )?;
    if output.code == Some(1) {
        return Ok(false);
    }
    if !output.success {
        return Err(Error::new("git", crate::mutate::report(&output)));
    }
    Ok(process::text(output.stdout)?.trim() == "false")
}

// count-objects C-quotes alternate paths with control or non-ASCII bytes.
fn alternate_path(value: &str) -> Result<String> {
    if !value.starts_with('"') {
        return Ok(value.into());
    }
    let Some(inner) = value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
    else {
        return Err(Error::new("gitParse", "Malformed quoted object alternate"));
    };
    let mut bytes = inner.bytes().peekable();
    let mut decoded = Vec::new();
    while let Some(byte) = bytes.next() {
        if byte != b'\\' {
            decoded.push(byte);
            continue;
        }
        let escaped = bytes
            .next()
            .ok_or_else(|| Error::new("gitParse", "Incomplete alternate path escape"))?;
        decoded.push(match escaped {
            b'"' | b'\\' => escaped,
            b'a' => 7,
            b'b' => 8,
            b't' => 9,
            b'n' => 10,
            b'v' => 11,
            b'f' => 12,
            b'r' => 13,
            b'0'..=b'7' => {
                let mut value = u16::from(escaped - b'0');
                for _ in 0..2 {
                    if let Some(b'0'..=b'7') = bytes.peek() {
                        value = value * 8 + u16::from(bytes.next().unwrap() - b'0');
                    } else {
                        break;
                    }
                }
                u8::try_from(value)
                    .map_err(|_| Error::new("gitParse", "Invalid alternate path escape"))?
            }
            _ => return Err(Error::new("gitParse", "Unknown alternate path escape")),
        });
    }
    process::text(decoded)
}

// Paths are resolved by Git, then tested on the machine that owns the objects.
fn any_file(location: &RepositoryLocation, paths: &[String]) -> Result<bool> {
    if matches!(location, RepositoryLocation::Native { .. }) {
        for path in paths {
            match std::fs::metadata(path) {
                Ok(metadata) if metadata.is_file() => return Ok(true),
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        return Ok(false);
    }
    let mut values = vec!["test".to_string()];
    for (index, path) in paths.iter().enumerate() {
        if index > 0 {
            values.push("-o".into());
        }
        values.extend(["-f".into(), path.clone()]);
    }
    let command = match location {
        RepositoryLocation::Ssh { .. } => process::ssh_exec(location, &[], &values)?,
        RepositoryLocation::Wsl { distribution, .. } => {
            if !cfg!(windows) {
                return Err(Error::new("unsupportedPlatform", "WSL requires Windows"));
            }
            let mut command = std::process::Command::new("wsl.exe");
            command.args(["--distribution", distribution, "--exec"]);
            command.args(values);
            command
        }
        RepositoryLocation::Native { .. } => unreachable!(),
    };
    let output = process::run_for(command, Duration::from_secs(30))?;
    match output.code {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(Error::new("io", crate::mutate::report(&output))),
    }
}

impl Repository {
    pub fn commit_graph_status(&self) -> Result<CommitGraphStatus> {
        if disabled(self)? {
            return Ok(CommitGraphStatus::Disabled);
        }
        let mut paths = Vec::new();
        for path in [
            "objects/info/commit-graph",
            "objects/info/commit-graphs/commit-graph-chain",
        ] {
            paths.push(string(
                &self.session.location,
                &["rev-parse", "--path-format=absolute", "--git-path", path],
            )?);
        }
        if any_file(&self.session.location, &paths)? {
            return Ok(CommitGraphStatus::Present);
        }
        paths.clear();
        // count-objects reports the effective alternates, including recursive ones.
        let objects = string(&self.session.location, &["count-objects", "-v"])?;
        for alternate in objects
            .lines()
            .filter_map(|line| line.strip_prefix("alternate: "))
        {
            let alternate = alternate_path(alternate)?;
            paths.push(format!("{alternate}/info/commit-graph"));
            paths.push(format!("{alternate}/info/commit-graphs/commit-graph-chain"));
        }
        if paths.is_empty() {
            return Ok(CommitGraphStatus::Missing);
        }
        Ok(if any_file(&self.session.location, &paths)? {
            CommitGraphStatus::Present
        } else {
            CommitGraphStatus::Missing
        })
    }

    fn write_commit_graph(&self, cancel: &Control) -> Result<()> {
        if disabled(self)? {
            return Err(Error::new("commitGraphDisabled", "History acceleration is disabled by core.commitGraph=false. Enable it in Git configuration before using Speed up history."));
        }
        if string(
            &self.session.location,
            &["rev-parse", "--is-shallow-repository"],
        )? == "true"
        {
            return Err(Error::new("unsupportedShallowCommitGraph", "Git cannot use commit-graphs in shallow repositories. Unshallow the repository outside Gitty before speeding up history."));
        }
        // Git's size-tiered split strategy reuses existing layers on repeated writes.
        let values = args(&[
            "commit-graph",
            "write",
            "--reachable",
            "--changed-paths",
            "--split",
        ]);
        let command = process::git_mutation_command(&self.session.location, &values)?;
        let output = process::logged(&values, &[], || run_write(command, cancel))?;
        if !output.success {
            return Err(Error::new("git", crate::mutate::report(&output)));
        }
        Ok(())
    }
}

impl Service {
    fn begin_commit_graph(&self, handle: &str) -> Result<(Arc<Repository>, Job<'_>)> {
        let mut jobs = lock(&self.commit_graph_jobs)?;
        let repo = self.repo(handle)?;
        if jobs.stopped {
            return Err(Error::new("cancelled", "Window is closing"));
        }
        let key = Self::repository_key(&repo);
        if jobs.running.contains_key(&key) {
            return Err(Error::new(
                "commitGraphBusy",
                "History acceleration is already running for this repository",
            ));
        }
        let cancel = Arc::new(Control::default());
        jobs.running
            .insert(key.clone(), (handle.into(), cancel.clone()));
        Ok((
            repo,
            Job {
                service: self,
                key,
                cancel,
            },
        ))
    }
    pub(crate) fn cancel_commit_graph(&self, handle: &str) {
        if let Ok(jobs) = self.commit_graph_jobs.lock() {
            for (owner, cancel) in jobs.running.values() {
                if owner == handle {
                    cancel.cancel();
                }
            }
        }
    }
    pub(crate) fn cancel_all_commit_graphs(&self) {
        if let Ok(mut jobs) = self.commit_graph_jobs.lock() {
            jobs.stopped = true;
            for (_, cancel) in jobs.running.values() {
                cancel.cancel();
            }
        }
    }
    pub fn write_commit_graph(&self, handle: &str) -> Result<()> {
        // Git's commit-graph lock protects external writers. Do not hold the app's
        // ref/index/worktree mutation lock while building object-store metadata.
        let (repo, job) = self.begin_commit_graph(handle)?;
        repo.write_commit_graph(&job.cancel)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{commit, git, init, open};

    #[test]
    #[cfg(unix)]
    fn cancellation_does_not_wait_for_escaped_pipe_holders() {
        if Command::new("python3").arg("--version").output().is_err() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let ready = dir.path().join("ready");
        let path = ready.clone();
        let control = Arc::new(Control::default());
        let worker_control = control.clone();
        let worker = thread::spawn(move || {
            let mut command = Command::new("sh");
            command.args(["-c", "python3 -c 'import os,sys,time; os.setsid(); open(sys.argv[1], \"w\").close(); time.sleep(3)' \"$1\" & wait", "gitty-test"]).arg(path);
            run_write(command, &worker_control)
        });
        let waiting = Instant::now();
        while !ready.exists() && waiting.elapsed() < Duration::from_secs(5) {
            thread::sleep(Duration::from_millis(10));
        }
        control.cancel();
        let start = Instant::now();
        let result = worker.join().unwrap();
        assert!(ready.exists());
        assert!(start.elapsed() < Duration::from_secs(2));
        assert_eq!(result.err().unwrap().code, "cancelled");
        assert!(control.child.lock().unwrap().is_none());
    }

    #[test]
    fn commit_graph_jobs_allow_mutations_and_worktree_opens_but_reject_duplicate_writes() {
        let directory = init();
        std::fs::write(directory.path().join("file"), "initial").unwrap();
        commit(directory.path(), "initial");
        let linked = tempfile::tempdir().unwrap();
        let path = linked.path().join("linked");
        git(
            directory.path(),
            &["worktree", "add", "-b", "linked", path.to_str().unwrap()],
        );
        let data = tempfile::tempdir().unwrap();
        let mut service = Service::new(data.path().into());
        let main = open(&mut service, directory.path());
        let (_, job) = service.begin_commit_graph(&main.session.handle).unwrap();
        // Opening a worktree and ordinary mutations still take their normal lock.
        let other = service
            .open(RepositoryLocation::Native {
                path: path.to_str().unwrap().into(),
            })
            .unwrap();
        service.mutate(&main.session.handle, |_| Ok(())).unwrap();
        assert_eq!(
            service
                .write_commit_graph(&other.session.handle)
                .unwrap_err()
                .code,
            "commitGraphBusy"
        );
        service.close(&other.session.handle).unwrap();
        assert!(!job.cancel.cancelled.load(Ordering::Acquire));
        service.close(&main.session.handle).unwrap();
        assert!(job.cancel.cancelled.load(Ordering::Acquire));
        drop(job);
        assert!(service.commit_graph_jobs.lock().unwrap().running.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn commit_graph_session_and_window_close_cancel_and_reap_running_processes() {
        for window_close in [false, true] {
            let directory = init();
            let data = tempfile::tempdir().unwrap();
            let mut service = Service::new(data.path().into());
            let state = open(&mut service, directory.path());
            let (_, job) = service.begin_commit_graph(&state.session.handle).unwrap();
            let ready = directory.path().join("ready");
            thread::scope(|scope| {
                let ready_path = &ready;
                let cancel = &job.cancel;
                let worker = scope.spawn(move || {
                    let mut command = Command::new("sh");
                    command.args([
                        "-c",
                        "echo $$ > \"$1\"; sleep 30 & wait",
                        "test",
                        ready_path.to_str().unwrap(),
                    ]);
                    run_write(command, cancel)
                });
                let deadline = Instant::now() + Duration::from_secs(5);
                while !ready.exists() {
                    assert!(Instant::now() < deadline, "test child did not start");
                    thread::sleep(Duration::from_millis(10));
                }
                let pid: i32 = std::fs::read_to_string(&ready)
                    .unwrap()
                    .trim()
                    .parse()
                    .unwrap();
                if window_close {
                    service.cancel_all_commit_graphs();
                } else {
                    service.close(&state.session.handle).unwrap();
                }
                assert_eq!(
                    worker
                        .join()
                        .unwrap()
                        .err()
                        .expect("write must cancel")
                        .code,
                    "cancelled"
                );
                assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "child was reaped");
            });
            drop(job);
            if window_close {
                assert_eq!(
                    service
                        .write_commit_graph(&state.session.handle)
                        .unwrap_err()
                        .code,
                    "cancelled"
                );
            }
        }
    }

    #[test]
    fn commit_graph_alternate_paths_decode_git_c_quoting() {
        assert_eq!(
            alternate_path(r#""/objects/space\t\303\251\\\"store""#).unwrap(),
            "/objects/space\té\\\"store"
        );
        assert_eq!(alternate_path("/plain objects").unwrap(), "/plain objects");
        assert!(alternate_path(r#""bad\q""#).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn commit_graph_quoted_alternate_and_shallow_refusal() {
        let directory = init();
        std::fs::write(directory.path().join("file"), "initial").unwrap();
        commit(directory.path(), "initial");
        let destination = tempfile::tempdir().unwrap();
        let source = destination.path().join("source\t例.git");
        git(
            directory.path(),
            &[
                "clone",
                "--bare",
                directory.path().to_str().unwrap(),
                source.to_str().unwrap(),
            ],
        );
        git(&source, &["commit-graph", "write", "--reachable"]);
        let shared = destination.path().join("shared");
        git(
            directory.path(),
            &[
                "clone",
                "--shared",
                source.to_str().unwrap(),
                shared.to_str().unwrap(),
            ],
        );
        let shallow = destination.path().join("shallow");
        git(
            directory.path(),
            &[
                "clone",
                "--depth=1",
                &format!("file://{}", directory.path().display()),
                shallow.to_str().unwrap(),
            ],
        );
        let data = tempfile::tempdir().unwrap();
        let mut service = Service::new(data.path().into());
        let state = open(&mut service, &shared);
        assert_eq!(
            service
                .repo(&state.session.handle)
                .unwrap()
                .commit_graph_status()
                .unwrap(),
            CommitGraphStatus::Present
        );
        let state = open(&mut service, &shallow);
        assert_eq!(
            service
                .write_commit_graph(&state.session.handle)
                .unwrap_err()
                .code,
            "unsupportedShallowCommitGraph"
        );
        assert!(!shallow.join(".git/objects/info/commit-graphs").exists());
    }

    #[test]
    fn commit_graph_missing_write_present_preserves_refs_index_and_worktree() {
        let directory = init();
        let path = directory.path();
        std::fs::write(path.join("file"), "initial\n").unwrap();
        commit(path, "initial");
        std::fs::write(path.join("file"), "staged\n").unwrap();
        git(path, &["add", "file"]);
        std::fs::write(path.join("file"), "unstaged\n").unwrap();
        std::fs::write(path.join("untracked"), "keep\n").unwrap();
        let refs = git(path, &["show-ref", "--head"]);
        let index = std::fs::read(path.join(".git/index")).unwrap();
        let data = tempfile::tempdir().unwrap();
        let mut service = Service::new(data.path().into());
        let state = open(&mut service, path);
        let handle = &state.session.handle;
        let repository = service.repo(handle).unwrap();
        assert_eq!(
            repository.commit_graph_status().unwrap(),
            CommitGraphStatus::Missing
        );
        service.write_commit_graph(handle).unwrap();
        assert_eq!(
            repository.commit_graph_status().unwrap(),
            CommitGraphStatus::Present
        );
        service.write_commit_graph(handle).unwrap();
        assert_eq!(git(path, &["show-ref", "--head"]), refs);
        assert_eq!(std::fs::read(path.join(".git/index")).unwrap(), index);
        assert_eq!(
            std::fs::read_to_string(path.join("file")).unwrap(),
            "unstaged\n"
        );
        assert_eq!(
            std::fs::read_to_string(path.join("untracked")).unwrap(),
            "keep\n"
        );
        git(path, &["commit-graph", "verify"]);
        let chain = path.join(".git/objects/info/commit-graphs/commit-graph-chain");
        let hash = std::fs::read_to_string(chain).unwrap();
        let graph = std::fs::read(path.join(format!(
            ".git/objects/info/commit-graphs/graph-{}.graph",
            hash.lines().last().unwrap()
        )))
        .unwrap();
        assert!(
            graph.windows(4).any(|chunk| chunk == b"BIDX"),
            "changed-path Bloom index is present"
        );
    }

    #[test]
    fn commit_graph_disabled_refuses_even_when_a_graph_exists() {
        let directory = init();
        std::fs::write(directory.path().join("file"), "initial").unwrap();
        commit(directory.path(), "initial");
        git(directory.path(), &["commit-graph", "write", "--reachable"]);
        git(directory.path(), &["config", "core.commitGraph", "false"]);
        let graph = std::fs::read(directory.path().join(".git/objects/info/commit-graph")).unwrap();
        let data = tempfile::tempdir().unwrap();
        let mut service = Service::new(data.path().into());
        let state = open(&mut service, directory.path());
        assert_eq!(
            service
                .repo(&state.session.handle)
                .unwrap()
                .commit_graph_status()
                .unwrap(),
            CommitGraphStatus::Disabled
        );
        assert_eq!(
            service
                .write_commit_graph(&state.session.handle)
                .unwrap_err()
                .code,
            "commitGraphDisabled"
        );
        assert_eq!(
            std::fs::read(directory.path().join(".git/objects/info/commit-graph")).unwrap(),
            graph
        );
    }

    #[test]
    fn commit_graph_linked_worktree_uses_common_objects() {
        let directory = init();
        std::fs::write(directory.path().join("file"), "initial").unwrap();
        commit(directory.path(), "initial");
        let linked = tempfile::tempdir().unwrap();
        let path = linked.path().join("linked space");
        git(
            directory.path(),
            &["worktree", "add", "-b", "linked", path.to_str().unwrap()],
        );
        let data = tempfile::tempdir().unwrap();
        let mut service = Service::new(data.path().into());
        let main = open(&mut service, directory.path());
        let worktree = open(&mut service, &path);
        assert_eq!(
            service
                .repo(&worktree.session.handle)
                .unwrap()
                .commit_graph_status()
                .unwrap(),
            CommitGraphStatus::Missing
        );
        service
            .write_commit_graph(&worktree.session.handle)
            .unwrap();
        for handle in [&main.session.handle, &worktree.session.handle] {
            assert_eq!(
                service.repo(handle).unwrap().commit_graph_status().unwrap(),
                CommitGraphStatus::Present
            );
        }
        assert!(directory
            .path()
            .join(".git/objects/info/commit-graphs/commit-graph-chain")
            .is_file());
    }

    #[test]
    fn commit_graph_alternate_and_bare_repositories_are_supported() {
        let directory = init();
        std::fs::write(directory.path().join("file"), "initial").unwrap();
        commit(directory.path(), "initial");
        git(directory.path(), &["commit-graph", "write", "--reachable"]);
        let destination = tempfile::tempdir().unwrap();
        let shared = destination.path().join("shared.git");
        git(
            directory.path(),
            &[
                "clone",
                "--bare",
                "--shared",
                directory.path().to_str().unwrap(),
                shared.to_str().unwrap(),
            ],
        );
        let data = tempfile::tempdir().unwrap();
        let mut service = Service::new(data.path().into());
        let state = open(&mut service, &shared);
        assert!(state.session.bare);
        assert_eq!(
            service
                .repo(&state.session.handle)
                .unwrap()
                .commit_graph_status()
                .unwrap(),
            CommitGraphStatus::Present
        );
        service.write_commit_graph(&state.session.handle).unwrap();
        git(&shared, &["commit-graph", "verify"]);
    }
}
