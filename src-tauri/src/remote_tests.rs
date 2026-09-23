use crate::{
    dto::{HistoryQuery, RepositoryLocation, Result},
    operation_dto::OperationKind,
    remote_dto::{ActionOutput, RemoteAction, StashAction},
    repository::{Repository, Service},
};
use serde_json::{json, Value};
use std::{path::Path, process::Command, sync::Arc};

fn git(path: &Path, a: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(a)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{a:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim_end().into()
}

struct Fixture {
    dir: tempfile::TempDir,
    _data: tempfile::TempDir,
    service: Service,
    repo: Arc<Repository>,
    handle: String,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-b", "main"]);
        for (k, v) in [
            ("user.name", "Test"),
            ("user.email", "test@example.com"),
            ("commit.gpgSign", "false"),
            ("core.autocrlf", "false"),
            ("core.hooksPath", ".git/no-hooks"),
        ] {
            git(dir.path(), &["config", k, v]);
        }
        std::fs::write(dir.path().join("file"), "base\n").unwrap();
        git(dir.path(), &["add", "."]);
        git(dir.path(), &["commit", "-m", "base"]);
        let data = tempfile::tempdir().unwrap();
        let service = Service::new(data.path().into());
        let handle = service
            .open(RepositoryLocation::Native {
                path: dir.path().to_str().unwrap().into(),
            })
            .unwrap()
            .session
            .handle;
        let repo = service.repo(&handle).unwrap();
        Self {
            dir,
            _data: data,
            service,
            repo,
            handle,
        }
    }
    fn git(&self, a: &[&str]) -> String {
        git(self.dir.path(), a)
    }
    fn write(&self, name: &str, text: &str) {
        std::fs::write(self.dir.path().join(name), text).unwrap();
    }
    fn commit(&self, message: &str) -> String {
        self.git(&["add", "."]);
        self.git(&["commit", "-m", message]);
        self.git(&["rev-parse", "HEAD"])
    }
    fn remote(&self, action: Value) -> Result<ActionOutput> {
        self.service
            .remote_action(&self.handle, serde_json::from_value(action).unwrap(), None)
    }
    fn stash(&self, action: Value) -> Result<ActionOutput> {
        self.service
            .stash_action(&self.handle, serde_json::from_value(action).unwrap())
    }
    fn save(&self, message: &str) -> String {
        self.stash(json!({"kind":"save", "message":message}))
            .unwrap();
        self.repo.stashes().unwrap()[0].oid.clone()
    }
    fn bare_remote(&self) -> tempfile::TempDir {
        let bare = tempfile::tempdir().unwrap();
        git(bare.path(), &["init", "--bare", "-b", "main"]);
        self.git(&["remote", "add", "origin", bare.path().to_str().unwrap()]);
        bare
    }
    fn publish(&self) {
        self.remote(json!({"kind":"push", "setUpstream":true}))
            .unwrap();
    }
    fn peer(&self, bare: &Path) -> Self {
        let peer = Self::new();
        peer.git(&["remote", "add", "origin", bare.to_str().unwrap()]);
        peer.git(&["fetch", "origin"]);
        peer.git(&["reset", "--hard", "origin/main"]);
        peer.git(&["branch", "--set-upstream-to=origin/main"]);
        peer
    }
}

#[test]
fn remote_ipc_shape_and_missing_upstream() {
    let f = Fixture::new();
    assert_eq!(
        serde_json::to_value(f.repo.sync_info().unwrap()).unwrap(),
        json!({
            "branch":"main", "upstream":null, "ahead":null, "behind":null, "remotes":[]
        })
    );
    assert_eq!(
        f.remote(json!({"kind":"fetch"})).unwrap_err().code,
        "noRemote"
    );
    let _bare = f.bare_remote();
    assert_eq!(
        f.remote(json!({"kind":"push"})).unwrap_err().code,
        "noUpstream"
    );
    assert_eq!(
        f.remote(json!({"kind":"pull"})).unwrap_err().code,
        "noUpstream"
    );
    f.publish();
    let info = f.repo.sync_info().unwrap();
    assert_eq!(info.upstream.as_deref(), Some("origin/main"));
    assert_eq!((info.ahead, info.behind), (Some(0), Some(0)));
    f.git(&["update-ref", "-d", "refs/remotes/origin/main"]);
    let info = f.repo.sync_info().unwrap();
    assert_eq!(info.upstream.as_deref(), Some("origin/main"));
    assert_eq!((info.ahead, info.behind), (None, None));
    f.git(&["checkout", "--detach"]);
    assert!(f.repo.sync_info().unwrap().branch.is_none());
    assert_eq!(
        f.remote(json!({"kind":"push", "setUpstream":true}))
            .unwrap_err()
            .code,
        "detachedHead"
    );
    assert!(serde_json::from_value::<RemoteAction>(json!({"kind":"push","force":true})).is_err());
    assert!(
        serde_json::from_value::<StashAction>(json!({"kind":"pop","selector":"stash@{0}"}))
            .is_err()
    );
}

