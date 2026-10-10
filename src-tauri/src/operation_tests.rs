use crate::{
    dto::*,
    operation_dto::*,
    repository::{Repository, Service},
};
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
        for (key, value) in [
            ("user.name", "Test"),
            ("user.email", "test@example.com"),
            ("commit.gpgSign", "false"),
            ("tag.gpgSign", "false"),
            ("core.autocrlf", "false"),
        ] {
            git(dir.path(), &["config", key, value]);
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
    fn write(&self, name: &str, bytes: impl AsRef<[u8]>) {
        std::fs::write(self.dir.path().join(name), bytes).unwrap();
    }
    fn commit(&self, message: &str) -> String {
        self.git(&["add", "."]);
        self.git(&["commit", "-m", message]);
        self.git(&["rev-parse", "HEAD"])
    }
    fn request(&self, action: GitAction) -> OperationRequest {
        let state = self.repo.state().unwrap();
        OperationRequest {
            action,
            expected_head: state.session.head,
            expected_head_ref: state.session.head_ref,
            expected_operation: self.repo.operation_state().unwrap().fingerprint,
        }
    }
    fn run(&self, action: GitAction) -> Result<OperationResult> {
        self.service
            .run_operation(&self.handle, self.request(action), None)
    }
    fn resolve(&self, resolution: ConflictResolution) -> Result<()> {
        let file = self.repo.conflict_file("file")?;
        self.service
            .resolve_conflict(&self.handle, "file", &file.fingerprint, resolution)
    }
    fn diverge(&self) -> String {
        self.git(&["switch", "-c", "side"]);
        self.write("file", "incoming\n");
        let side = self.commit("side");
        self.git(&["switch", "main"]);
        self.write("file", "current\n");
        self.commit("main");
        side
    }
    fn merge(&self, source: &str, no_fast_forward: bool) -> Result<OperationResult> {
        self.run(GitAction::Merge {
            source: source.into(),
            destination: None,
            no_fast_forward,
            message: None,
            stash_changes: false,
        })
    }
}

#[cfg(unix)]
#[test]
fn operations_symlink_conflict_selects_exact_side_without_following_target() {
    use std::os::unix::fs::symlink;
    for choice in ["theirs", "ours", "delete"] {
        let f = Fixture::new();
        f.write("precious", "keep this\n");
        f.commit("add link target");
        f.git(&["switch", "-c", "side"]);
        std::fs::remove_file(f.dir.path().join("file")).unwrap();
        symlink("precious", f.dir.path().join("file")).unwrap();
        f.commit("link side");
        f.git(&["switch", "main"]);
        std::fs::remove_file(f.dir.path().join("file")).unwrap();
        symlink("different-target", f.dir.path().join("file")).unwrap();
        f.commit("other link side");
        // The link target is not consulted or changed by side selection.
        assert!(f
            .merge("side", false)
            .unwrap()
            .operation
            .conflicts
            .contains(&"file".to_string()));
        let conflict = f.repo.conflict_file("file").unwrap();
        assert!(!conflict.editable);
        assert!(conflict.reason.unwrap().contains("Symlink"));
        assert_eq!(conflict.theirs.as_ref().unwrap().mode, "120000");
        if choice == "theirs" {
            std::fs::remove_file(f.dir.path().join("file")).unwrap();
            symlink("changed-after-preview", f.dir.path().join("file")).unwrap();
            assert_eq!(
                f.service
                    .resolve_conflict(
                        &f.handle,
                        "file",
                        &conflict.fingerprint,
                        ConflictResolution::Theirs
                    )
                    .unwrap_err()
                    .code,
                "staleConflict"
            );
        }
        let conflict = f.repo.conflict_file("file").unwrap();
        let selected = match choice {
            "theirs" => ConflictResolution::Theirs,
            "ours" => ConflictResolution::Ours,
            _ => ConflictResolution::Delete,
        };
        assert_eq!(
            f.service
                .resolve_conflict(
                    &f.handle,
                    "file",
                    &conflict.fingerprint,
                    ConflictResolution::Working
                )
                .unwrap_err()
                .code,
            "unsupportedConflict"
        );
        f.service
            .resolve_conflict(&f.handle, "file", &conflict.fingerprint, selected)
            .unwrap();
        if choice == "delete" {
            assert!(f.git(&["ls-files", "--stage", "--", "file"]).is_empty());
            assert!(!f.dir.path().join("file").exists());
        } else {
            assert_eq!(
                f.git(&["ls-files", "--stage", "--", "file"])
                    .split_whitespace()
                    .next(),
                Some("120000")
            );
            assert_eq!(
                std::fs::read_link(f.dir.path().join("file")).unwrap(),
                std::path::Path::new(if choice == "theirs" {
                    "precious"
                } else {
                    "different-target"
                })
            );
        }
        assert_eq!(
            std::fs::read(f.dir.path().join("precious")).unwrap(),
            b"keep this\n"
        );
    }
}

#[test]
fn operations_submodule_conflict_selects_index_pointer_without_touching_nested_worktree() {
    let source = Fixture::new();
    let base = source.git(&["rev-parse", "HEAD"]);
    source.write("one", "one\n");
    let one = source.commit("one");
    source.git(&["switch", "-c", "other", &base]);
    source.write("two", "two\n");
    let two = source.commit("two");
    source.git(&["switch", "main"]);
    let f = Fixture::new();
    f.git(&[
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        source.dir.path().to_str().unwrap(),
        "nested",
    ]);
    git(&f.dir.path().join("nested"), &["checkout", &base]);
    f.commit("add nested module");
    f.git(&["switch", "-c", "side"]);
    git(&f.dir.path().join("nested"), &["checkout", &one]);
    f.git(&["add", "nested"]);
    f.git(&["commit", "-m", "side pointer"]);
    f.git(&["switch", "main"]);
    git(&f.dir.path().join("nested"), &["checkout", &two]);
    f.git(&["add", "nested"]);
    f.git(&["commit", "-m", "main pointer"]);
    let conflicts = f.merge("side", false).unwrap().operation.conflicts;
    assert!(conflicts.contains(&"nested".into()));
    let file = f.repo.conflict_file("nested").unwrap();
    assert!(!file.editable);
    assert_eq!(file.ours.as_ref().unwrap().mode, "160000");
    assert_eq!(file.theirs.as_ref().unwrap().mode, "160000");
    let nested_before = git(&f.dir.path().join("nested"), &["rev-parse", "HEAD"]);
    assert_eq!(
        f.service
            .resolve_conflict(
                &f.handle,
                "nested",
                &file.fingerprint,
                ConflictResolution::Delete
            )
            .unwrap_err()
            .code,
        "unsupportedConflict"
    );
    f.service
        .resolve_conflict(
            &f.handle,
            "nested",
            &file.fingerprint,
            ConflictResolution::Theirs,
        )
        .unwrap();
    assert_eq!(
        f.git(&["ls-files", "--stage", "nested"])
            .split_whitespace()
            .nth(1),
        Some(one.as_str())
    );
    assert_eq!(
        git(&f.dir.path().join("nested"), &["rev-parse", "HEAD"]),
        nested_before
    );
    assert!(f.dir.path().join("nested").is_dir());
}

#[test]
fn operations_branch_tag_ff_and_diverged_merge() {
    let f = Fixture::new();
    let root = f.git(&["rev-parse", "HEAD"]);
    f.run(GitAction::CreateBranch {
        name: "side".into(),
        start_point: root.clone(),
        checkout: true,
    })
    .unwrap();
    assert_eq!(f.git(&["symbolic-ref", "--short", "HEAD"]), "side");
    f.write("other", "side\n");
    let side = f.commit("side");
    f.run(GitAction::SwitchBranch {
        branch: "refs/heads/main".into(),
        carry_changes: false,
    })
    .unwrap();
    assert_eq!(f.merge("side", false).unwrap().head, Some(side.clone()));
    f.run(GitAction::CreateTag {
        name: "light".into(),
        oid: side.clone(),
        message: None,
    })
    .unwrap();
    f.run(GitAction::CreateTag {
        name: "annotated".into(),
        oid: side,
        message: Some("Release\n\nDetails".into()),
    })
    .unwrap();
    assert_eq!(f.git(&["cat-file", "-t", "light"]), "commit");
    assert_eq!(f.git(&["cat-file", "-t", "annotated"]), "tag");
    f.run(GitAction::CreateBranch {
        name: "diverged".into(),
        start_point: root,
        checkout: true,
    })
    .unwrap();
    f.write("diverged", "content");
    f.commit("diverged");
    f.run(GitAction::SwitchBranch {
        branch: "main".into(),
        carry_changes: false,
    })
    .unwrap();
    assert_eq!(
        f.merge("diverged", true).unwrap().operation.kind,
        OperationKind::None
    );
    assert_eq!(
        f.git(&["rev-list", "--parents", "-n", "1", "HEAD"])
            .split_whitespace()
            .count(),
        3
    );
    assert!(f
        .run(GitAction::CreateTag {
            name: "light".into(),
            oid: "HEAD".into(),
            message: None
        })
        .is_err());
}

#[test]
fn operations_merge_conflict_exact_text_stale_and_continue() {
    let f = Fixture::new();
    f.diverge();
    let result = f.merge("side", false).unwrap();
    assert_eq!(result.operation.kind, OperationKind::Merge);
    assert_eq!(result.operation.conflicts, ["file"]);
    assert!(!result.operation.can_continue);
    assert!(!result.operation.can_skip);
    let file = f.repo.conflict_file("file").unwrap();
    assert_eq!(file.base.unwrap().content.as_deref(), Some("base\n"));
    assert_eq!(file.ours.unwrap().content.as_deref(), Some("current\n"));
    assert_eq!(file.theirs.unwrap().content.as_deref(), Some("incoming\n"));
    assert!(file.result.unwrap().contains("<<<<<<<"));
    f.write("file", "external edit\r\n");
    assert_eq!(
        f.service
            .resolve_conflict(
                &f.handle,
                "file",
                &file.fingerprint,
                ConflictResolution::Ours
            )
            .unwrap_err()
            .code,
        "staleConflict"
    );
    assert!(f.service.stage(&f.handle, &["file".into()]).is_err());
    let exact = "resolved\r\nwith CRLF\r\n";
    f.resolve(ConflictResolution::Text {
        content: exact.into(),
    })
    .unwrap();
    assert_eq!(
        std::fs::read(f.dir.path().join("file")).unwrap(),
        exact.as_bytes()
    );
    assert!(f.repo.operation_state().unwrap().can_continue);
    let result = f.run(GitAction::Continue).unwrap();
    assert_eq!(result.operation.kind, OperationKind::None);
    assert_eq!(
        f.git(&["rev-list", "--parents", "-n", "1", "HEAD"])
            .split_whitespace()
            .count(),
        3
    );
}

#[test]
fn operations_custom_merge_message_for_ff_no_ff_and_diverged_merge() {
    for (no_fast_forward, diverged) in [(false, false), (true, false), (false, true)] {
        let f = Fixture::new();
        f.git(&["switch", "-c", "side"]);
        f.write("other", "side\n");
        let side = f.commit("side");
        f.git(&["switch", "main"]);
        if diverged {
            f.write("main-only", "main\n");
            f.commit("main");
        }
        let message = "Merge the login feature\n\nReviewed custom body with café.";
        f.run(GitAction::Merge {
            source: "side".into(),
            destination: None,
            no_fast_forward,
            message: Some(message.into()),
            stash_changes: false,
        })
        .unwrap();
        if !no_fast_forward && !diverged {
            assert_eq!(f.git(&["rev-parse", "HEAD"]), side);
            assert_eq!(f.git(&["log", "-1", "--format=%B"]), "side");
        } else {
            assert_eq!(f.git(&["log", "-1", "--format=%B"]), message);
            assert_eq!(
                f.git(&["rev-list", "--parents", "-n", "1", "HEAD"])
                    .split_whitespace()
                    .count(),
                3
            );
        }
    }
}

