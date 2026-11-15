//! End-to-end tests for the SSH transport.
//!
//! There is no second machine here. A POSIX `ssh` double strips the client options
//! Gitty adds, joins the remaining remote arguments with spaces as OpenSSH does, and
//! hands that one string to a shell, so every test below goes through realistic
//! remote-shell parsing, real quoting and real stdin: what is faked is only the
//! socket. That covers the parts a mocked `Command` cannot (remote environment,
//! argument splitting, patch and message framing) while leaving SSH's own
//! authentication and host-key handling to `ssh_test` against a real host.
#![cfg(unix)]

use crate::{
    dto::*,
    operation_dto::{ConflictResolution, GitAction, OperationRequest},
    process,
    process::args,
    remote_dto::RemoteAction,
    repository::Service,
};
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};
use tempfile::TempDir;

const SHIM: &str = r#"#!/bin/sh
# Test double for the OpenSSH client: consume the options Gitty adds, then hand the
# remote command to a shell the way a POSIX sshd would. OpenSSH joins the remote
# arguments with single spaces before the login shell parses them, so this double
# must join them too: preserving the argv boundary would hide a missing layer of
# quoting.
while [ "$#" -gt 0 ]; do
  case "$1" in
    --) shift; break ;;
    -o|-p|-F|-i|-l|-E|-c|-m|-S|-J|-L|-R|-D|-b|-e|-I|-W) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
[ "$#" -gt 0 ] && shift
remote=""
for arg in "$@"; do
  remote="$remote $arg"
done
exec sh -c "$remote"
"#;

/// The shim is installed once per test process; all SSH tests share it, which is
/// safe because it has no per-test state.
fn install_shim() -> PathBuf {
    static SHIM_DIR: OnceLock<TempDir> = OnceLock::new();
    let dir = SHIM_DIR.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ssh");
        std::fs::write(&path, SHIM).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::env::set_var("GITTY_SSH_EXECUTABLE", &path);
        dir
    });
    dir.path().join("ssh")
}

fn remote(path: &Path) -> RepositoryLocation {
    RepositoryLocation::Ssh {
        host: "test-host".into(),
        port: None,
        user: Some("tester".into()),
        path: path.to_str().unwrap().into(),
    }
}

struct Fixture {
    dir: TempDir,
    _data: TempDir,
    service: Service,
    handle: String,
}

impl Fixture {
    fn new() -> Self {
        install_shim();
        let dir = crate::tests::init();
        for (key, value) in [
            ("commit.gpgSign", "false"),
            ("tag.gpgSign", "false"),
            ("core.autocrlf", "false"),
        ] {
            crate::tests::git(dir.path(), &["config", key, value]);
        }
        std::fs::write(dir.path().join("file"), "base\n").unwrap();
        crate::tests::commit(dir.path(), "base");
        let data = tempfile::tempdir().unwrap();
        let service = Service::new(data.path().into());
        let handle = service.open(remote(dir.path())).unwrap().session.handle;
        Self {
            dir,
            _data: data,
            service,
            handle,
        }
    }
    fn repo(&self) -> std::sync::Arc<crate::repository::Repository> {
        self.service.repo(&self.handle).unwrap()
    }
    fn git(&self, values: &[&str]) -> String {
        crate::tests::git(self.dir.path(), values)
    }
}

#[test]
fn ssh_open_reads_history_status_and_diffs_through_the_remote_command() {
    let f = Fixture::new();
    let state = f.repo().state().unwrap();
    assert_eq!(
        state.session.name,
        f.dir.path().file_name().unwrap().to_str().unwrap()
    );
    assert_eq!(
        state.session.location,
        remote(&std::fs::canonicalize(f.dir.path()).unwrap())
    );
    assert_eq!(state.refs.len(), 1);

    std::fs::write(f.dir.path().join("file"), "base\nchanged\n").unwrap();
    std::fs::write(f.dir.path().join("new file.txt"), "untracked\n").unwrap();

    let status = f.repo().status().unwrap();
    assert!(status
        .entries
        .iter()
        .any(|entry| entry.path == "new file.txt" && entry.untracked));
    assert!(status
        .entries
        .iter()
        .any(|entry| entry.path == "file" && !entry.untracked));

    // A path with a space survives quoting on its way back as a partial diff.
    let diff = f.repo().diff(&DiffSpec::Unstaged, "file").unwrap();
    assert!(diff
        .hunks
        .iter()
        .flat_map(|hunk| &hunk.lines)
        .any(|line| line.kind == "add" && line.content.trim_end() == "changed"));

    let history = f.repo().history(None, 50, HistoryQuery::default()).unwrap();
    assert_eq!(history.commits.len(), 1);
    assert_eq!(history.commits[0].subject, "base");
}