#[test]
fn remote_fetch_counts_fast_forward_pull_and_push() {
    let f = Fixture::new();
    let bare = f.bare_remote();
    f.publish();
    let peer = f.peer(bare.path());
    peer.write("incoming", "from peer");
    let incoming = peer.commit("incoming");
    peer.remote(json!({"kind":"push"})).unwrap();
    // Reading metadata must not fetch even when the remote moved.
    assert_eq!(f.repo.sync_info().unwrap().behind, Some(0));
    f.remote(json!({"kind":"fetch"})).unwrap();
    assert_eq!(f.repo.sync_info().unwrap().behind, Some(1));
    f.remote(json!({"kind":"pull"})).unwrap();
    assert_eq!(f.git(&["rev-parse", "HEAD"]), incoming);
    f.write("outgoing", "from local");
    let outgoing = f.commit("outgoing");
    assert_eq!(f.repo.sync_info().unwrap().ahead, Some(1));
    f.remote(json!({"kind":"push"})).unwrap();
    assert_eq!(git(bare.path(), &["rev-parse", "main"]), outgoing);
    assert_eq!(f.repo.sync_info().unwrap().ahead, Some(0));
}

#[test]
fn background_fetch_updates_remote_history_without_local_refs_tags_or_worktree() {
    let f = Fixture::new();
    let bare = f.bare_remote();
    f.publish();
    let peer = f.peer(bare.path());
    peer.write("incoming", "new remote commit\n");
    let incoming = peer.commit("incoming");
    peer.remote(json!({"kind":"push"})).unwrap();
    peer.git(&["tag", "remote-only-tag"]);
    peer.git(&["push", "origin", "refs/tags/remote-only-tag"]);

    f.write("file", "staged\n");
    f.git(&["add", "file"]);
    f.write("file", "unstaged\n");
    let original_head = f.git(&["rev-parse", "HEAD"]);
    let original_index = f.git(&["ls-files", "--stage"]);
    let original_status = f.git(&["status", "--porcelain"]);
    let original_contents = std::fs::read(f.dir.path().join("file")).unwrap();

    f.remote(json!({"kind":"backgroundFetch"})).unwrap();
    assert_eq!(f.git(&["rev-parse", "HEAD"]), original_head);
    assert_eq!(f.git(&["rev-parse", "refs/heads/main"]), original_head);
    assert_eq!(f.git(&["rev-parse", "refs/remotes/origin/main"]), incoming);
    assert_eq!(f.repo.sync_info().unwrap().behind, Some(1));
    assert_eq!(f.git(&["ls-files", "--stage"]), original_index);
    assert_eq!(f.git(&["status", "--porcelain"]), original_status);
    assert_eq!(
        std::fs::read(f.dir.path().join("file")).unwrap(),
        original_contents
    );
    assert!(f.git(&["tag", "--list", "remote-only-tag"]).is_empty());
    assert!(f
        .repo
        .history(None, 20, HistoryQuery::default())
        .unwrap()
        .commits
        .iter()
        .any(|commit| commit.id == incoming));
}

#[test]
fn remote_divergence_is_refused_by_default_even_with_pull_configuration() {
    let f = Fixture::new();
    let bare = f.bare_remote();
    f.publish();
    let peer = f.peer(bare.path());
    peer.write("peer", "incoming");
    let incoming = peer.commit("incoming");
    peer.remote(json!({"kind":"push"})).unwrap();
    f.write("local", "outgoing");
    let local = f.commit("local");
    f.git(&["config", "pull.rebase", "true"]);
    f.git(&["config", "pull.ff", "false"]);
    assert_eq!(f.remote(json!({"kind":"pull"})).unwrap_err().code, "git");
    assert_eq!(f.git(&["rev-parse", "HEAD"]), local);
    let info = f.repo.sync_info().unwrap();
    assert_eq!((info.ahead, info.behind), (Some(1), Some(1)));
    assert_eq!(f.remote(json!({"kind":"push"})).unwrap_err().code, "git");
    assert_eq!(git(bare.path(), &["rev-parse", "main"]), incoming);
    f.remote(json!({"kind":"pull","pullMode":"merge"})).unwrap();
    assert_eq!(
        f.git(&["rev-list", "--parents", "-1", "HEAD"])
            .split_whitespace()
            .count(),
        3
    );
    f.remote(json!({"kind":"push"})).unwrap();
}