#[test]
fn operations_custom_merge_message_survives_conflict_and_session_restart() {
    let f = Fixture::new();
    f.diverge();
    let message = "Integrate side\n\nKeep this message after resolving conflicts.";
    let result = f
        .run(GitAction::Merge {
            source: "side".into(),
            destination: None,
            no_fast_forward: false,
            message: Some(message.into()),
            stash_changes: false,
        })
        .unwrap();
    assert_eq!(result.operation.kind, OperationKind::Merge);
    assert!(std::fs::read_to_string(f.dir.path().join(".git/MERGE_MSG"))
        .unwrap()
        .starts_with(message));
    f.resolve(ConflictResolution::Ours).unwrap();
    let service = Service::new(f._data.path().into());
    let session = service
        .open(RepositoryLocation::Native {
            path: f.dir.path().to_string_lossy().into(),
        })
        .unwrap();
    service
        .run_operation(
            &session.session.handle,
            f.request(GitAction::Continue),
            None,
        )
        .unwrap();
    assert_eq!(f.git(&["log", "-1", "--format=%B"]), message);
}

#[test]
fn operations_invalid_merge_message_is_rejected_before_destination_switch() {
    let f = Fixture::new();
    f.git(&["branch", "side"]);
    let head = f.git(&["rev-parse", "HEAD"]);
    for message in [
        " \n".to_string(),
        "bad\0message".to_string(),
        "é".repeat(32769),
    ] {
        let error = f
            .run(GitAction::Merge {
                source: "main".into(),
                destination: Some("side".into()),
                no_fast_forward: true,
                message: Some(message),
                stash_changes: false,
            })
            .unwrap_err();
        assert_eq!(error.code, "invalidRequest");
        assert_eq!(f.git(&["symbolic-ref", "--short", "HEAD"]), "main");
        assert_eq!(f.git(&["rev-parse", "HEAD"]), head);
    }
}

#[test]
fn operations_maximum_merge_message_reaches_destination_without_argv_limits() {
    let f = Fixture::new();
    f.git(&["branch", "destination"]);
    f.write("other", "source\n");
    f.commit("source");
    let message = format!("Integrate main\n\n{}", "é".repeat(32760));
    assert_eq!(message.len(), 65536);
    f.run(GitAction::Merge {
        source: "main".into(),
        destination: Some("refs/heads/destination".into()),
        no_fast_forward: true,
        message: Some(message.clone()),
        stash_changes: false,
    })
    .unwrap();
    assert_eq!(f.git(&["symbolic-ref", "--short", "HEAD"]), "destination");
    assert_eq!(f.git(&["log", "-1", "--format=%B"]), message);
}