#[test]
fn ssh_staging_and_committing_move_the_remote_index_and_head() {
    let f = Fixture::new();
    std::fs::write(f.dir.path().join("file"), "base\nstaged\n").unwrap();
    std::fs::write(f.dir.path().join("new file.txt"), "untracked\n").unwrap();
    f.service
        .stage(&f.handle, &["file".into(), "new file.txt".into()])
        .unwrap();
    let staged = f.git(&["diff", "--cached", "--name-only"]);
    assert!(staged.contains("file"));
    assert!(staged.contains("new file.txt"));

    // A selected commit profile travels as remote environment: the author and
    // committer must be the profile's, not whatever the host has configured.
    let identity = CommitIdentity {
        name: "Remote Reviewer".into(),
        email: "reviewer@example.test".into(),
    };
    let created = f
        .service
        .create_commit_with_identity(&f.handle, "feat: add a staged change", Some(&identity))
        .unwrap();
    assert_eq!(f.git(&["rev-parse", "HEAD"]), created.oid);
    assert_eq!(
        f.git(&["log", "-1", "--format=%an <%ae>|%cn <%ce>"]),
        "Remote Reviewer <reviewer@example.test>|Remote Reviewer <reviewer@example.test>"
    );
    assert_eq!(f.git(&["status", "--porcelain"]), "");

    f.service
        .amend_commit_with_identity(
            &f.handle,
            "feat: add a staged change\n\nBody from the laptop.",
            None,
            &created.oid,
            Some("refs/heads/main"),
            &f.repo().status().unwrap().fingerprint,
            Default::default(),
        )
        .unwrap();
    assert_eq!(
        f.git(&["log", "-1", "--format=%B"]).trim_end(),
        "feat: add a staged change\n\nBody from the laptop."
    );
}

#[test]
fn ssh_merge_reports_conflicts_and_resolves_them_with_the_remote_helper() {
    if std::process::Command::new("python3")
        .arg("--version")
        .output()
        .is_err()
    {
        return; // Conflict editing needs the remote helper runtime.
    }
    let f = Fixture::new();
    f.git(&["switch", "-c", "side"]);
    std::fs::write(f.dir.path().join("file"), "incoming\n").unwrap();
    f.git(&["commit", "-am", "side"]);
    let side = f.git(&["rev-parse", "HEAD"]);
    f.git(&["switch", "main"]);
    std::fs::write(f.dir.path().join("file"), "current\n").unwrap();
    f.git(&["commit", "-am", "main"]);

    let state = f.repo().state().unwrap();
    f.service
        .run_operation(
            &f.handle,
            OperationRequest {
                action: GitAction::Merge {
                    source: side,
                    destination: None,
                    no_fast_forward: false,
                    message: Some("Merge side".into()),
                    stash_changes: false,
                },
                expected_head: state.session.head,
                expected_head_ref: state.session.head_ref,
                expected_operation: f.repo().operation_state().unwrap().fingerprint,
            },
            None,
        )
        .unwrap();

    let conflict = f.repo().conflict_file("file").unwrap();
    assert!(conflict.editable, "{:?}", conflict.reason);
    assert_eq!(
        conflict.ours.unwrap().content.unwrap().trim_end(),
        "current"
    );
    assert_eq!(
        conflict.theirs.unwrap().content.unwrap().trim_end(),
        "incoming"
    );
    f.service
        .resolve_conflict(
            &f.handle,
            "file",
            &conflict.fingerprint,
            ConflictResolution::Text {
                content: "resolved\n".into(),
            },
        )
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(f.dir.path().join("file")).unwrap(),
        "resolved\n"
    );
}