#[test]
fn remote_rebase_is_opt_in_and_conflicts_are_observable() {
    for conflict in [false, true] {
        let f = Fixture::new();
        let bare = f.bare_remote();
        f.publish();
        let peer = f.peer(bare.path());
        peer.write("file", "incoming\n");
        let incoming = peer.commit("incoming");
        peer.remote(json!({"kind":"push"})).unwrap();
        f.write(if conflict { "file" } else { "local" }, "local\n");
        f.commit("local");
        let outcome = f.remote(json!({"kind":"pull","pullMode":"rebase"}));
        if conflict {
            assert!(outcome.is_err());
            let operation = f.repo.operation_state().unwrap();
            assert_eq!(operation.kind, OperationKind::Rebase);
            assert_eq!(operation.conflicts, ["file"]);
        } else {
            outcome.unwrap();
            assert_eq!(f.git(&["rev-parse", "HEAD^"]), incoming);
            assert_eq!(f.repo.sync_info().unwrap().ahead, Some(1));
        }
    }
}

#[test]
fn remote_publication_is_single_branch_and_never_mirror_or_configured_force() {
    let f = Fixture::new();
    let bare = f.bare_remote();
    f.git(&["branch", "unrelated"]);
    f.git(&["tag", "unrelated-tag"]);
    f.git(&["config", "push.default", "matching"]);
    f.git(&["config", "push.followTags", "true"]);
    f.git(&["config", "remote.origin.push", "+refs/heads/*:refs/heads/*"]);
    f.remote(json!({"kind":"push","branch":"published","setUpstream":true}))
        .unwrap();
    assert_eq!(
        git(bare.path(), &["for-each-ref", "--format=%(refname)"]),
        "refs/heads/published"
    );
    assert_eq!(
        f.git(&["config", "branch.main.merge"]),
        "refs/heads/published"
    );
    f.git(&["config", "remote.origin.mirror", "true"]);
    assert_eq!(
        f.remote(json!({"kind":"push"})).unwrap_err().code,
        "mirrorRemote"
    );
    f.git(&["config", "remote.origin.mirror", "false"]);
    f.git(&[
        "config",
        "--add",
        "remote.origin.pushurl",
        bare.path().to_str().unwrap(),
    ]);
    f.git(&[
        "config",
        "--add",
        "remote.origin.pushurl",
        "/another-destination",
    ]);
    assert_eq!(
        f.remote(json!({"kind":"push"})).unwrap_err().code,
        "multiplePushUrls"
    );
}

#[test]
fn remote_inputs_dirty_worktrees_and_in_progress_are_guarded() {
    let f = Fixture::new();
    let _bare = f.bare_remote();
    f.publish();
    for branch in ["--all", "+main", "main:other", "main~1", "x\ny", "", "../x"] {
        assert_eq!(
            f.remote(json!({"kind":"fetch","branch":branch}))
                .unwrap_err()
                .code,
            "invalidBranch"
        );
    }
    for remote in [
        "--all",
        "/tmp/repo",
        "https://example.test/repo",
        "missing",
        "",
    ] {
        assert_eq!(
            f.remote(json!({"kind":"fetch","remote":remote}))
                .unwrap_err()
                .code,
            "invalidRemote"
        );
    }
    f.write("file", "dirty\n");
    assert_eq!(
        f.remote(json!({"kind":"pull"})).unwrap_err().code,
        "dirtyWorktree"
    );
    f.remote(json!({"kind":"fetch"})).unwrap();
    f.remote(json!({"kind":"push"})).unwrap();
    std::fs::write(
        f.dir.path().join(".git/MERGE_HEAD"),
        f.git(&["rev-parse", "HEAD"]),
    )
    .unwrap();
    assert_eq!(
        f.remote(json!({"kind":"fetch"})).unwrap_err().code,
        "operationInProgress"
    );
    assert_eq!(
        f.stash(json!({"kind":"save"})).unwrap_err().code,
        "operationInProgress"
    );
}