#[test]
fn operations_external_merge_restart_abort_and_stale_expectations() {
    let f = Fixture::new();
    f.diverge();
    let head = f.git(&["rev-parse", "HEAD"]);
    let output = Command::new("git")
        .arg("-C")
        .arg(f.dir.path())
        .args(["merge", "side"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    let reopened = f.service.open(f.repo.session.location.clone()).unwrap();
    assert_eq!(
        f.service
            .repo(&reopened.session.handle)
            .unwrap()
            .operation_state()
            .unwrap()
            .kind,
        OperationKind::Merge
    );
    f.run(GitAction::Abort).unwrap();
    assert_eq!(f.git(&["rev-parse", "HEAD"]), head);
    let request = f.request(GitAction::Merge {
        source: "side".into(),
        destination: None,
        no_fast_forward: false,
        message: None,
        stash_changes: false,
    });
    f.git(&["tag", "changed"]);
    assert_eq!(
        f.service
            .run_operation(&f.handle, request, None)
            .unwrap_err()
            .code,
        "staleOperation"
    );
    let mut request = f.request(GitAction::SwitchBranch {
        branch: "side".into(),
        carry_changes: false,
    });
    request.expected_head_ref = None;
    assert_eq!(
        f.service
            .run_operation(&f.handle, request, None)
            .unwrap_err()
            .code,
        "staleOperation"
    );
    f.write("untracked", "dirty");
    assert_eq!(
        f.merge("side", false).unwrap().operation.kind,
        OperationKind::Merge
    );
    assert_eq!(
        std::fs::read(f.dir.path().join("untracked")).unwrap(),
        b"dirty"
    );
}

#[test]
fn operations_create_branch_preserves_dirty_index_and_worktree() {
    for checkout in [false, true] {
        let f = Fixture::new();
        f.write("file", "staged\n");
        f.git(&["add", "file"]);
        f.write("file", "unstaged\n");
        f.write("untracked", "precious\n");
        let status = f.git(&["status", "--porcelain"]);
        let staged = f.git(&["diff", "--cached"]);
        let unstaged = f.git(&["diff"]);
        f.run(GitAction::CreateBranch {
            name: "new-branch".into(),
            start_point: "HEAD".into(),
            checkout,
        })
        .unwrap();
        assert_eq!(
            f.git(&["symbolic-ref", "--short", "HEAD"]),
            if checkout { "new-branch" } else { "main" }
        );
        assert_eq!(
            f.git(&["rev-parse", "new-branch"]),
            f.git(&["rev-parse", "HEAD"])
        );
        assert_eq!(f.git(&["status", "--porcelain"]), status);
        assert_eq!(f.git(&["diff", "--cached"]), staged);
        assert_eq!(f.git(&["diff"]), unstaged);
        assert_eq!(
            std::fs::read(f.dir.path().join("untracked")).unwrap(),
            b"precious\n"
        );
        assert!(f.repo.stashes().unwrap().is_empty());
    }
}

#[test]
fn operations_create_branch_checkout_refuses_overwriting_local_changes() {
    let f = Fixture::new();
    let root = f.git(&["rev-parse", "HEAD"]);
    f.write("file", "committed\n");
    let head = f.commit("change file");
    f.write("file", "precious\n");
    assert_eq!(
        f.run(GitAction::CreateBranch {
            name: "new-branch".into(),
            start_point: root,
            checkout: true,
        })
        .unwrap_err()
        .code,
        "git"
    );
    assert_eq!(f.git(&["rev-parse", "HEAD"]), head);
    assert_eq!(f.git(&["symbolic-ref", "--short", "HEAD"]), "main");
    assert_eq!(
        std::fs::read(f.dir.path().join("file")).unwrap(),
        b"precious\n"
    );
}

#[test]
fn operations_merge_preserves_unrelated_working_changes() {
    for no_fast_forward in [false, true] {
        let f = Fixture::new();
        f.git(&["switch", "-c", "side"]);
        f.write("incoming", "incoming\n");
        let incoming = f.commit("incoming");
        f.git(&["switch", "main"]);
        if no_fast_forward {
            f.write("local", "committed\n");
            f.commit("diverge");
        }
        f.write("file", "precious edit\n");
        f.write("untracked", "precious untracked\n");
        f.merge("side", no_fast_forward).unwrap();
        assert_eq!(
            std::fs::read(f.dir.path().join("file")).unwrap(),
            b"precious edit\n"
        );
        assert_eq!(
            std::fs::read(f.dir.path().join("untracked")).unwrap(),
            b"precious untracked\n"
        );
        assert_eq!(f.git(&["diff", "--name-only"]), "file");
        assert!(f.git(&["diff", "--cached"]).is_empty());
        assert_eq!(f.git(&["show", "HEAD:file"]), "base");
        if no_fast_forward {
            assert_eq!(f.git(&["rev-parse", "HEAD^2"]), incoming);
        } else {
            assert_eq!(f.git(&["rev-parse", "HEAD"]), incoming);
        }
        assert!(f.repo.stashes().unwrap().is_empty());
    }
}

#[test]
fn operations_merge_into_another_branch_carries_unrelated_changes() {
    let f = Fixture::new();
    f.git(&["branch", "destination"]);
    f.git(&["switch", "-c", "side"]);
    f.write("incoming", "incoming\n");
    let incoming = f.commit("incoming");
    f.git(&["switch", "main"]);
    f.write("file", "precious edit\n");
    f.write("untracked", "precious untracked\n");
    f.run(GitAction::Merge {
        source: "side".into(),
        destination: Some("refs/heads/destination".into()),
        no_fast_forward: false,
        message: None,
        stash_changes: false,
    })
    .unwrap();
    assert_eq!(f.git(&["symbolic-ref", "--short", "HEAD"]), "destination");
    assert_eq!(f.git(&["rev-parse", "HEAD"]), incoming);
    assert_eq!(
        std::fs::read(f.dir.path().join("file")).unwrap(),
        b"precious edit\n"
    );
    assert_eq!(
        std::fs::read(f.dir.path().join("untracked")).unwrap(),
        b"precious untracked\n"
    );
}

#[test]
fn operations_merge_preserves_staged_changes_only_when_fast_forwarding() {
    for no_fast_forward in [false, true] {
        let f = Fixture::new();
        f.git(&["switch", "-c", "side"]);
        f.write("incoming", "incoming\n");
        let incoming = f.commit("incoming");
        f.git(&["switch", "main"]);
        let head = f.git(&["rev-parse", "HEAD"]);
        f.write("file", "staged\n");
        f.git(&["add", "file"]);
        f.write("file", "unstaged\n");
        let staged = f.git(&["diff", "--cached"]);
        let unstaged = f.git(&["diff"]);
        let result = f.merge("side", no_fast_forward);
        if no_fast_forward {
            // Git updates ORIG_HEAD even when refusing the merge, so the
            // operation contract correctly requires a refresh after failure.
            assert_eq!(result.unwrap_err().code, "mutationUnverified");
            assert_eq!(f.git(&["rev-parse", "HEAD"]), head);
        } else {
            result.unwrap();
            assert_eq!(f.git(&["rev-parse", "HEAD"]), incoming);
        }
        assert_eq!(f.git(&["diff", "--cached"]), staged);
        assert_eq!(f.git(&["diff"]), unstaged);
        assert_eq!(f.git(&["show", "HEAD:file"]), "base");
    }
}

#[test]
fn operations_merge_explicit_stash_restores_partial_staging_untracked_and_prior_stash() {
    for destination in [None, Some("refs/heads/destination".to_string())] {
        let f = Fixture::new();
        f.write("older", "older stash\n");
        f.git(&["stash", "push", "-u", "-m", "older"]);
        let older = f.git(&["rev-parse", "refs/stash"]);
        f.git(&["branch", "destination"]);
        f.git(&["switch", "-c", "side"]);
        f.write("incoming", "incoming commit\n");
        let incoming = f.commit("incoming");
        f.git(&["switch", "main"]);
        f.write("file", "staged\n");
        f.git(&["add", "file"]);
        f.write("file", "staged plus unstaged\n");
        f.write("untracked space.txt", b"precious\0binary\n");
        let staged = f.git(&["diff", "--cached"]);
        let unstaged = f.git(&["diff"]);
        let result = f
            .run(GitAction::Merge {
                source: "side".into(),
                destination: destination.clone(),
                no_fast_forward: true,
                message: Some("Merge side with saved work".into()),
                stash_changes: true,
            })
            .unwrap();
        assert_eq!(result.operation.kind, OperationKind::None);
        assert!(result
            .notice
            .unwrap()
            .contains("staging state were restored"));
        assert_eq!(
            f.git(&["symbolic-ref", "--short", "HEAD"]),
            if destination.is_some() {
                "destination"
            } else {
                "main"
            }
        );
        assert_eq!(f.git(&["rev-parse", "HEAD^2"]), incoming);
        assert_eq!(f.git(&["show", "HEAD:file"]), "base");
        assert_eq!(
            f.git(&["log", "-1", "--format=%B"]),
            "Merge side with saved work"
        );
        assert_eq!(f.git(&["diff", "--cached"]), staged);
        assert_eq!(f.git(&["diff"]), unstaged);
        assert_eq!(
            std::fs::read(f.dir.path().join("untracked space.txt")).unwrap(),
            b"precious\0binary\n"
        );
        let stashes = f.repo.stashes().unwrap();
        assert_eq!(stashes.len(), 1);
        assert_eq!(stashes[0].oid, older);
    }
}

#[test]
fn operations_merge_explicit_stash_conflicts_retain_work_across_restart_for_continue_or_abort() {
    for abort in [false, true] {
        let f = Fixture::new();
        f.diverge();
        f.write("local", "staged local\n");
        f.git(&["add", "local"]);
        f.write("local", "unstaged local\n");
        f.write("untracked", "untracked local\n");
        let staged = f.git(&["diff", "--cached"]);
        let unstaged = f.git(&["diff"]);
        let result = f
            .run(GitAction::Merge {
                source: "side".into(),
                destination: None,
                no_fast_forward: true,
                message: Some("Merge with retained stash".into()),
                stash_changes: true,
            })
            .unwrap();
        assert_eq!(result.operation.kind, OperationKind::Merge);
        assert!(result.notice.unwrap().contains("Local work was saved"));
        let stashes = f.repo.stashes().unwrap();
        assert_eq!(stashes.len(), 1);
        let oid = stashes[0].oid.clone();
        assert!(!f.dir.path().join("local").exists());
        assert!(!f.dir.path().join("untracked").exists());
        if !abort {
            f.resolve(ConflictResolution::Ours).unwrap();
        }
        f.run(if abort {
            GitAction::Abort
        } else {
            GitAction::Continue
        })
        .unwrap();
        assert_eq!(f.repo.stashes().unwrap()[0].oid, oid);
        let service = Service::new(f._data.path().into());
        let state = service
            .open(RepositoryLocation::Native {
                path: f.dir.path().to_str().unwrap().into(),
            })
            .unwrap();
        service
            .stash_action(
                &state.session.handle,
                crate::remote_dto::StashAction::Pop {
                    oid,
                    restore_index: true,
                },
            )
            .unwrap();
        assert_eq!(f.git(&["diff", "--cached"]), staged);
        assert_eq!(f.git(&["diff"]), unstaged);
        assert_eq!(
            std::fs::read(f.dir.path().join("untracked")).unwrap(),
            b"untracked local\n"
        );
        assert!(f.repo.stashes().unwrap().is_empty());
        assert_eq!(f.git(&["show", "HEAD:file"]), "current");
    }
}

#[test]
fn operations_merge_explicit_stash_restore_failure_keeps_saved_work_and_completed_merge() {
    let f = Fixture::new();
    f.git(&["switch", "-c", "side"]);
    f.write("file", "incoming\n");
    let incoming = f.commit("incoming");
    f.git(&["switch", "main"]);
    f.write("file", "local staged\n");
    f.git(&["add", "file"]);
    f.write("file", "local unstaged\n");
    let error = f
        .run(GitAction::Merge {
            source: "side".into(),
            destination: None,
            no_fast_forward: true,
            message: Some("Completed merge".into()),
            stash_changes: true,
        })
        .unwrap_err();
    assert_eq!(error.code, "mergeWorkSaved");
    assert!(error.message.contains("The merge completed"));
    assert_eq!(f.git(&["rev-parse", "HEAD^2"]), incoming);
    assert_eq!(f.git(&["show", "HEAD:file"]), "incoming");
    let stashes = f.repo.stashes().unwrap();
    assert_eq!(stashes.len(), 1);
    assert_eq!(
        f.git(&["show", &format!("{}^2:file", stashes[0].oid)]),
        "local staged"
    );
    assert_eq!(
        f.git(&["show", &format!("{}:file", stashes[0].oid)]),
        "local unstaged"
    );
}

#[test]
fn operations_merge_explicit_stash_validates_review_message_and_destination_before_saving() {
    let f = Fixture::new();
    f.git(&["branch", "side"]);
    f.write("file", "local staged\n");
    f.git(&["add", "file"]);
    let status = f.git(&["status", "--porcelain"]);
    for (message, destination) in [(" ", None), ("Merge", Some("missing".to_string()))] {
        f.run(GitAction::Merge {
            source: "side".into(),
            destination,
            no_fast_forward: true,
            message: Some(message.into()),
            stash_changes: true,
        })
        .unwrap_err();
        assert!(f.repo.stashes().unwrap().is_empty());
        assert_eq!(f.git(&["status", "--porcelain"]), status);
    }
    let request = f.request(GitAction::Merge {
        source: "side".into(),
        destination: None,
        no_fast_forward: true,
        message: Some("Merge".into()),
        stash_changes: true,
    });
    f.write("external", "external edit\n");
    assert_eq!(
        f.service
            .run_operation(&f.handle, request, None)
            .unwrap_err()
            .code,
        "staleOperation"
    );
    assert!(f.repo.stashes().unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn operations_merge_explicit_stash_keeps_work_after_hook_failure_and_drops_only_its_own_stash() {
    use std::os::unix::fs::PermissionsExt;
    for reject in [true, false] {
        let f = Fixture::new();
        f.git(&["switch", "-c", "side"]);
        f.write("incoming", "incoming\n");
        f.commit("incoming");
        f.git(&["switch", "main"]);
        f.write("file", "local staged\n");
        f.git(&["add", "file"]);
        let hook = f.dir.path().join(if reject {
            ".git/hooks/pre-merge-commit"
        } else {
            ".git/hooks/post-merge"
        });
        std::fs::write(&hook, if reject { "#!/bin/sh\necho hook-refused >&2\nexit 1\n" } else { "#!/bin/sh\nif test ! -f .git/merge-hook-ran; then\n  touch .git/merge-hook-ran\n  printf 'hook work\\n' > hook-work\n  git --no-literal-pathspecs stash push -u -m external-hook-stash\nfi\n" }).unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        let result = f.run(GitAction::Merge {
            source: "side".into(),
            destination: None,
            no_fast_forward: true,
            message: Some("Merge".into()),
            stash_changes: true,
        });
        let stashes = f.repo.stashes().unwrap();
        assert_eq!(
            stashes.len(),
            1,
            "reject={reject}, result={result:?}, stashes={stashes:?}"
        );
        if reject {
            assert!(result.unwrap_err().message.contains("Local work was saved"));
            assert!(stashes[0].message.contains("Gitty merge work"));
        } else {
            result.unwrap();
            assert!(stashes[0].message.contains("external-hook-stash"));
            assert_eq!(f.git(&["show", ":file"]), "local staged");
            assert_eq!(f.git(&["show", "HEAD:file"]), "base");
        }
    }
}

#[test]
fn operations_merge_refuses_overwriting_tracked_untracked_and_ignored_changes() {
    for path in ["file", "untracked", "ignored"] {
        let f = Fixture::new();
        f.git(&["switch", "-c", "side"]);
        f.write(path, "incoming\n");
        f.commit("incoming");
        f.git(&["switch", "main"]);
        if path == "ignored" {
            f.write(".gitignore", "ignored\n");
        }
        let head = f.git(&["rev-parse", "HEAD"]);
        f.write(path, "precious\n");
        let status = f.git(&["status", "--porcelain"]);
        assert_eq!(
            f.merge("side", false).unwrap_err().code,
            "mutationUnverified"
        );
        assert_eq!(f.git(&["rev-parse", "HEAD"]), head);
        assert_eq!(f.git(&["status", "--porcelain"]), status);
        assert_eq!(
            std::fs::read(f.dir.path().join(path)).unwrap(),
            b"precious\n"
        );
        assert!(f.repo.stashes().unwrap().is_empty());
    }
}

#[test]
fn operations_rebase_conflict_continue_skip_abort_and_merge_history_rejection() {
    let f = Fixture::new();
    f.diverge();
    let before = f.git(&["rev-parse", "HEAD"]);
    let result = f
        .run(GitAction::Rebase {
            onto: "side".into(),
        })
        .unwrap();
    assert_eq!(result.operation.kind, OperationKind::Rebase);
    assert_eq!(result.operation.step, Some(1));
    assert_eq!(result.operation.total, Some(1));
    assert!(f
        .repo
        .conflict_file("file")
        .unwrap()
        .ours_label
        .contains("destination"));
    f.run(GitAction::Abort).unwrap();
    assert_eq!(f.git(&["rev-parse", "HEAD"]), before);
    f.run(GitAction::Rebase {
        onto: "side".into(),
    })
    .unwrap();
    f.resolve(ConflictResolution::Text {
        content: "combined\n".into(),
    })
    .unwrap();
    assert_eq!(
        f.run(GitAction::Continue).unwrap().operation.kind,
        OperationKind::None
    );
    assert_eq!(
        f.git(&["rev-parse", "HEAD^"]),
        f.git(&["rev-parse", "side"])
    );
    // A second fixture exercises skip without flattening the previous merge graph.
    let g = Fixture::new();
    g.diverge();
    g.run(GitAction::Rebase {
        onto: "side".into(),
    })
    .unwrap();
    g.run(GitAction::Skip).unwrap();
    assert_eq!(g.git(&["rev-parse", "HEAD"]), g.git(&["rev-parse", "side"]));
    let h = Fixture::new();
    let root = h.git(&["rev-parse", "HEAD"]);
    h.diverge();
    h.merge("side", true).unwrap();
    h.resolve(ConflictResolution::Ours).unwrap();
    h.run(GitAction::Continue).unwrap();
    assert_eq!(
        h.run(GitAction::Rebase { onto: root }).unwrap_err().code,
        "mergeHistory"
    );
}

#[test]
fn operations_ordered_cherry_pick_conflict_continue_abort_and_mainline() {
    let f = Fixture::new();
    let side = f.diverge();
    let before = f.git(&["rev-parse", "HEAD"]);
    assert_eq!(
        f.run(GitAction::CherryPick {
            commits: vec![side.clone()],
            mainline: None
        })
        .unwrap()
        .operation
        .kind,
        OperationKind::CherryPick
    );
    f.run(GitAction::Abort).unwrap();
    assert_eq!(f.git(&["rev-parse", "HEAD"]), before);
    f.run(GitAction::CherryPick {
        commits: vec![side],
        mainline: None,
    })
    .unwrap();
    f.resolve(ConflictResolution::Theirs).unwrap();
    f.run(GitAction::Continue).unwrap();
    assert_eq!(f.git(&["show", "HEAD:file"]), "incoming");
    f.git(&["switch", "side"]);
    f.write("second", "2");
    let second = f.commit("second");
    f.write("third", "3");
    let third = f.commit("third");
    f.git(&["switch", "main"]);
    f.run(GitAction::CherryPick {
        commits: vec![third, second],
        mainline: None,
    })
    .unwrap();
    assert_eq!(f.git(&["log", "-2", "--format=%s"]), "second\nthird");
    f.git(&["merge", "--no-ff", "side", "-m", "merge"]);
    let merge = f.git(&["rev-parse", "HEAD"]);
    assert_eq!(
        f.run(GitAction::CherryPick {
            commits: vec![merge],
            mainline: None
        })
        .unwrap_err()
        .code,
        "mainlineRequired"
    );
}

#[test]
fn operations_binary_missing_stages_and_lock_refusals() {
    let f = Fixture::new();
    f.git(&["switch", "-c", "side"]);
    f.write("file", [0, 255, 1]);
    f.commit("binary side");
    f.git(&["switch", "main"]);
    f.write("file", [0, 254, 2]);
    f.commit("binary main");
    f.merge("side", false).unwrap();
    let file = f.repo.conflict_file("file").unwrap();
    assert!(!file.editable);
    assert!(file.ours.unwrap().content.is_none());
    f.resolve(ConflictResolution::Theirs).unwrap();
    assert_eq!(
        std::fs::read(f.dir.path().join("file")).unwrap(),
        [0, 255, 1]
    );
    f.run(GitAction::Continue).unwrap();
    let g = Fixture::new();
    g.git(&["switch", "-c", "side"]);
    g.git(&["rm", "file"]);
    g.commit("delete");
    g.git(&["switch", "main"]);
    g.write("file", "modified");
    g.commit("modify");
    g.merge("side", false).unwrap();
    assert!(g.repo.conflict_file("file").unwrap().theirs.is_none());
    assert_eq!(
        g.resolve(ConflictResolution::Theirs).unwrap_err().code,
        "missingStage"
    );
    std::fs::write(g.dir.path().join(".git/index.lock"), "owned elsewhere").unwrap();
    assert_eq!(
        g.resolve(ConflictResolution::Delete).unwrap_err().code,
        "indexLocked"
    );
    assert_eq!(g.run(GitAction::Abort).unwrap_err().code, "indexLocked");
    std::fs::remove_file(g.dir.path().join(".git/index.lock")).unwrap();
    g.resolve(ConflictResolution::Delete).unwrap();
    assert!(!g.dir.path().join("file").exists());
    g.run(GitAction::Continue).unwrap();
}

#[test]
fn operations_add_add_stale_index_working_resolution_and_remotes() {
    let f = Fixture::new();
    f.git(&["switch", "-c", "side"]);
    f.write("added", "side\n");
    f.commit("side");
    f.git(&["switch", "main"]);
    f.write("added", "main\n");
    f.commit("main");
    f.merge("side", false).unwrap();
    let file = f.repo.conflict_file("added").unwrap();
    assert!(file.base.is_none());
    assert!(file.editable);
    f.write("added", "working resolution\n");
    let file = f.repo.conflict_file("added").unwrap();
    f.service
        .resolve_conflict(
            &f.handle,
            "added",
            &file.fingerprint,
            ConflictResolution::Working,
        )
        .unwrap();
    assert_eq!(
        f.service
            .resolve_conflict(
                &f.handle,
                "added",
                &file.fingerprint,
                ConflictResolution::Ours
            )
            .unwrap_err()
            .code,
        "notConflicted"
    );
    f.run(GitAction::Continue).unwrap();
    f.git(&[
        "remote",
        "add",
        "origin",
        "https://example.com/org/repo.git",
    ]);
    f.git(&[
        "remote",
        "set-url",
        "--push",
        "origin",
        "ssh://git@example.com/org/repo.git",
    ]);
    f.git(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
    f.git(&["branch", "--set-upstream-to=origin/main"]);
    let remotes = f.repo.remotes().unwrap();
    assert_eq!(remotes[0].branches, ["main"]);
    assert_eq!(remotes[0].current_upstream.as_deref(), Some("origin/main"));
    assert!(remotes[0].fetch_url.starts_with("https:"));
    assert!(remotes[0].push_url.starts_with("ssh:"));
}

#[test]
#[cfg(unix)]
fn operations_symlinks_and_traversal_refused_and_hooks_preserved() {
    let f = Fixture::new();
    f.diverge();
    f.merge("side", false).unwrap();
    for path in ["../file", "/file", ".git/config", "file/../file", "file/"] {
        assert!(f.repo.conflict_file(path).is_err());
    }
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("target"), "outside").unwrap();
    std::fs::remove_file(f.dir.path().join("file")).unwrap();
    std::os::unix::fs::symlink(outside.path().join("target"), f.dir.path().join("file")).unwrap();
    assert!(!f.repo.conflict_file("file").unwrap().editable);
    assert_eq!(
        f.resolve(ConflictResolution::Ours).unwrap_err().code,
        "unsupportedConflict"
    );
    assert_eq!(
        std::fs::read_to_string(outside.path().join("target")).unwrap(),
        "outside"
    );
    f.run(GitAction::Abort).unwrap();
    f.merge("side", false).unwrap();
    f.resolve(ConflictResolution::Ours).unwrap();
    use std::os::unix::fs::PermissionsExt;
    let hook = f.dir.path().join(".git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\necho hook-refused >&2\nexit 1\n").unwrap();
    std::fs::set_permissions(hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let error = f.run(GitAction::Continue).unwrap_err();
    assert!(error.message.contains("hook-refused"));
    assert_eq!(f.repo.operation_state().unwrap().kind, OperationKind::Merge);
}

#[test]
fn operations_mainline_success_cherry_pick_skip_and_index_stage_staleness() {
    let f = Fixture::new();
    let root = f.git(&["rev-parse", "HEAD"]);
    f.git(&["switch", "-c", "side"]);
    f.write("side-file", "side\n");
    f.commit("side");
    f.git(&["switch", "main"]);
    f.write("main-file", "main\n");
    f.commit("main");
    f.git(&["merge", "--no-ff", "side", "-m", "merge"]);
    let merge = f.git(&["rev-parse", "HEAD"]);
    f.run(GitAction::CreateBranch {
        name: "replay".into(),
        start_point: root,
        checkout: true,
    })
    .unwrap();
    f.run(GitAction::CherryPick {
        commits: vec![merge],
        mainline: Some(1),
    })
    .unwrap();
    assert!(f.dir.path().join("side-file").exists());
    assert!(!f.dir.path().join("main-file").exists());

    let g = Fixture::new();
    let incoming = g.diverge();
    g.git(&["switch", "side"]);
    g.write("next", "next\n");
    let next = g.commit("next");
    g.git(&["switch", "main"]);
    let result = g
        .run(GitAction::CherryPick {
            commits: vec![incoming, next],
            mainline: None,
        })
        .unwrap();
    assert_eq!(result.operation.step, Some(1));
    assert_eq!(result.operation.total, Some(2));
    let file = g.repo.conflict_file("file").unwrap();
    let original = std::fs::read(g.dir.path().join("file")).unwrap();
    let ours = file.ours.as_ref().unwrap();
    // Replace only index stage 3, keeping working bytes and all status letters.
    let mut command = Command::new("git")
        .arg("-C")
        .arg(g.dir.path())
        .args(["update-index", "--index-info"])
        .stdin(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    use std::io::Write;
    command
        .stdin
        .take()
        .unwrap()
        .write_all(format!("100644 {} 3\tfile\n", ours.oid).as_bytes())
        .unwrap();
    assert!(command.wait().unwrap().success());
    assert_eq!(std::fs::read(g.dir.path().join("file")).unwrap(), original);
    assert_eq!(
        g.service
            .resolve_conflict(
                &g.handle,
                "file",
                &file.fingerprint,
                ConflictResolution::Theirs
            )
            .unwrap_err()
            .code,
        "staleConflict"
    );
    g.run(GitAction::Skip).unwrap();
    assert!(g.dir.path().join("next").exists());
    assert_eq!(g.git(&["show", "HEAD:file"]), "current");
}

#[test]
fn operations_unsupported_state_bare_and_signing_errors() {
    let f = Fixture::new();
    f.diverge();
    f.merge("side", false).unwrap();
    f.write(".git/BISECT_LOG", "external bisect");
    let op = f.repo.operation_state().unwrap();
    assert_eq!(op.kind, OperationKind::Unsupported);
    assert_eq!(
        f.resolve(ConflictResolution::Ours).unwrap_err().code,
        "unsupportedOperation"
    );
    assert_eq!(
        f.run(GitAction::Abort).unwrap_err().code,
        "unsupportedOperation"
    );
    std::fs::remove_file(f.dir.path().join(".git/BISECT_LOG")).unwrap();
    f.resolve(ConflictResolution::Ours).unwrap();
    f.git(&["config", "commit.gpgSign", "true"]);
    f.git(&["config", "gpg.program", "gitty-nonexistent-signing-program"]);
    let before = f.git(&["rev-parse", "HEAD"]);
    let error = f.run(GitAction::Continue).unwrap_err();
    assert!(error.message.contains("gitty-nonexistent-signing-program"));
    assert_eq!(f.git(&["rev-parse", "HEAD"]), before);

    let bare = tempfile::tempdir().unwrap();
    git(bare.path(), &["init", "--bare"]);
    let state = f
        .service
        .open(RepositoryLocation::Native {
            path: bare.path().to_str().unwrap().into(),
        })
        .unwrap();
    let repo = f.service.repo(&state.session.handle).unwrap();
    let request = OperationRequest {
        action: GitAction::CreateBranch {
            name: "x".into(),
            start_point: "HEAD".into(),
            checkout: false,
        },
        expected_head: None,
        expected_head_ref: state.session.head_ref,
        expected_operation: repo.operation_state().unwrap().fingerprint,
    };
    assert_eq!(
        f.service
            .run_operation(&state.session.handle, request, None)
            .unwrap_err()
            .code,
        "bareRepository"
    );
}

#[test]
fn operations_switch_preserves_ignored_work() {
    let f = Fixture::new();
    f.write(".gitignore", "local\n");
    f.commit("ignore local");
    f.git(&["switch", "-c", "side"]);
    f.write("local", "tracked on side\n");
    f.git(&["add", "-f", "local"]);
    f.git(&["commit", "-m", "track local"]);
    f.git(&["switch", "main"]);
    f.write("local", "precious ignored work\n");
    assert!(f
        .run(GitAction::SwitchBranch {
            branch: "side".into(),
            carry_changes: false,
        })
        .is_err());
    assert_eq!(
        std::fs::read(f.dir.path().join("local")).unwrap(),
        b"precious ignored work\n"
    );
    assert_eq!(f.git(&["symbolic-ref", "--short", "HEAD"]), "main");
    assert!(f.merge("side", false).is_err());
    assert_eq!(
        std::fs::read(f.dir.path().join("local")).unwrap(),
        b"precious ignored work\n"
    );
}

#[test]
fn operations_rebase_abort_target_is_reviewed_state() {
    let f = Fixture::new();
    f.diverge();
    f.run(GitAction::Rebase {
        onto: "side".into(),
    })
    .unwrap();
    let request = f.request(GitAction::Abort);
    let head = f.git(&["rev-parse", "HEAD"]);
    f.write(".git/rebase-merge/orig-head", format!("{head}\n"));
    assert_eq!(
        f.service
            .run_operation(&f.handle, request, None)
            .unwrap_err()
            .code,
        "staleOperation"
    );
    assert_eq!(
        f.repo.operation_state().unwrap().kind,
        OperationKind::Rebase
    );
}

#[test]
#[cfg(unix)]
fn operations_resolution_save_then_filter_failure_is_partial() {
    let f = Fixture::new();
    f.diverge();
    f.merge("side", false).unwrap();
    f.write(".git/info/attributes", "file filter=reject\n");
    // Allow the preflight status/diff to read conflict markers, then reject only
    // the saved resolution so this exercises the failure *after* the file write.
    f.git(&["config", "filter.reject.clean", "data=$(cat); case \"$data\" in 'saved resolution'*) exit 1;; esac; printf '%s\\n' \"$data\""]);
    f.git(&["config", "filter.reject.required", "true"]);
    let error = f
        .resolve(ConflictResolution::Text {
            content: "saved resolution\n".into(),
        })
        .unwrap_err();
    assert_eq!(error.code, "mutationUnverified", "{}", error.message);
    assert_eq!(
        std::fs::read(f.dir.path().join("file")).unwrap(),
        b"saved resolution\n"
    );
    assert!(!f.git(&["ls-files", "--unmerged"]).is_empty());
}

#[test]
fn operations_rebase_controls_preserve_unrelated_dirty_work() {
    for action in [GitAction::Abort, GitAction::Skip] {
        let f = Fixture::new();
        f.write("unrelated", "committed\n");
        f.commit("unrelated base");
        f.diverge();
        f.run(GitAction::Rebase {
            onto: "side".into(),
        })
        .unwrap();
        f.write("unrelated", "precious edit\n");
        f.write("untracked", "precious untracked\n");
        let head = f.git(&["rev-parse", "HEAD"]);
        assert_eq!(f.run(action).unwrap_err().code, "dirtyWorktree");
        assert_eq!(f.git(&["rev-parse", "HEAD"]), head);
        assert_eq!(
            std::fs::read(f.dir.path().join("unrelated")).unwrap(),
            b"precious edit\n"
        );
        assert_eq!(
            std::fs::read(f.dir.path().join("untracked")).unwrap(),
            b"precious untracked\n"
        );
        assert_eq!(
            f.repo.operation_state().unwrap().kind,
            OperationKind::Rebase
        );
    }
}

#[test]
fn operations_rebase_preserves_obstructing_ignored_work() {
    let f = Fixture::new();
    f.write(".gitignore", "local\n");
    f.commit("ignore local");
    f.git(&["switch", "-c", "side"]);
    f.write("local", "tracked on side\n");
    f.git(&["add", "-f", "local"]);
    f.git(&["commit", "-m", "track local"]);
    f.git(&["switch", "main"]);
    f.write("main-only", "main\n");
    f.commit("main");
    f.write("local", "precious ignored work\n");
    assert!(f
        .run(GitAction::Rebase {
            onto: "side".into()
        })
        .is_err());
    assert_eq!(
        std::fs::read(f.dir.path().join("local")).unwrap(),
        b"precious ignored work\n"
    );
}

#[test]
fn operations_conflict_save_rechecks_cherry_pick_and_symbolic_head() {
    for change_ref in [false, true] {
        let f = Fixture::new();
        let side = f.diverge();
        f.run(GitAction::CherryPick {
            commits: vec![side],
            mainline: None,
        })
        .unwrap();
        let file = f.repo.conflict_file("file").unwrap();
        let working = std::fs::read(f.dir.path().join("file")).unwrap();
        if change_ref {
            f.git(&["branch", "alias", "HEAD"]);
            f.git(&["symbolic-ref", "HEAD", "refs/heads/alias"]);
        } else {
            f.git(&["update-ref", "CHERRY_PICK_HEAD", "HEAD"]);
        }
        assert_eq!(
            f.service
                .resolve_conflict(
                    &f.handle,
                    "file",
                    &file.fingerprint,
                    ConflictResolution::Theirs
                )
                .unwrap_err()
                .code,
            "staleConflict"
        );
        assert_eq!(std::fs::read(f.dir.path().join("file")).unwrap(), working);
        assert!(!f.git(&["ls-files", "--unmerged"]).is_empty());
    }
}

#[test]
fn operations_rebase_abort_preserves_new_untracked_obstruction() {
    let f = Fixture::new();
    f.write("restored", "original tracked file\n");
    f.commit("tracked base");
    f.git(&["switch", "-c", "side"]);
    f.git(&["rm", "restored"]);
    f.write("file", "side\n");
    f.commit("side");
    f.git(&["switch", "main"]);
    f.write("file", "main\n");
    f.commit("main");
    f.run(GitAction::Rebase {
        onto: "side".into(),
    })
    .unwrap();
    f.write("restored", "new untracked work\n");
    assert_eq!(f.run(GitAction::Abort).unwrap_err().code, "dirtyWorktree");
    assert_eq!(
        std::fs::read(f.dir.path().join("restored")).unwrap(),
        b"new untracked work\n"
    );
}

#[test]
fn operations_linked_worktree_waiter_rechecks_refs_under_lock() {
    use std::{sync::mpsc, time::Duration};
    let f = Fixture::new();
    let other = tempfile::tempdir().unwrap();
    let linked = other.path().join("linked");
    f.git(&["worktree", "add", "-b", "linked", linked.to_str().unwrap()]);
    let state = f
        .service
        .open(RepositoryLocation::Native {
            path: linked.to_str().unwrap().into(),
        })
        .unwrap();
    let repo = f.service.repo(&state.session.handle).unwrap();
    let request = OperationRequest {
        action: GitAction::CreateTag {
            name: "queued".into(),
            oid: "HEAD".into(),
            message: None,
        },
        expected_head: state.session.head,
        expected_head_ref: state.session.head_ref,
        expected_operation: repo.operation_state().unwrap().fingerprint,
    };
    let (locked_tx, locked_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (result_tx, result_rx) = mpsc::channel();
    std::thread::scope(|scope| {
        let f = &f;
        scope.spawn(move || {
            f.service
                .mutate(&f.handle, |_| {
                    locked_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    f.git(&["tag", "changed-while-waiting"]);
                    Ok(())
                })
                .unwrap()
        });
        locked_rx.recv().unwrap();
        scope.spawn(move || {
            result_tx
                .send(
                    f.service
                        .run_operation(&state.session.handle, request, None),
                )
                .unwrap();
        });
        let early = result_rx.recv_timeout(Duration::from_millis(150));
        release_tx.send(()).unwrap();
        assert!(
            matches!(early, Err(mpsc::RecvTimeoutError::Timeout)),
            "linked worktree operation bypassed mutation lock"
        );
        assert_eq!(
            result_rx
                .recv_timeout(Duration::from_secs(30))
                .unwrap()
                .unwrap_err()
                .code,
            "staleOperation"
        );
    });
    assert_eq!(f.git(&["tag", "--list", "queued"]), "");
}

#[test]
#[cfg(unix)]
fn operations_parent_symlink_never_reads_or_writes_outside() {
    let f = Fixture::new();
    std::fs::create_dir(f.dir.path().join("nested")).unwrap();
    f.write("nested/file", "base\n");
    f.commit("nested base");
    f.git(&["switch", "-c", "side"]);
    f.write("nested/file", "side\n");
    f.commit("side");
    f.git(&["switch", "main"]);
    f.write("nested/file", "main\n");
    f.commit("main");
    f.merge("side", false).unwrap();
    let file = f.repo.conflict_file("nested/file").unwrap();
    std::fs::rename(f.dir.path().join("nested"), f.dir.path().join("saved")).unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("file"), "precious outside\n").unwrap();
    std::os::unix::fs::symlink(outside.path(), f.dir.path().join("nested")).unwrap();
    assert_eq!(
        f.repo.conflict_file("nested/file").unwrap_err().code,
        "unsupportedConflict"
    );
    assert!(f
        .service
        .resolve_conflict(
            &f.handle,
            "nested/file",
            &file.fingerprint,
            ConflictResolution::Theirs
        )
        .is_err());
    assert_eq!(
        std::fs::read(outside.path().join("file")).unwrap(),
        b"precious outside\n"
    );
    assert!(!f.git(&["ls-files", "--unmerged"]).is_empty());
}

#[test]
#[cfg(unix)]
fn operations_cherry_pick_and_rebase_continue_honor_commit_message_hooks() {
    use std::os::unix::fs::PermissionsExt;
    for rebase in [false, true] {
        let f = Fixture::new();
        let side = f.diverge();
        f.run(if rebase {
            GitAction::Rebase { onto: side }
        } else {
            GitAction::CherryPick {
                commits: vec![side],
                mainline: None,
            }
        })
        .unwrap();
        f.resolve(ConflictResolution::Text {
            content: "combined\n".into(),
        })
        .unwrap();
        let head = f.git(&["rev-parse", "HEAD"]);
        let index = f.git(&["ls-files", "--stage"]);
        let hook = f.dir.path().join(".git/hooks/prepare-commit-msg");
        std::fs::write(&hook, "#!/bin/sh\necho message-hook-refused >&2\nexit 1\n").unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        let error = f.run(GitAction::Continue).unwrap_err();
        assert!(
            error.message.contains("message-hook-refused"),
            "{}",
            error.message
        );
        assert_eq!(f.git(&["rev-parse", "HEAD"]), head);
        assert_eq!(f.git(&["ls-files", "--stage"]), index);
        assert_eq!(
            std::fs::read(f.dir.path().join("file")).unwrap(),
            b"combined\n"
        );
        std::fs::remove_file(hook).unwrap();
        f.run(GitAction::Continue).unwrap();
        assert_eq!(f.repo.operation_state().unwrap().kind, OperationKind::None);
    }
}

#[test]
fn operations_cherry_pick_preserves_obstructing_ignored_work() {
    let f = Fixture::new();
    f.write(".gitignore", "local\n");
    f.commit("ignore local");
    f.git(&["switch", "-c", "side"]);
    f.write("local", "tracked on side\n");
    f.git(&["add", "-f", "local"]);
    let side = f.commit("track local");
    f.git(&["switch", "main"]);
    f.write("local", "precious ignored work\n");
    assert!(f
        .run(GitAction::CherryPick {
            commits: vec![side],
            mainline: None
        })
        .is_err());
    assert_eq!(
        std::fs::read(f.dir.path().join("local")).unwrap(),
        b"precious ignored work\n"
    );
}

#[test]
#[cfg(unix)]
fn operations_binary_side_stages_exact_blob_and_mode_despite_filters() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    f.git(&["switch", "-c", "side"]);
    f.write("file", [0, 255, 13, 10]);
    std::fs::set_permissions(
        f.dir.path().join("file"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    f.commit("binary executable side");
    let oid = f.git(&["rev-parse", "HEAD:file"]);
    f.git(&["switch", "main"]);
    f.write("file", [0, 254, 10]);
    f.commit("binary main");
    f.merge("side", false).unwrap();
    f.write(".git/info/attributes", "file filter=rewrite\n");
    f.git(&["config", "filter.rewrite.clean", "printf rewritten"]);
    f.resolve(ConflictResolution::Theirs).unwrap();
    assert_eq!(
        f.git(&["ls-files", "--stage", "--", "file"]),
        format!("100755 {oid} 0\tfile")
    );
    assert_eq!(
        std::fs::read(f.dir.path().join("file")).unwrap(),
        [0, 255, 13, 10]
    );
    assert_ne!(
        std::fs::metadata(f.dir.path().join("file"))
            .unwrap()
            .permissions()
            .mode()
            & 0o111,
        0
    );
}

#[test]
fn operations_cherry_pick_continue_preserves_new_ignored_work() {
    let f = Fixture::new();
    f.write(".gitignore", "local\n");
    f.commit("ignore local");
    let side = f.diverge();
    f.git(&["switch", "side"]);
    f.write("local", "tracked next\n");
    f.git(&["add", "-f", "local"]);
    let next = f.commit("next");
    f.git(&["switch", "main"]);
    f.run(GitAction::CherryPick {
        commits: vec![side, next],
        mainline: None,
    })
    .unwrap();
    f.resolve(ConflictResolution::Theirs).unwrap();
    f.write("local", "precious ignored work\n");
    let head = f.git(&["rev-parse", "HEAD"]);
    assert_eq!(
        f.run(GitAction::Continue).unwrap_err().code,
        "dirtyWorktree"
    );
    assert_eq!(f.git(&["rev-parse", "HEAD"]), head);
    assert_eq!(
        std::fs::read(f.dir.path().join("local")).unwrap(),
        b"precious ignored work\n"
    );
}

#[test]
fn operations_merge_and_cherry_pick_abort_preserve_unrelated_edits() {
    for cherry_pick in [false, true] {
        let f = Fixture::new();
        f.write("unrelated", "committed\n");
        f.commit("unrelated base");
        let side = f.diverge();
        f.run(if cherry_pick {
            GitAction::CherryPick {
                commits: vec![side],
                mainline: None,
            }
        } else {
            GitAction::Merge {
                source: side,
                destination: None,
                no_fast_forward: false,
                message: None,
                stash_changes: false,
            }
        })
        .unwrap();
        f.write("unrelated", "precious edit\n");
        f.write("untracked", "precious untracked\n");
        f.run(GitAction::Abort).unwrap();
        assert_eq!(
            std::fs::read(f.dir.path().join("unrelated")).unwrap(),
            b"precious edit\n"
        );
        assert_eq!(
            std::fs::read(f.dir.path().join("untracked")).unwrap(),
            b"precious untracked\n"
        );
    }
}

#[test]
fn operations_rebase_interactive_reword_squash_and_exec_guards() {
    let f = Fixture::new();
    f.diverge();
    f.run(GitAction::Rebase {
        onto: "side".into(),
    })
    .unwrap();
    f.resolve(ConflictResolution::Text {
        content: "resolved\n".into(),
    })
    .unwrap();

    // 1. exec rejection without running
    let sentinel = f.dir.path().join("sentinel");
    f.write(
        ".git/rebase-merge/git-rebase-todo",
        format!("exec touch {}\n", sentinel.display()),
    );
    assert_eq!(
        f.run(GitAction::Continue).unwrap_err().code,
        "unsupportedOperation"
    );
    assert!(!sentinel.exists());

    // 2. merge-preserving directive rejection
    f.write(
        ".git/rebase-merge/git-rebase-todo",
        "merge -C 1234567890123456789012345678901234567890\n",
    );
    assert_eq!(
        f.run(GitAction::Continue).unwrap_err().code,
        "unsupportedOperation"
    );

    // 3. Abort is still allowed despite unsupported directive
    let f_abort = Fixture::new();
    f_abort.diverge();
    f_abort
        .run(GitAction::Rebase {
            onto: "side".into(),
        })
        .unwrap();
    f_abort.write(
        ".git/rebase-merge/git-rebase-todo",
        format!("exec touch {}\n", sentinel.display()),
    );
    f_abort.run(GitAction::Abort).unwrap();
    assert_eq!(
        f_abort.repo.operation_state().unwrap().kind,
        OperationKind::None
    );

    // 4. Interactive rebase with editor bridge (reword & save)
    let f2 = Fixture::new();
    f2.diverge();
    f2.run(GitAction::Rebase {
        onto: "side".into(),
    })
    .unwrap();

    // Resolve conflict first
    f2.resolve(ConflictResolution::Text {
        content: "resolved\n".into(),
    })
    .unwrap();

    // Setup reword in done
    let head = f2.git(&["rev-parse", "HEAD"]);
    f2.write(".git/rebase-merge/done", format!("reword {head} main\n"));

    // Without editor bridge, continuation with interactive step is refused
    assert_eq!(
        f2.service
            .run_operation(&f2.handle, f2.request(GitAction::Continue), None)
            .unwrap_err()
            .code,
        "unsupportedOperation"
    );

    // Setup mock editor registry
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let token = "test-rebase-token".to_string();

    let script_path = f2.dir.path().join("test-editor.py");
    let script_code = r#"#!/usr/bin/env python3
import socket, sys, os
port = int(os.environ["GITTY_EDITOR_PORT"])
token = os.environ["GITTY_EDITOR_TOKEN"].encode()
path = sys.argv[1].encode()
s = socket.socket()
s.connect(("127.0.0.1", port))
s.sendall(len(token).to_bytes(4, 'big') + token + len(path).to_bytes(4, 'big') + path)
res = s.recv(1)
sys.exit(0 if res == b'1' else 1)
"#;
    std::fs::write(&script_path, script_code).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms).unwrap();
    }

    let editor_registry = Arc::new(crate::editor::EditorRegistry::new(port, token, script_path));

    let reg_clone = editor_registry.clone();
    let (prompt_tx, prompt_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for (req_id, stream) in (1..).zip(listener.incoming().flatten()) {
            let reg = reg_clone.clone();
            let p_tx = prompt_tx.clone();
            std::thread::spawn(move || {
                crate::editor::handle_connection(
                    stream,
                    &reg,
                    req_id,
                    |id, name, content| p_tx.send((id, name, content)).map_err(|_| ()),
                    |_| {},
                );
            });
        }
    });

    let f2_handle = f2.handle.clone();
    let f2_request = f2.request(GitAction::Continue);
    let f2_service = &f2.service;
    let ed_ref = editor_registry.clone();

    std::thread::scope(|s| {
        let op_thread = s.spawn(|| f2_service.run_operation(&f2_handle, f2_request, Some(&ed_ref)));

        let (req_id, file_name, content) = prompt_rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap();
        assert!(file_name.contains("COMMIT_EDITMSG") || file_name.contains("message"));
        assert!(content.contains("main") || !content.is_empty());

        let new_msg = "feat: successfully reworded commit message\n";
        editor_registry
            .reply(req_id, Some(new_msg.to_string()))
            .unwrap();

        let res = op_thread.join().unwrap();
        assert!(res.is_ok(), "Operation failed: {:?}", res);
    });

    assert_eq!(
        f2.git(&["log", "-1", "--format=%s"]),
        "feat: successfully reworded commit message"
    );
}

#[cfg(unix)]
#[test]
fn operations_reviewed_interactive_rebase_reorders_fixups_and_rewords() {
    use std::os::unix::fs::PermissionsExt;
    for squash in [false, true] {
        let f = Fixture::new();
        let base = f.git(&["rev-parse", "HEAD"]);
        f.write("one", "one\n");
        let one = f.commit("one");
        f.write("two", "two\n");
        let two = f.commit("two");
        f.write("three", "three\n");
        let three = f.commit("three");
        let original = f.git(&["rev-parse", "HEAD"]);
        let helper_dir = tempfile::tempdir().unwrap();
        let script_path = helper_dir.path().join("editor helper.py");
        std::fs::write(
            &script_path,
            r#"#!/usr/bin/env python3
import socket, sys, os
token = os.environ['GITTY_EDITOR_TOKEN'].encode()
path = os.fsencode(sys.argv[1])
with socket.create_connection(('127.0.0.1', int(os.environ['GITTY_EDITOR_PORT']))) as sock:
    sock.sendall(len(token).to_bytes(4, 'big') + token + len(path).to_bytes(4, 'big') + path)
    sys.exit(0 if sock.recv(1) == b'1' else 1)
"#,
        )
        .unwrap();
        std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let registry = Arc::new(crate::editor::EditorRegistry::new(
            listener.local_addr().unwrap().port(),
            "planned-rebase".into(),
            script_path,
        ));
        let (prompt_tx, prompt_rx) = std::sync::mpsc::channel();
        let reg = registry.clone();
        std::thread::spawn(move || {
            for (id, stream) in listener.incoming().enumerate() {
                if let Ok(stream) = stream {
                    let reg = reg.clone();
                    let tx = prompt_tx.clone();
                    std::thread::spawn(move || {
                        crate::editor::handle_connection(
                            stream,
                            &reg,
                            id + 1,
                            |req, name, content| tx.send((req, name, content)).map_err(|_| ()),
                            |_| {},
                        )
                    });
                }
            }
        });
        let steps = if squash {
            vec![
                RebaseStep {
                    oid: one.clone(),
                    instruction: RebaseInstruction::Drop,
                },
                RebaseStep {
                    oid: two.clone(),
                    instruction: RebaseInstruction::Pick,
                },
                RebaseStep {
                    oid: three.clone(),
                    instruction: RebaseInstruction::Squash,
                },
            ]
        } else {
            vec![
                RebaseStep {
                    oid: two.clone(),
                    instruction: RebaseInstruction::Pick,
                },
                RebaseStep {
                    oid: one.clone(),
                    instruction: RebaseInstruction::Fixup,
                },
                RebaseStep {
                    oid: three.clone(),
                    instruction: RebaseInstruction::Reword,
                },
            ]
        };
        let stale_review = f.request(GitAction::InteractiveRebase {
            onto: base.clone(),
            steps: steps.clone(),
        });
        let action = GitAction::InteractiveRebase {
            onto: base.clone(),
            steps,
        };
        assert_eq!(
            f.service
                .run_operation(
                    &f.handle,
                    f.request(GitAction::InteractiveRebase {
                        onto: base.clone(),
                        steps: vec![]
                    }),
                    Some(&registry)
                )
                .unwrap_err()
                .code,
            "invalidRequest"
        );
        std::thread::scope(|scope| {
            let op = scope.spawn(|| {
                f.service
                    .run_operation(&f.handle, f.request(action), Some(&registry))
            });
            for _ in 0..30 {
                if op.is_finished() {
                    break;
                }
                if let Ok((id, _, _)) = prompt_rx.recv_timeout(std::time::Duration::from_secs(1)) {
                    registry
                        .reply(id, Some("rewritten three\n".into()))
                        .unwrap();
                }
            }
            let result = op.join().unwrap();
            assert!(result.is_ok(), "{:?}", result.err());
        });
        assert_eq!(
            f.git(&["rev-list", "--count", &format!("{base}..HEAD")]),
            if squash { "1" } else { "2" }
        );
        assert_eq!(f.git(&["log", "-1", "--format=%s"]), "rewritten three");
        assert_ne!(f.git(&["rev-parse", "HEAD"]), original);
        assert_eq!(
            f.service
                .run_operation(&f.handle, stale_review, Some(&registry))
                .unwrap_err()
                .code,
            "staleOperation"
        );
        for name in ["one", "two", "three"] {
            assert_eq!(f.dir.path().join(name).exists(), name != "one" || !squash);
        }
    }
}

#[test]
fn operations_rebase_interactive_cancel_halts_helper_and_preserves_state() {
    let f = Fixture::new();
    f.diverge();
    f.run(GitAction::Rebase {
        onto: "side".into(),
    })
    .unwrap();

    f.resolve(ConflictResolution::Text {
        content: "resolved\n".into(),
    })
    .unwrap();

    let head = f.git(&["rev-parse", "HEAD"]);
    f.write(".git/rebase-merge/done", format!("reword {head} main\n"));

    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let token = "test-cancel-token".to_string();

    let script_path = f.dir.path().join("test-editor-cancel.py");
    let script_code = r#"#!/usr/bin/env python3
import socket, sys, os
port = int(os.environ["GITTY_EDITOR_PORT"])
token = os.environ["GITTY_EDITOR_TOKEN"].encode()
path = sys.argv[1].encode()
s = socket.socket()
s.connect(("127.0.0.1", port))
s.sendall(len(token).to_bytes(4, 'big') + token + len(path).to_bytes(4, 'big') + path)
res = s.recv(1)
sys.exit(0 if res == b'1' else 1)
"#;
    std::fs::write(&script_path, script_code).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms).unwrap();
    }

    let editor_registry = Arc::new(crate::editor::EditorRegistry::new(port, token, script_path));

    let reg_clone = editor_registry.clone();
    let (prompt_tx, prompt_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for (req_id, stream) in (1..).zip(listener.incoming().flatten()) {
            let reg = reg_clone.clone();
            let p_tx = prompt_tx.clone();
            std::thread::spawn(move || {
                crate::editor::handle_connection(
                    stream,
                    &reg,
                    req_id,
                    |id, name, content| p_tx.send((id, name, content)).map_err(|_| ()),
                    |_| {},
                );
            });
        }
    });

    let f_handle = f.handle.clone();
    let f_request = f.request(GitAction::Continue);
    let f_service = &f.service;
    let ed_ref = editor_registry.clone();

    std::thread::scope(|s| {
        let op_thread = s.spawn(|| f_service.run_operation(&f_handle, f_request, Some(&ed_ref)));

        let (req_id, _, _) = prompt_rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap();

        // Cancel the prompt
        editor_registry.reply(req_id, None).unwrap();

        let res = op_thread.join().unwrap();
        assert!(res.is_err(), "Expected cancellation to fail Git write");
    });

    // Operation is still in progress, untouched
    assert_eq!(
        f.repo.operation_state().unwrap().kind,
        OperationKind::Rebase
    );
}

#[cfg(unix)]
#[test]
fn operations_continue_real_external_interactive_squash() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    f.git(&["switch", "-c", "side"]);
    f.write("file", "side\n");
    f.commit("side");
    f.git(&["switch", "main"]);
    f.write("file", "main\n");
    let first = f.commit("first");
    f.write("second-file", "second\n");
    let second = f.commit("second");

    // Git itself creates the interactive state and stops at the first conflict.
    let sequence_script = f.dir.path().join("sequence-editor.sh");
    std::fs::write(
        &sequence_script,
        format!(
            "#!/bin/sh\nprintf '%s\\n' 'pick {first} first' 'squash {second} second' > \"$1\"\n"
        ),
    )
    .unwrap();
    std::fs::set_permissions(&sequence_script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let output = Command::new("git")
        .arg("-C")
        .arg(f.dir.path())
        .args(["rebase", "-i", "--merge", "side"])
        .env("GIT_SEQUENCE_EDITOR", &sequence_script)
        .env("GIT_EDITOR", "true")
        .output()
        .unwrap();
    assert!(!output.status.success(), "expected a conflict: {output:?}");
    assert_eq!(
        f.repo.operation_state().unwrap().kind,
        OperationKind::Rebase
    );
    f.resolve(ConflictResolution::Text {
        content: "resolved\n".into(),
    })
    .unwrap();

    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let script_path = f.dir.path().join("test squash editor.py");
    std::fs::write(
        &script_path,
        r#"#!/usr/bin/env python3
import socket, sys, os
token = os.environ["GITTY_EDITOR_TOKEN"].encode()
path = sys.argv[1].encode()
with socket.create_connection(("127.0.0.1", int(os.environ["GITTY_EDITOR_PORT"]))) as sock:
    sock.sendall(len(token).to_bytes(4, 'big') + token + len(path).to_bytes(4, 'big') + path)
    sys.exit(0 if sock.recv(1) == b'1' else 1)
"#,
    )
    .unwrap();
    std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755)).unwrap();
    let registry = Arc::new(crate::editor::EditorRegistry::new(
        port,
        "squash-test".into(),
        script_path,
    ));
    let (prompt_tx, prompt_rx) = std::sync::mpsc::channel();
    let reg = registry.clone();
    std::thread::spawn(move || {
        for (id, stream) in listener.incoming().enumerate() {
            if let Ok(stream) = stream {
                let reg = reg.clone();
                let tx = prompt_tx.clone();
                std::thread::spawn(move || {
                    crate::editor::handle_connection(
                        stream,
                        &reg,
                        id + 1,
                        |request_id, name, content| {
                            tx.send((request_id, name, content)).map_err(|_| ())
                        },
                        |_| {},
                    )
                });
            }
        }
    });

    let request = f.request(GitAction::Continue);
    std::thread::scope(|scope| {
        let op = scope.spawn(|| f.service.run_operation(&f.handle, request, Some(&registry)));
        let mut saw_squash = false;
        for _ in 0..30 {
            if op.is_finished() {
                break;
            }
            match prompt_rx.recv_timeout(std::time::Duration::from_secs(1)) {
                Ok((id, _, message)) => {
                    saw_squash |= message.contains("combination of 2 commits");
                    registry
                        .reply(id, Some("combined message\n".into()))
                        .unwrap();
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(e) => panic!("editor listener disconnected: {e}"),
            }
        }
        assert!(
            op.is_finished(),
            "rebase did not finish after editor replies"
        );
        let result = op.join().unwrap().unwrap();
        assert_eq!(result.operation.kind, OperationKind::None);
        assert!(saw_squash, "expected Git's squash message editor");
    });
    assert_eq!(f.git(&["log", "-1", "--format=%s"]), "combined message");
    assert_eq!(f.git(&["rev-list", "--count", "side..main"]), "1");
    assert_eq!(f.git(&["show", "HEAD:second-file"]), "second");
}