#[test]
fn ssh_fetch_and_push_use_the_remote_hosts_own_git() {
    let f = Fixture::new();
    let bare = tempfile::tempdir().unwrap();
    crate::tests::git(bare.path(), &["init", "--bare", "-b", "main"]);
    f.git(&["remote", "add", "origin", bare.path().to_str().unwrap()]);

    f.service
        .remote_action(
            &f.handle,
            RemoteAction::Push {
                remote: Some("origin".into()),
                branch: Some("main".into()),
                source: None,
                set_upstream: true,
            },
            None,
        )
        .unwrap();
    assert_eq!(
        crate::tests::git(bare.path(), &["rev-parse", "refs/heads/main"]),
        f.git(&["rev-parse", "main"])
    );

    // A commit made elsewhere on the remote host is picked up by fetch.
    let other = tempfile::tempdir().unwrap();
    crate::tests::git(other.path(), &["clone", bare.path().to_str().unwrap(), "."]);
    std::fs::write(other.path().join("file"), "from the other workstation\n").unwrap();
    crate::tests::commit(other.path(), "remote work");
    let theirs = crate::tests::git(other.path(), &["rev-parse", "HEAD"]);
    crate::tests::git(other.path(), &["push", "origin", "main"]);

    let output = f
        .service
        .remote_action(
            &f.handle,
            RemoteAction::Fetch {
                remote: Some("origin".into()),
                branch: None,
            },
            None,
        )
        .unwrap();
    assert!(!output.output.contains("rejected"));
    assert_eq!(f.git(&["rev-parse", "refs/remotes/origin/main"]), theirs);
}

#[test]
fn ssh_refuses_actions_that_need_a_local_worktree() {
    let f = Fixture::new();
    let unsupported = |result: Result<()>| result.unwrap_err().code == "unsupportedLocation";
    assert!(unsupported(f.service.open_path(&f.handle, "file")));
    assert!(unsupported(f.service.reveal_path(&f.handle, "file")));
    std::fs::write(f.dir.path().join("ignored.log"), "x").unwrap();
    assert!(unsupported(f.service.ignore_path(&f.handle, "ignored.log")));

    let request = crate::worktrees::WorktreeRequest {
        action: "remove".into(),
        path: f.dir.path().to_str().unwrap().into(),
        destination: String::new(),
        branch: String::new(),
        start_point: String::new(),
        reason: String::new(),
        force: true,
    };
    assert!(unsupported(f.repo().worktree_review(&request).map(|_| ())));
}

#[test]
fn ssh_destinations_and_paths_are_validated_before_any_process_starts() {
    install_shim();
    let data = tempfile::tempdir().unwrap();
    let service = Service::new(data.path().into());
    for (host, path, code) in [
        (
            "-oProxyCommand=touch /tmp/gitty-pwned",
            "/tmp",
            "invalidHost",
        ),
        ("home me", "/tmp", "invalidHost"),
        ("home", "relative/path", "invalidPath"),
        ("home", "/tmp/../etc", "invalidPath"),
        ("home", "/tmp/\nmore", "invalidPath"),
    ] {
        let error = service
            .open(RepositoryLocation::Ssh {
                host: host.into(),
                port: None,
                user: None,
                path: path.into(),
            })
            .unwrap_err();
        assert_eq!(error.code, code, "{host} {path}");
    }
    // The probe reuses the same validation, so the form cannot smuggle options in.
    assert_eq!(
        crate::ssh::test(SshTarget {
            host: "-oProxyCommand=evil".into(),
            port: None,
            user: None,
            path: None,
        })
        .unwrap_err()
        .code,
        "invalidHost"
    );
}