#[test]
fn fetch_ignores_mirror_refspecs_and_pull_preserves_ignored_files() {
    let f = Fixture::new();
    let bare = f.bare_remote();
    f.publish();
    let peer = f.peer(bare.path());
    peer.write("precious", "incoming");
    peer.commit("incoming");
    peer.remote(json!({"kind":"push"})).unwrap();
    let before = f.git(&["rev-parse", "HEAD"]);
    f.git(&["config", "remote.origin.fetch", "+refs/*:refs/*"]);
    f.remote(json!({"kind":"fetch"})).unwrap();
    assert_eq!(f.git(&["rev-parse", "HEAD"]), before);
    std::fs::write(f.dir.path().join(".git/info/exclude"), "precious\n").unwrap();
    f.write("precious", "preserve me");
    for mode in ["ffOnly", "merge", "rebase"] {
        assert!(f.remote(json!({"kind":"pull","pullMode":mode})).is_err());
        assert_eq!(
            std::fs::read_to_string(f.dir.path().join("precious")).unwrap(),
            "preserve me"
        );
        assert_eq!(f.git(&["rev-parse", "HEAD"]), before);
    }
}

#[test]
fn stash_save_apply_pop_drop_and_untracked() {
    let f = Fixture::new();
    assert!(f.repo.stashes().unwrap().is_empty());
    f.write("file", "saved\n");
    f.write("untracked", "keep\n");
    let oid = f.save("message with spaces 工作");
    assert!(f.dir.path().join("untracked").exists());
    let list = f.repo.stashes().unwrap();
    assert_eq!(list[0].selector, "stash@{0}");
    assert!(list[0].message.contains("message with spaces 工作"));
    let saved = f
        .stash(json!({"kind":"save","includeUntracked":true}))
        .unwrap();
    let untracked = f.repo.stashes().unwrap()[0].oid.clone();
    assert!(!f.dir.path().join("untracked").exists(), "{}", saved.output);
    f.stash(json!({"kind":"apply","oid":oid})).unwrap();
    assert_eq!(
        std::fs::read_to_string(f.dir.path().join("file")).unwrap(),
        "saved\n"
    );
    assert_eq!(f.repo.stashes().unwrap().len(), 2);
    f.commit("applied");
    f.stash(json!({"kind":"pop","oid":untracked})).unwrap();
    assert!(f.dir.path().join("untracked").exists());
    assert_eq!(f.repo.stashes().unwrap().len(), 1);
    // Dropping a stash does not require a clean worktree.
    f.stash(json!({"kind":"drop","oid":oid})).unwrap();
    assert!(f.repo.stashes().unwrap().is_empty());
}

#[test]
fn stash_pop_conflict_retains_entry_and_uses_existing_conflict_state() {
    let f = Fixture::new();
    f.write("file", "stashed\n");
    let oid = f.save("conflicting");
    f.write("file", "committed\n");
    f.commit("conflicting base");
    assert_eq!(
        f.stash(json!({"kind":"pop","oid":oid})).unwrap_err().code,
        "git"
    );
    assert_eq!(f.repo.stashes().unwrap()[0].oid, oid);
    let operation = f.repo.operation_state().unwrap();
    assert_eq!(operation.kind, OperationKind::None);
    assert_eq!(operation.conflicts, ["file"]);
    assert!(f.repo.conflict_file("file").unwrap().ours.is_some());
    assert_eq!(
        f.stash(json!({"kind":"save"})).unwrap_err().code,
        "unresolvedConflict"
    );
}