#[test]
fn operations_switch_origin_creates_tracking_branch_and_preserves_existing_local() {
    let f = Fixture::new();
    f.git(&["remote", "add", "origin", "."]);
    f.git(&["switch", "-c", "remote-source"]);
    f.write("file", "incoming\n");
    let origin_oid = f.commit("origin tip");
    f.git(&[
        "update-ref",
        "refs/remotes/origin/feature/topic",
        &origin_oid,
    ]);
    f.git(&["switch", "main"]);
    f.write("other", "staged work\n");
    f.git(&["add", "other"]);
    let switch = || {
        f.run(GitAction::SwitchBranch {
            branch: "refs/remotes/origin/feature/topic".into(),
            carry_changes: true,
        })
    };
    switch().unwrap();
    assert_eq!(f.git(&["symbolic-ref", "HEAD"]), "refs/heads/feature/topic");
    assert_eq!(f.git(&["rev-parse", "HEAD"]), origin_oid);
    assert_eq!(
        f.git(&["rev-parse", "--symbolic-full-name", "@{upstream}"]),
        "refs/remotes/origin/feature/topic"
    );
    assert_eq!(f.git(&["diff", "--cached", "--name-only"]), "other");
    let local_oid = f.commit("local work");
    f.git(&["switch", "main"]);
    switch().unwrap();
    assert_eq!(f.git(&["rev-parse", "HEAD"]), local_oid);
    assert_eq!(
        f.git(&["rev-parse", "refs/remotes/origin/feature/topic"]),
        origin_oid
    );
    assert_eq!(
        f.run(GitAction::SwitchBranch {
            branch: "refs/remotes/origin/HEAD".into(),
            carry_changes: true,
        })
        .unwrap_err()
        .code,
        "invalidReference"
    );
}

