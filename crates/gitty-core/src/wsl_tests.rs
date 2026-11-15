//! Real WSL integration tests. They run only on Windows when
//! `GITTY_WSL_TEST_DISTRO` names an installed distribution with Git, e.g.
//! `$env:GITTY_WSL_TEST_DISTRO="Ubuntu"; cargo test wsl_tests`. Without it,
//! every test returns immediately so ordinary runs stay hermetic.
use crate::{
    dto::{RepositoryLocation, Result},
    operation_dto::{GitAction, OperationRequest},
    remote_dto::{ActionOutput, RemoteAction},
    repository::{Repository, Service},
};
use serde_json::{json, Value};
use std::{process::Command, sync::Arc, time::Instant};

fn distro() -> Option<String> {
    std::env::var("GITTY_WSL_TEST_DISTRO")
        .ok()
        .filter(|s| !s.is_empty())
}

/// Runs a program inside the distribution with explicit arguments (no shell).
fn wsl(distro: &str, program: &[&str]) -> String {
    let output = Command::new("wsl.exe")
        .args(["--distribution", distro, "--exec", "env"])
        .args(["GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null"])
        .args(program)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{program:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim_end().into()
}

struct Tree {
    distro: String,
    root: String,
}
impl Tree {
    fn new(distro: &str) -> Self {
        let root = wsl(distro, &["mktemp", "-d", "/tmp/gitty-wsl-test.XXXXXX"]);
        assert!(root.starts_with("/tmp/gitty-wsl-test."));
        Self {
            distro: distro.into(),
            root,
        }
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        let _ = Command::new("wsl.exe")
            .args(["--distribution", &self.distro, "--exec", "rm", "-rf", "--"])
            .arg(&self.root)
            .status();
    }
}

struct Fixture {
    distro: String,
    path: String,
    _data: tempfile::TempDir,
    service: Service,
    repo: Arc<Repository>,
    handle: String,
}
impl Fixture {
    /// A repository at `<tree>/<name>` with one commit, opened through WSL.
    fn new(tree: &Tree, name: &str) -> Self {
        let path = format!("{}/{name}", tree.root);
        let d = tree.distro.as_str();
        wsl(d, &["git", "init", "-q", "-b", "main", &path]);
        for (k, v) in [
            ("user.name", "Test"),
            ("user.email", "test@example.com"),
            ("commit.gpgSign", "false"),
            ("core.hooksPath", ".git/no-hooks"),
        ] {
            wsl(d, &["git", "-C", &path, "config", k, v]);
        }
        let f = Self::open(d, &path);
        f.write("file", "base\n");
        f.commit("base");
        f
    }
    fn open(distro: &str, path: &str) -> Self {
        let data = tempfile::tempdir().unwrap();
        let service = Service::new(data.path().into());
        let state = service
            .open(RepositoryLocation::Wsl {
                distribution: distro.into(),
                path: path.into(),
            })
            .unwrap();
        let handle = state.session.handle;
        let repo = service.repo(&handle).unwrap();
        Self {
            distro: distro.into(),
            path: path.into(),
            _data: data,
            service,
            repo,
            handle,
        }
    }
    fn git(&self, a: &[&str]) -> String {
        let mut program = vec!["git", "-C", &self.path];
        program.extend_from_slice(a);
        wsl(&self.distro, &program)
    }
    fn write(&self, name: &str, text: &str) {
        let file = format!("{}/{name}", self.path);
        wsl(
            &self.distro,
            &["sh", "-c", "printf '%s' \"$2\" > \"$1\"", "sh", &file, text],
        );
    }
    fn commit(&self, message: &str) -> String {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", message]);
        self.git(&["rev-parse", "HEAD"])
    }
    fn remote(&self, action: Value) -> Result<ActionOutput> {
        self.service.remote_action(
            &self.handle,
            serde_json::from_value::<RemoteAction>(action).unwrap(),
            None,
        )
    }
    fn tracking(&self) -> String {
        self.git(&["rev-parse", "refs/remotes/origin/main"])
    }
}

#[test]
fn wsl_open_state_status_and_commit() {
    let Some(d) = distro() else { return };
    let tree = Tree::new(&d);
    let f = Fixture::new(&tree, "repo with spaces 工作\nnext");
    let state = f.repo.state().unwrap();
    assert_eq!(state.session.root, f.path);
    assert_eq!(state.session.head_ref.as_deref(), Some("refs/heads/main"));
    assert!(matches!(
        state.session.location,
        RepositoryLocation::Wsl { ref distribution, .. } if *distribution == d
    ));

    f.write("file", "changed\n");
    f.write("new file.txt", "one\n");
    let status = f.repo.status().unwrap();
    let mut paths: Vec<_> = status.entries.iter().map(|e| e.path.as_str()).collect();
    paths.sort();
    assert_eq!(paths, ["file", "new file.txt"]);

    // Editing untracked content without changing status letters must still
    // change the refresh fingerprint.
    let before = status.fingerprint;
    f.write("new file.txt", "two\n");
    assert_ne!(f.repo.status().unwrap().fingerprint, before);

    f.service
        .stage(&f.handle, &["file".into(), "new file.txt".into()])
        .unwrap();
    let oid = f
        .service
        .create_commit(&f.handle, "from gitty")
        .unwrap()
        .oid;
    assert_eq!(f.git(&["rev-parse", "HEAD"]), oid);
    assert!(f.repo.status().unwrap().entries.is_empty());
}

#[test]
fn wsl_background_fetch_pull_and_push() {
    let Some(d) = distro() else { return };
    let tree = Tree::new(&d);
    let bare = format!("{}/remote.git", tree.root);
    wsl(&d, &["git", "init", "-q", "--bare", "-b", "main", &bare]);
    let f = Fixture::new(&tree, "local");
    f.git(&["remote", "add", "origin", &bare]);
    f.remote(json!({"kind":"push", "setUpstream":true}))
        .unwrap();

    let peer = Fixture::new(&tree, "peer");
    peer.git(&["remote", "add", "origin", &bare]);
    peer.git(&["fetch", "-q", "origin"]);
    peer.git(&["reset", "-q", "--hard", "origin/main"]);
    peer.git(&["branch", "-q", "--set-upstream-to=origin/main"]);
    peer.write("peer", "from peer\n");
    let upstream = peer.commit("peer change");
    peer.remote(json!({"kind":"push"})).unwrap();

    let head = f.git(&["rev-parse", "HEAD"]);
    let start = Instant::now();
    let (result, spawns) =
        crate::process::count_spawns(|| f.remote(json!({"kind":"backgroundFetch"})));
    result.unwrap();
    eprintln!(
        "WSL background fetch: {:?}, {spawns} processes",
        start.elapsed()
    );
    assert!(spawns <= 9, "fetch launched {spawns} processes");
    assert_eq!(f.tracking(), upstream);
    // Background fetch never integrates.
    assert_eq!(f.git(&["rev-parse", "HEAD"]), head);
    assert_eq!(f.repo.sync_info().unwrap().behind, Some(1));

    f.remote(json!({"kind":"pull"})).unwrap();
    assert_eq!(f.git(&["rev-parse", "HEAD"]), upstream);

    f.write("local", "from local\n");
    let local = f.commit("local change");
    f.remote(json!({"kind":"push"})).unwrap();
    assert_eq!(
        wsl(&d, &["git", "-C", &bare, "rev-parse", "refs/heads/main"]),
        local
    );
}

#[test]
fn wsl_reset_origin_rechecks_review_and_preserves_untracked_work() {
    let Some(d) = distro() else { return };
    let tree = Tree::new(&d);
    let f = Fixture::new(&tree, "reset");
    let origin = f.git(&["rev-parse", "HEAD"]);
    f.git(&["update-ref", "refs/remotes/origin/main", &origin]);
    f.write("file", "local commit\n");
    f.commit("local");
    f.write("file", "staged\n");
    f.git(&["add", "file"]);
    f.write("file", "unstaged\n");
    f.write("untracked", "keep\n");
    let snapshot = f.repo.snapshot().unwrap();
    let request = || OperationRequest {
        action: GitAction::ResetToOrigin {
            branch: "refs/remotes/origin/main".into(),
            expected_origin_oid: origin.clone(),
        },
        expected_head: snapshot.state.session.head.clone(),
        expected_head_ref: snapshot.state.session.head_ref.clone(),
        expected_operation: snapshot.operation.fingerprint.clone(),
    };
    f.write("file", "changed after review\n");
    assert_eq!(
        f.service
            .run_operation(&f.handle, request(), None)
            .unwrap_err()
            .code,
        "staleOperation"
    );
    assert_ne!(f.git(&["rev-parse", "HEAD"]), origin);
    f.write("file", "unstaged\n");
    let start = Instant::now();
    let (result, spawns) =
        crate::process::count_spawns(|| f.service.run_operation(&f.handle, request(), None));
    let result = result.unwrap();
    eprintln!("WSL reset: {:?}, {spawns} processes", start.elapsed());
    assert_eq!(result.head.as_deref(), Some(origin.as_str()));
    assert_eq!(f.git(&["show", ":file"]), "base");
    assert_eq!(wsl(&d, &["cat", &format!("{}/file", f.path)]), "base");
    assert_eq!(wsl(&d, &["cat", &format!("{}/untracked", f.path)]), "keep");
}

#[test]
fn wsl_writes_detect_index_lock() {
    let Some(d) = distro() else { return };
    let tree = Tree::new(&d);
    let f = Fixture::new(&tree, "locked");
    f.write("file", "changed\n");
    f.write(".git/index.lock", "");
    assert_eq!(
        f.service
            .stage(&f.handle, &["file".into()])
            .unwrap_err()
            .code,
        "indexLocked"
    );
}

/// Reports how long one refresh (state + status) takes; not an assertion on
/// machine speed, but it makes regressions visible with `--nocapture`.
#[test]
fn wsl_refresh_timing() {
    let Some(d) = distro() else { return };
    let tree = Tree::new(&d);
    let f = Fixture::new(&tree, "timing");
    let start = Instant::now();
    let (opened, spawns) = crate::process::count_spawns(|| {
        f.service.open(RepositoryLocation::Wsl {
            distribution: d.clone(),
            path: f.path.clone(),
        })
    });
    let opened = opened.unwrap();
    eprintln!("WSL open: {:?}, {spawns} processes", start.elapsed());
    assert!(spawns <= 8, "open launched {spawns} processes");
    f.service.close(&opened.session.handle).unwrap();
    for i in 0..20 {
        f.write(&format!("untracked-{i}"), "x\n");
    }
    f.write("file", "changed\n");
    let start = Instant::now();
    f.repo.state().unwrap();
    let state = start.elapsed();
    let start = Instant::now();
    f.repo.status().unwrap();
    let status = start.elapsed();
    eprintln!("WSL refresh: state {state:?}, status {status:?} (20 untracked files)");
    let start = Instant::now();
    let (_, spawns) = crate::process::count_spawns(|| f.repo.snapshot().unwrap());
    eprintln!("WSL snapshot: {:?}, {spawns} processes", start.elapsed());
}

/// Operation metadata is one `find` for a clean repository (it used to be a
/// `test -e` launch for each of 29 paths), plus one `cat` per file that exists.
#[test]
fn wsl_operation_metadata_uses_one_existence_scan() {
    let Some(d) = distro() else { return };
    let tree = Tree::new(&d);
    let f = Fixture::new(&tree, "metadata");
    let (clean, spawns) = crate::process::count_spawns(|| f.repo.operation_metadata().unwrap());
    assert_eq!(spawns, 1);
    assert!(clean.iter().all(|(_, value)| value.is_none()));
    f.write(".git/MERGE_MSG", "merging\n");
    let (present, spawns) = crate::process::count_spawns(|| f.repo.operation_metadata().unwrap());
    assert_eq!(spawns, 2);
    let merge_msg = present.iter().find(|(name, _)| *name == "MERGE_MSG");
    assert_eq!(merge_msg.unwrap().1.as_deref(), Some(&b"merging\n"[..]));
    assert_eq!(present.iter().filter(|(_, v)| v.is_some()).count(), 1);
    // A whole snapshot stays small: two state reads, status, entries, scan, refs.
    let (_, spawns) = crate::process::count_spawns(|| f.repo.snapshot().unwrap());
    assert!(spawns <= 20, "snapshot launched {spawns} processes");
}