#[test]
fn stash_identity_is_stable_across_reordering_and_rejects_stale_or_ambiguous_oids() {
    let f = Fixture::new();
    f.write("file", "first\n");
    let first = f.save("first");
    f.write("file", "second\n");
    let second = f.save("second");
    f.git(&["config", "log.date", "iso"]);
    f.git(&["config", "log.showSignature", "true"]);
    assert_eq!(f.repo.stashes().unwrap()[0].selector, "stash@{0}");
    assert_eq!(f.repo.stashes().unwrap()[1].selector, "stash@{1}");
    f.stash(json!({"kind":"pop","oid":first})).unwrap();
    assert_eq!(
        std::fs::read_to_string(f.dir.path().join("file")).unwrap(),
        "first\n"
    );
    assert_eq!(f.repo.stashes().unwrap()[0].oid, second);
    assert_eq!(
        f.stash(json!({"kind":"drop","oid":first}))
            .unwrap_err()
            .code,
        "staleStash"
    );
    f.git(&["stash", "store", "-m", "intermediate", &first]);
    f.git(&["stash", "store", "-m", "duplicate", &second]);
    assert_eq!(
        f.stash(json!({"kind":"drop","oid":second}))
            .unwrap_err()
            .code,
        "ambiguousStash"
    );
    assert_eq!(
        f.stash(json!({"kind":"drop","oid":"stash@{0}"}))
            .unwrap_err()
            .code,
        "invalidStash"
    );
}

#[test]
fn stash_dirty_index_lock_bare_and_closed_sessions_are_guarded() {
    let f = Fixture::new();
    f.write("file", "saved\n");
    let oid = f.save("saved");
    f.write("file", "dirty\n");
    assert_eq!(
        f.stash(json!({"kind":"apply","oid":oid})).unwrap_err().code,
        "dirtyWorktree"
    );
    std::fs::write(f.dir.path().join(".git/index.lock"), "locked").unwrap();
    assert_eq!(
        f.stash(json!({"kind":"save"})).unwrap_err().code,
        "indexLocked"
    );
    let bare = f.bare_remote();
    let handle = f
        .service
        .open(RepositoryLocation::Native {
            path: bare.path().to_str().unwrap().into(),
        })
        .unwrap()
        .session
        .handle;
    assert_eq!(
        f.service
            .stash_action(
                &handle,
                StashAction::Save {
                    message: None,
                    include_untracked: false
                }
            )
            .unwrap_err()
            .code,
        "bareRepository"
    );
    f.service.close(&f.handle).unwrap();
    assert_eq!(
        f.stash(json!({"kind":"save"})).unwrap_err().code,
        "invalidHandle"
    );
    assert_eq!(
        f.remote(json!({"kind":"fetch"})).unwrap_err().code,
        "invalidHandle"
    );
}

#[test]
fn stash_is_shared_with_linked_worktree_but_applies_to_requested_worktree() {
    let f = Fixture::new();
    let linked = tempfile::tempdir().unwrap();
    let path = linked.path().join("linked");
    f.git(&["worktree", "add", "-b", "linked", path.to_str().unwrap()]);
    let handle = f
        .service
        .open(RepositoryLocation::Native {
            path: path.to_str().unwrap().into(),
        })
        .unwrap()
        .session
        .handle;
    f.write("file", "shared stash\n");
    let oid = f.save("shared");
    let repo = f.service.repo(&handle).unwrap();
    assert_eq!(repo.stashes().unwrap()[0].oid, oid);
    f.service
        .stash_action(&handle, StashAction::Pop { oid })
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(path.join("file")).unwrap(),
        "shared stash\n"
    );
    assert_eq!(
        std::fs::read_to_string(f.dir.path().join("file")).unwrap(),
        "base\n"
    );
    assert!(f.repo.stashes().unwrap().is_empty());
    assert_eq!(repo.sync_info().unwrap().branch.as_deref(), Some("linked"));
}

#[test]
fn stash_preserves_literal_paths_staged_content_and_ignored_files() {
    let f = Fixture::new();
    f.write("file", "staged\n");
    f.git(&["add", "file"]);
    f.write("file", "unstaged\n");
    let mut names = vec!["-dash", "工作"];
    if !cfg!(windows) {
        names.push("[literal]*");
    }
    for name in &names {
        f.write(name, name);
    }
    std::fs::write(f.dir.path().join(".git/info/exclude"), "ignored\n").unwrap();
    f.write("ignored", "keep ignored");
    f.stash(json!({"kind":"save", "includeUntracked":true, "message":"--literal message"}))
        .unwrap();
    let oid = f.repo.stashes().unwrap()[0].oid.clone();
    assert_eq!(f.git(&["show", &format!("{oid}^2:file")]), "staged");
    assert_eq!(f.git(&["show", &format!("{oid}:file")]), "unstaged");
    assert!(f.repo.status().unwrap().entries.is_empty());
    assert_eq!(
        std::fs::read_to_string(f.dir.path().join("ignored")).unwrap(),
        "keep ignored"
    );
    f.stash(json!({"kind":"pop", "oid":oid})).unwrap();
    for name in names {
        assert_eq!(
            std::fs::read_to_string(f.dir.path().join(name)).unwrap(),
            name
        );
    }
    assert_eq!(
        std::fs::read_to_string(f.dir.path().join("file")).unwrap(),
        "unstaged\n"
    );
}