#[test]
fn operations_switch_origin_carries_overlapping_changes_as_conflicts() {
    let f = Fixture::new();
    f.git(&["remote", "add", "origin", "."]);
    f.git(&["switch", "-c", "remote-source"]);
    f.write("file", "incoming\n");
    let oid = f.commit("origin tip");
    f.git(&["update-ref", "refs/remotes/origin/topic", &oid]);
    f.git(&["switch", "main"]);
    f.write("file", "mine\n");
    let result = f
        .run(GitAction::SwitchBranch {
            branch: "refs/remotes/origin/topic".into(),
            carry_changes: true,
        })
        .unwrap();
    assert_eq!(f.git(&["symbolic-ref", "--short", "HEAD"]), "topic");
    assert_eq!(result.operation.conflicts, vec!["file".to_string()]);
    assert_eq!(f.git(&["config", "branch.topic.remote"]), "origin");
}

#[test]
fn operations_reset_origin_discards_local_commits_and_tracked_work_only() {
    let f = Fixture::new();
    let origin = f.git(&["rev-parse", "HEAD"]);
    f.git(&["update-ref", "refs/remotes/origin/main", &origin]);
    f.write("file", "local commit\n");
    let local = f.commit("local commit");
    f.write("file", "staged\n");
    f.git(&["add", "file"]);
    f.write("file", "unstaged\n");
    f.write("new-staged", "staged addition\n");
    f.git(&["add", "new-staged"]);
    f.write("untracked", "keep\n");
    f.write(".gitignore", "ignored\n");
    f.write("ignored", "keep ignored\n");
    let result = f
        .run(GitAction::ResetToOrigin {
            branch: "refs/remotes/origin/main".into(),
            expected_origin_oid: origin.clone(),
        })
        .unwrap();
    assert_eq!(result.head, Some(origin.clone()));
    assert_eq!(f.git(&["symbolic-ref", "HEAD"]), "refs/heads/main");
    assert_eq!(f.git(&["rev-parse", "refs/remotes/origin/main"]), origin);
    assert_eq!(f.git(&["rev-parse", "ORIG_HEAD"]), local);
    assert_eq!(
        std::fs::read_to_string(f.dir.path().join("file")).unwrap(),
        "base\n"
    );
    assert!(!f.dir.path().join("new-staged").exists());
    assert!(f.git(&["diff", "--cached"]).is_empty());
    for (path, content) in [
        ("untracked", "keep\n"),
        ("ignored", "keep ignored\n"),
        (".gitignore", "ignored\n"),
    ] {
        assert_eq!(
            std::fs::read_to_string(f.dir.path().join(path)).unwrap(),
            content
        );
    }
}