#[test]
fn ssh_probe_reports_git_and_the_repository_name() {
    let f = Fixture::new();
    let probe = crate::ssh::test(SshTarget {
        host: "test-host".into(),
        port: Some(2222),
        user: Some("tester".into()),
        path: Some(f.dir.path().to_str().unwrap().into()),
    })
    .unwrap();
    assert!(probe.git_version.starts_with("git version"), "{probe:?}");
    assert_eq!(
        probe.name.as_deref(),
        Some(f.dir.path().file_name().unwrap().to_str().unwrap())
    );
    let missing = crate::ssh::test(SshTarget {
        host: "test-host".into(),
        port: None,
        user: None,
        path: Some(f.dir.path().join("absent").to_str().unwrap().into()),
    })
    .unwrap_err();
    assert_eq!(missing.code, "notARepository");
}

#[test]
fn ssh_directory_listing_returns_only_immediate_subdirectories() {
    let f = Fixture::new();
    let root = f.dir.path();
    for directory in ["alpha", "beta", "alpha/nested", "zeta"] {
        std::fs::create_dir_all(root.join(directory)).unwrap();
    }
    std::fs::write(root.join("file.txt"), "x").unwrap();
    let target = SshTarget {
        host: "test-host".into(),
        port: None,
        user: Some("tester".into()),
        path: Some(root.to_str().unwrap().into()),
    };
    let entries = crate::ssh::directories(target.clone()).unwrap();
    let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
    for expected in ["alpha", "beta", "zeta"] {
        assert!(names.contains(&expected), "{names:?}");
    }
    assert!(
        !names.contains(&"nested"),
        "only immediate children: {names:?}"
    );
    assert!(
        !names.contains(&"file.txt"),
        "files are not folders: {names:?}"
    );
    assert!(
        names.windows(2).all(|pair| pair[0] <= pair[1]),
        "sorted: {names:?}"
    );
    assert_eq!(
        entries[0].path,
        root.join(entries[0].name.as_str()).to_str().unwrap()
    );

    let missing = crate::ssh::directories(SshTarget {
        path: Some(root.join("absent").to_str().unwrap().into()),
        ..target.clone()
    })
    .unwrap_err();
    assert_eq!(missing.code, "notFound", "{}", missing.message);
    let escape = crate::ssh::directories(SshTarget {
        path: Some("/tmp/../etc".into()),
        ..target
    })
    .unwrap_err();
    assert_eq!(escape.code, "invalidPath");
}

#[test]
fn ssh_commands_never_interpolate_a_value_into_an_option_position() {
    // The local argv must end with exactly one remote-command argument, whatever the
    // path: OpenSSH joins the remote arguments with spaces before the login shell
    // parses them, so a separate `sh`, `-c` and script would run only `env`.
    let location = RepositoryLocation::Ssh {
        host: "test-host".into(),
        port: Some(2222),
        user: Some("tester".into()),
        path: "/tmp/a b's".into(),
    };
    let command = process::git_command(&location, &args(&["status", "--porcelain"])).unwrap();
    let argv: Vec<String> = command
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    let script = argv.last().unwrap();
    assert!(argv[..argv.len() - 1].ends_with(&["--".to_string(), "tester@test-host".to_string()]));
    assert!(script.starts_with("sh -c '"), "{script}");
    assert!(
        !argv.iter().any(|arg| arg == "sh" || arg == "-c"),
        "{argv:?}"
    );
    // User values are octal bytes, not login-shell source. End-to-end tests
    // prove that decoding restores the exact argv and binary stdin.
    assert!(!script.contains("a b"));
    assert!(!script.contains("status"));
}