#[test]
fn stash_save_refuses_to_erase_an_ignored_replacement_for_a_staged_deletion() {
    let f = Fixture::new();
    f.git(&["rm", "file"]);
    std::fs::write(f.dir.path().join(".git/info/exclude"), "file\n").unwrap();
    f.write("file", "irreplaceable");
    assert_eq!(
        f.stash(json!({"kind":"save","includeUntracked":true}))
            .unwrap_err()
            .code,
        "dirtyWorktree"
    );
    assert_eq!(
        std::fs::read_to_string(f.dir.path().join("file")).unwrap(),
        "irreplaceable"
    );
    assert!(f.repo.stashes().unwrap().is_empty());
}

#[test]
fn explicit_branch_fetch_and_pull_work_without_upstream_and_failed_fetch_never_integrates() {
    let f = Fixture::new();
    let bare = f.bare_remote();
    f.publish();
    let peer = f.peer(bare.path());
    peer.write("incoming", "new");
    let incoming = peer.commit("incoming");
    peer.remote(json!({"kind":"push"})).unwrap();
    peer.git(&["branch", "other"]);
    peer.git(&["push", "origin", "other"]);
    f.git(&["branch", "--unset-upstream"]);
    f.remote(json!({"kind":"fetch", "branch":"main"})).unwrap();
    assert_eq!(
        f.git(&["for-each-ref", "--format=%(refname)", "refs/remotes"]),
        "refs/remotes/origin/main"
    );
    let before = f.git(&["rev-parse", "HEAD"]);
    assert_eq!(f.git(&["rev-parse", "FETCH_HEAD"]), incoming);
    assert!(f
        .remote(json!({"kind":"pull", "branch":"missing"}))
        .is_err());
    assert_eq!(f.git(&["rev-parse", "HEAD"]), before);
    f.remote(json!({"kind":"pull", "remote":"origin", "branch":"main"}))
        .unwrap();
    assert_eq!(f.git(&["rev-parse", "HEAD"]), incoming);
    assert!(f.repo.sync_info().unwrap().upstream.is_none());
}

#[test]
fn pull_merge_conflicts_remain_available_to_existing_operation_controls() {
    let f = Fixture::new();
    let bare = f.bare_remote();
    f.publish();
    let peer = f.peer(bare.path());
    peer.write("file", "incoming\n");
    peer.commit("incoming");
    peer.remote(json!({"kind":"push"})).unwrap();
    f.write("file", "local\n");
    f.commit("local");
    assert!(f
        .remote(json!({"kind":"pull", "pullMode":"merge"}))
        .is_err());
    let operation = f.repo.operation_state().unwrap();
    assert_eq!(operation.kind, OperationKind::Merge);
    assert_eq!(operation.conflicts, ["file"]);
    assert!(!operation.can_continue);
}

#[test]
fn pull_uses_slashed_remote_and_nonmatching_upstream_and_ignores_merge_options() {
    let f = Fixture::new();
    let bare = f.bare_remote();
    f.git(&["remote", "rename", "origin", "team/origin"]);
    f.remote(json!({"kind":"push", "branch":"published", "setUpstream":true}))
        .unwrap();
    let peer = Fixture::new();
    peer.git(&["remote", "add", "origin", bare.path().to_str().unwrap()]);
    peer.git(&["fetch", "origin"]);
    peer.git(&["reset", "--hard", "origin/published"]);
    peer.write("incoming", "from published branch");
    let incoming = peer.commit("incoming");
    peer.git(&["push", "origin", "HEAD:published"]);
    f.write("local", "local divergence");
    let local = f.commit("local");
    // Config must not silently turn an explicit merge pull into a squash or
    // an unfinished --no-commit operation.
    f.git(&["config", "branch.main.mergeOptions", "--squash --no-commit"]);
    f.remote(json!({"kind":"pull", "pullMode":"merge"}))
        .unwrap();
    assert_ne!(f.git(&["rev-parse", "HEAD"]), local);
    assert_eq!(f.git(&["rev-parse", "HEAD^2"]), incoming);
    assert!(f.repo.status().unwrap().entries.is_empty());
    assert_eq!(
        f.repo.sync_info().unwrap().upstream.as_deref(),
        Some("team/origin/published")
    );
    f.git(&[
        "config",
        "remote.team/origin.push",
        "+refs/heads/*:refs/heads/*",
    ]);
    f.git(&["config", "push.default", "matching"]);
    // Explicit single-branch refspec must win over configured forced matching.
    peer.write("peer-again", "new remote commit");
    let remote_head = peer.commit("remote moved");
    peer.git(&["push", "origin", "HEAD:published"]);
    assert!(f.remote(json!({"kind":"push"})).is_err());
    assert_eq!(git(bare.path(), &["rev-parse", "published"]), remote_head);
    assert_eq!(
        git(
            bare.path(),
            &["for-each-ref", "--format=%(refname)", "refs/heads"]
        ),
        "refs/heads/published"
    );
}