#[test]
fn operations_reset_origin_rejects_stale_reviews_and_invalid_targets() {
    let f = Fixture::new();
    let origin = f.git(&["rev-parse", "HEAD"]);
    f.git(&["update-ref", "refs/remotes/origin/main", &origin]);
    let action = || GitAction::ResetToOrigin {
        branch: "refs/remotes/origin/main".into(),
        expected_origin_oid: origin.clone(),
    };
    let request = f.request(action());
    f.write("file", "new work\n");
    assert_eq!(
        f.service
            .run_operation(&f.handle, request, None)
            .unwrap_err()
            .code,
        "staleOperation"
    );
    assert_eq!(
        std::fs::read_to_string(f.dir.path().join("file")).unwrap(),
        "new work\n"
    );
    let request = f.request(action());
    let moved = f.commit("moved");
    f.git(&["update-ref", "refs/remotes/origin/main", &moved]);
    assert_eq!(
        f.service
            .run_operation(&f.handle, request, None)
            .unwrap_err()
            .code,
        "staleOperation"
    );
    assert_eq!(f.run(action()).unwrap_err().code, "staleOperation");
    for branch in [
        "refs/remotes/origin/HEAD",
        "refs/remotes/upstream/main",
        "refs/heads/main",
        "refs/remotes/origin/other",
    ] {
        assert_eq!(
            f.run(GitAction::ResetToOrigin {
                branch: branch.into(),
                expected_origin_oid: moved.clone()
            })
            .unwrap_err()
            .code,
            "invalidReference"
        );
    }
    f.git(&["switch", "--detach"]);
    assert_eq!(f.run(action()).unwrap_err().code, "invalidReference");
}