#[test]
fn ssh_tracked_binary_digest_is_bounded_and_content_sensitive() {
    let f = Fixture::new();
    let binary = vec![0u8; 2 * 1024 * 1024];
    std::fs::write(f.dir.path().join("binary"), &binary).unwrap();
    std::os::unix::fs::symlink("file", f.dir.path().join("link")).unwrap();
    f.git(&["add", "binary", "link"]);
    f.git(&["commit", "-m", "binary and link"]);
    let mut changed = binary;
    changed[1024] = 1;
    std::fs::write(f.dir.path().join("binary"), &changed).unwrap();
    let first = f.repo().status().unwrap().fingerprint;
    let modified = std::fs::metadata(f.dir.path().join("binary"))
        .unwrap()
        .modified()
        .unwrap();
    changed[1024] = 2;
    std::fs::write(f.dir.path().join("binary"), &changed).unwrap();
    std::fs::File::options()
        .write(true)
        .open(f.dir.path().join("binary"))
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
    let second = f.repo().status().unwrap().fingerprint;
    assert_ne!(first, second);
    // Symlink target bytes, not followed file content, participate in the patch.
    std::fs::remove_file(f.dir.path().join("link")).unwrap();
    std::os::unix::fs::symlink("missing-target", f.dir.path().join("link")).unwrap();
    assert_ne!(second, f.repo().status().unwrap().fingerprint);
    let command = process::git_digest_command(
        &remote(f.dir.path()),
        &args(&["diff", "--binary", "--no-ext-diff", "--no-textconv", "--"]),
    )
    .unwrap();
    let output = process::run(command).unwrap();
    assert!(output.success);
    assert!(output.stdout.len() <= 65);
    // Failed producers must not return the digest of a partial/empty patch.
    let bad = process::git_digest_command(
        &remote(f.dir.path()),
        &args(&["diff", "--invalid-option-for-test"]),
    )
    .unwrap();
    assert!(!process::run(bad).unwrap().success);
}

#[test]
fn ssh_connection_probe_accepts_bare_repository() {
    install_shim();
    let bare = tempfile::tempdir().unwrap();
    crate::tests::git(bare.path(), &["init", "--bare"]);
    let probe = crate::ssh::test(SshTarget {
        host: "test-host".into(),
        port: None,
        user: None,
        path: Some(bare.path().to_str().unwrap().into()),
    })
    .unwrap();
    assert!(probe.git_version.starts_with("git version"));
    assert!(probe.name.is_some());
}

#[test]
fn ssh_content_fingerprints_support_sha256_repositories() {
    install_shim();
    let dir = tempfile::tempdir().unwrap();
    let git = |args: &[&str]| crate::tests::git(dir.path(), args);
    git(&["init", "-b", "main", "--object-format=sha256"]);
    git(&["config", "user.name", "Test"]);
    git(&["config", "user.email", "test@example.com"]);
    git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(dir.path().join("file\nname"), b"base\0").unwrap();
    git(&["add", "."]);
    git(&["commit", "-m", "base"]);
    let data = tempfile::tempdir().unwrap();
    let service = Service::new(data.path().into());
    let state = service.open(remote(dir.path())).unwrap();
    assert_eq!(state.session.head.unwrap().len(), 64);
    let repo = service.repo(&state.session.handle).unwrap();
    std::fs::write(dir.path().join("file\nname"), b"edit\0").unwrap();
    let first = repo.status().unwrap().fingerprint;
    std::fs::write(dir.path().join("file\nname"), b"next\0").unwrap();
    assert_ne!(first, repo.status().unwrap().fingerprint);
}

#[test]
fn ssh_remote_words_survive_the_command_join_openssh_performs() {
    install_shim();
    let location = RepositoryLocation::Ssh {
        host: "test-host".into(),
        port: None,
        user: Some("tester".into()),
        path: "/tmp".into(),
    };
    // Spaces, apostrophes, substitution syntax and a newline each have to arrive as
    // one literal word after the join, along with a remote environment assignment.
    let command = process::ssh_exec(
        &location,
        &[("GREETING".into(), "O'Brien $(id)".into())],
        &args(&["printf", "[%s]", "a b", "it's", "$(id)", "line\nbreak"]),
    )
    .unwrap();
    let output = process::run_for(command, process::CHECK_TIMEOUT).unwrap();
    assert!(
        output.success,
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        process::text(output.stdout).unwrap(),
        "[a b][it's][$(id)][line\nbreak]"
    );

    // SSH forwards stdin to the remote process, so a joined command must still read it.
    let command = process::ssh_exec(&location, &[], &args(&["cat"])).unwrap();
    let echoed =
        process::run_with_input_for(command, b"piped\nbody\n", Duration::from_secs(10), 1024)
            .unwrap();
    assert_eq!(process::text(echoed.stdout).unwrap(), "piped\nbody\n");
}