#[cfg(unix)]
#[test]
fn stash_pop_does_not_drop_an_external_stash_inserted_during_apply() {
    let f = Fixture::new();
    f.write("file", "other stash\n");
    let concurrent = f.save("other");
    f.git(&["stash", "drop"]);
    f.write("file", "requested stash\n");
    let requested = f.save("requested");
    f.write("file", "conflicting committed change\n");
    f.write(".gitattributes", "file merge=external-stash\n");
    f.commit("conflicting change and merge driver");
    std::fs::write(
        f.dir.path().join(".git/merge-driver"),
        format!("git stash store -m concurrent {concurrent} || exit 1\ncp \"$2\" \"$1\"\n"),
    )
    .unwrap();
    f.git(&[
        "config",
        "merge.external-stash.driver",
        "sh .git/merge-driver %A %B",
    ]);
    f.stash(json!({"kind":"pop", "oid":requested})).unwrap();
    assert_eq!(
        std::fs::read_to_string(f.dir.path().join("file")).unwrap(),
        "requested stash\n"
    );
    let stashes = f.repo.stashes().unwrap();
    assert_eq!(stashes.len(), 1);
    assert_eq!(stashes[0].oid, concurrent);
}

#[cfg(unix)]
#[test]
fn stash_pop_reports_partial_success_when_requested_entry_disappears_during_apply() {
    let f = Fixture::new();
    f.write("file", "requested stash\n");
    let requested = f.save("requested");
    f.write("file", "conflicting committed change\n");
    f.write(".gitattributes", "file merge=external-stash\n");
    f.commit("conflicting change and merge driver");
    std::fs::write(
        f.dir.path().join(".git/merge-driver"),
        "git stash drop || exit 1\ncp \"$2\" \"$1\"\n",
    )
    .unwrap();
    f.git(&[
        "config",
        "merge.external-stash.driver",
        "sh .git/merge-driver %A %B",
    ]);
    let error = f.stash(json!({"kind":"pop", "oid":requested})).unwrap_err();
    assert_eq!(error.code, "mutationUnverified");
    assert!(error.message.contains("was applied"));
    assert_eq!(
        std::fs::read_to_string(f.dir.path().join("file")).unwrap(),
        "requested stash\n"
    );
    assert!(f.repo.stashes().unwrap().is_empty());
}

#[test]
fn untracked_protection_catches_both_file_directory_collision_directions() {
    for target_is_directory in [false, true] {
        let f = Fixture::new();
        f.git(&["switch", "-c", "incoming"]);
        if target_is_directory {
            std::fs::create_dir(f.dir.path().join("nested")).unwrap();
            f.write("nested/child", "incoming");
        } else {
            f.write("nested", "incoming");
        }
        let target = f.commit("incoming");
        f.git(&["switch", "main"]);
        std::fs::write(f.dir.path().join(".git/info/exclude"), "nested\n").unwrap();
        let precious = if target_is_directory {
            "nested"
        } else {
            "nested/child"
        };
        if !target_is_directory {
            std::fs::create_dir(f.dir.path().join("nested")).unwrap();
        }
        f.write(precious, "preserve me");
        assert_eq!(
            f.repo.protect_untracked(&[target]).unwrap_err().code,
            "dirtyWorktree"
        );
        assert_eq!(
            std::fs::read_to_string(f.dir.path().join(precious)).unwrap(),
            "preserve me"
        );
    }
}