#[test]
fn operations_reset_origin_preserves_nested_work_even_when_recursion_is_configured() {
    let source = Fixture::new();
    let base = source.git(&["rev-parse", "HEAD"]);
    source.write("file", "next\n");
    let next = source.commit("next");
    let f = Fixture::new();
    f.git(&[
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        source.dir.path().to_str().unwrap(),
        "nested",
    ]);
    let nested = f.dir.path().join("nested");
    git(&nested, &["checkout", &base]);
    let origin = f.commit("origin pointer");
    f.git(&["update-ref", "refs/remotes/origin/main", &origin]);
    git(&nested, &["checkout", &next]);
    f.git(&["add", "nested"]);
    f.git(&["commit", "-m", "local pointer"]);
    std::fs::write(nested.join("file"), "nested work\n").unwrap();
    f.git(&["config", "submodule.recurse", "true"]);
    f.run(GitAction::ResetToOrigin {
        branch: "refs/remotes/origin/main".into(),
        expected_origin_oid: origin.clone(),
    })
    .unwrap();
    assert_eq!(f.git(&["rev-parse", "HEAD"]), origin);
    assert_eq!(f.git(&["rev-parse", "HEAD:nested"]), base);
    assert_eq!(git(&nested, &["rev-parse", "HEAD"]), next);
    assert_eq!(
        std::fs::read_to_string(nested.join("file")).unwrap(),
        "nested work\n"
    );
}

#[test]
fn operations_reset_origin_protects_obstructing_untracked_and_ignored_files() {
    for ignored in [false, true] {
        let f = Fixture::new();
        f.git(&["switch", "-c", "incoming"]);
        f.write("obstruction", "incoming\n");
        let origin = f.commit("incoming");
        f.git(&["update-ref", "refs/remotes/origin/main", &origin]);
        f.git(&["switch", "main"]);
        let head = f.git(&["rev-parse", "HEAD"]);
        f.write("obstruction", "keep\n");
        if ignored {
            f.write(".gitignore", "obstruction\n");
        }
        assert_eq!(
            f.run(GitAction::ResetToOrigin {
                branch: "refs/remotes/origin/main".into(),
                expected_origin_oid: origin
            })
            .unwrap_err()
            .code,
            "dirtyWorktree"
        );
        assert_eq!(f.git(&["rev-parse", "HEAD"]), head);
        assert_eq!(
            std::fs::read_to_string(f.dir.path().join("obstruction")).unwrap(),
            "keep\n"
        );
    }
}

#[test]
fn operations_switch_carries_changes_and_surfaces_conflicts() {
    let f = Fixture::new();
    f.git(&["switch", "-c", "side"]);
    f.write("file", "incoming\n");
    f.commit("side");
    f.git(&["switch", "main"]);
    let switch = |f: &Fixture| {
        f.run(GitAction::SwitchBranch {
            branch: "refs/heads/side".into(),
            carry_changes: true,
        })
    };
    // Unrelated staged work is carried unchanged, still staged.
    f.write("other", "mine\n");
    f.git(&["add", "other"]);
    let result = switch(&f).unwrap();
    assert!(result.operation.conflicts.is_empty());
    assert_eq!(f.git(&["symbolic-ref", "--short", "HEAD"]), "side");
    assert_eq!(f.git(&["diff", "--cached", "--name-only"]), "other");
    f.git(&["reset", "-q", "--hard"]);
    f.git(&["switch", "main"]);
    // Work overlapping the target's changes merges, leaving a conflict to resolve.
    f.write("file", "mine\n");
    let result = switch(&f).unwrap();
    assert_eq!(f.git(&["symbolic-ref", "--short", "HEAD"]), "side");
    assert_eq!(result.operation.conflicts, vec!["file".to_string()]);
    // Without carry_changes, dirty work is still refused.
    f.git(&["reset", "-q", "--hard"]);
    f.git(&["switch", "main"]);
    f.write("file", "mine\n");
    assert_eq!(
        f.run(GitAction::SwitchBranch {
            branch: "side".into(),
            carry_changes: false,
        })
        .unwrap_err()
        .code,
        "dirtyWorktree"
    );
}

#[test]
fn snapshot_matches_the_separate_reads_and_sees_a_conflict() {
    let f = Fixture::new();
    f.write("untracked", "new\n");
    let clean = f.repo.snapshot().unwrap();
    assert_eq!(clean.operation.kind, OperationKind::None);
    assert_eq!(
        clean.operation.fingerprint,
        f.repo.operation_state().unwrap().fingerprint
    );
    assert_eq!(
        clean.status.fingerprint,
        f.repo.status().unwrap().fingerprint
    );
    assert_eq!(clean.state.fingerprint, f.repo.state().unwrap().fingerprint);
    assert!(clean.status.entries.iter().any(|e| e.path == "untracked"));

    f.diverge();
    f.merge("side", false).unwrap();
    let conflicted = f.repo.snapshot().unwrap();
    assert_eq!(conflicted.operation.kind, OperationKind::Merge);
    assert_eq!(conflicted.operation.conflicts, vec!["file".to_string()]);
    assert_eq!(
        conflicted.operation.fingerprint,
        f.repo.operation_state().unwrap().fingerprint
    );
    assert!(conflicted.status.entries.iter().any(|e| e.conflicted));
}

#[test]
fn snapshot_of_a_bare_repository_has_an_empty_status() {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "--bare", "-b", "main"]);
    let data = tempfile::tempdir().unwrap();
    let service = Service::new(data.path().into());
    let handle = service
        .open(RepositoryLocation::Native {
            path: dir.path().to_str().unwrap().into(),
        })
        .unwrap()
        .session
        .handle;
    let snapshot = service.repo(&handle).unwrap().snapshot().unwrap();
    assert!(snapshot.state.session.bare);
    assert!(snapshot.status.entries.is_empty());
    assert_eq!(snapshot.status.fingerprint, "bare");
    assert_eq!(snapshot.operation.kind, OperationKind::None);
}

#[test]
fn find_listing_is_parsed_into_git_dir_relative_paths() {
    use crate::operations::find_listing_paths;
    let listing = b"/r/.git/HEAD\0/r/.git/rebase-merge\0/r/.git/rebase-merge/head-name\0\
/r/.git/with space/MERGE_MSG\0/elsewhere/MERGE_HEAD\0/r/.gitx/MERGE_HEAD\0\
/r/.git/\0/r/.git\0/r/.git/bad-\xff-name\0/r/.git/sequencer/todo\0";
    let found = find_listing_paths("/r/.git", listing);
    let mut found: Vec<_> = found.iter().map(String::as_str).collect();
    found.sort();
    assert_eq!(
        found,
        [
            "HEAD",
            "rebase-merge",
            "rebase-merge/head-name",
            "sequencer/todo",
            "with space/MERGE_MSG",
        ]
    );
    // A trailing slash on the Git directory and an empty listing both behave.
    assert!(find_listing_paths("/r/.git/", b"/r/.git/MERGE_HEAD\0").contains("MERGE_HEAD"));
    assert!(find_listing_paths("/r/.git", b"").is_empty());
}

#[test]
fn metadata_scan_argv_prunes_heavy_subtrees_and_drops_dangling_links() {
    use crate::operations::{metadata_scan_args, METADATA_SCAN_PRUNED};
    let argv = metadata_scan_args("/r/.git/");
    assert_eq!(
        argv,
        [
            "find",
            "-L",
            "/r/.git/",
            "-mindepth",
            "1",
            "-maxdepth",
            "2",
            "(",
            "-path",
            "/r/.git/objects",
            "-o",
            "-path",
            "/r/.git/refs",
            "-o",
            "-path",
            "/r/.git/logs",
            "-o",
            "-path",
            "/r/.git/hooks",
            "-o",
            "-path",
            "/r/.git/worktrees",
            "-o",
            "-path",
            "/r/.git/lfs",
            "-o",
            "-path",
            "/r/.git/modules",
            ")",
            "-prune",
            "-o",
            "!",
            "-type",
            "l",
            "-print0",
        ]
    );
    assert_eq!(METADATA_SCAN_PRUNED.len(), 7);
    // Glob metacharacters in the Git directory match literally.
    let odd = metadata_scan_args("/r/a[1]*?\\b/.git");
    assert!(odd.contains(&"/r/a\\[1]\\*\\?\\\\b/.git/objects".to_string()));
}

#[test]
fn metadata_scan_keeps_every_metadata_path_within_depth_two_and_unpruned() {
    use crate::operations::{METADATA_SCAN_PRUNED, OPERATION_METADATA_PATHS};
    let paths = OPERATION_METADATA_PATHS;
    assert_eq!(paths.len(), 29);
    for path in paths {
        let parts: Vec<&str> = path.split('/').collect();
        assert!(parts.len() <= 2, "{path} deeper than the scan");
        assert!(
            !METADATA_SCAN_PRUNED.contains(&parts[0]),
            "{path} lives in a pruned subtree"
        );
    }
}

#[test]
fn find_exit_one_with_output_is_tolerated_but_other_failures_are_not() {
    use crate::operations::find_outcome_acceptable;
    // Success, and exit 1 (vanished lock file / unreadable subdirectory) with a listing.
    assert!(find_outcome_acceptable(true, Some(0), b"/r/.git/HEAD\0"));
    assert!(find_outcome_acceptable(false, Some(1), b"/r/.git/HEAD\0"));
    // Exit 1 without any listing means the Git directory itself was not scanned.
    assert!(!find_outcome_acceptable(false, Some(1), b""));
    // Other codes, signals and timeouts fail even with partial output.
    assert!(!find_outcome_acceptable(false, Some(2), b"/r/.git/HEAD\0"));
    assert!(!find_outcome_acceptable(false, Some(127), b""));
    assert!(!find_outcome_acceptable(false, None, b"/r/.git/HEAD\0"));
}

#[test]
fn creating_a_tag_with_a_dirty_worktree_gets_a_tag_specific_refusal() {
    let f = Fixture::new();
    f.write("untracked", "work in progress\n");
    let tag = |name: &str| GitAction::CreateTag {
        name: name.into(),
        oid: "HEAD".into(),
        message: None,
    };
    let error = f.run(tag("blocked")).unwrap_err();
    assert_eq!(error.code, "dirtyWorktree");
    assert_eq!(error.message, crate::operations::CREATE_TAG_DIRTY_MESSAGE);
    assert!(error.message.starts_with("Creating a tag requires a clean"));
    assert!(f.git(&["tag", "--list", "blocked"]).is_empty());
    // Other refused actions keep the generic wording.
    let error = f
        .run(GitAction::Rebase {
            onto: "main".into(),
        })
        .unwrap_err();
    assert_eq!(error.code, "dirtyWorktree");
    assert!(error.message.starts_with("Commit or explicitly stash"));
}
