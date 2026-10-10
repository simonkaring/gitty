use crate::{dto::*, mutate::AmendOptions, repository::Service};
use std::{path::Path, process::Command};
use tempfile::TempDir;

pub(super) fn git(path: &Path, args: &[&str]) -> String {
    let o = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .output()
        .unwrap();
    assert!(
        o.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&o.stderr)
    );
    String::from_utf8(o.stdout).unwrap().trim_end().into()
}
pub(super) fn init() -> TempDir {
    let d = tempfile::tempdir().unwrap();
    git(d.path(), &["init", "-b", "main"]);
    git(d.path(), &["config", "user.name", "Test Author"]);
    git(d.path(), &["config", "user.email", "test@example.com"]);
    d
}
pub(super) fn commit(path: &Path, message: &str) -> String {
    git(path, &["add", "--all"]);
    git(path, &["commit", "-m", message]);
    git(path, &["rev-parse", "HEAD"])
}
pub(super) fn open(service: &mut Service, path: &Path) -> RepositoryState {
    service
        .open(RepositoryLocation::Native {
            path: path.to_str().unwrap().into(),
        })
        .unwrap()
}

#[test]
fn repository_git_identity_is_explicit_shared_and_detects_external_changes() {
    let d = init();
    std::fs::write(d.path().join("base"), "base").unwrap();
    commit(d.path(), "initial");
    let linked = tempfile::tempdir().unwrap();
    let linked_path = linked.path().join("linked");
    git(
        d.path(),
        &[
            "worktree",
            "add",
            "-b",
            "linked",
            linked_path.to_str().unwrap(),
        ],
    );
    let data = tempfile::tempdir().unwrap();
    git(d.path(), &["config", "--local", "core.abbrev", "9"]);
    let mut service = Service::new(data.path().into());
    let main = open(&mut service, d.path());
    let worktree = open(&mut service, &linked_path);
    let before = service
        .repo(&main.session.handle)
        .unwrap()
        .git_identity()
        .unwrap();
    assert_eq!(before.local.name.as_deref(), Some("Test Author"));
    let selected = CommitIdentity {
        name: "Different Author".into(),
        email: "different@example.org".into(),
    };
    let updated = service
        .set_git_identity(&worktree.session.handle, &selected, &before.local)
        .unwrap();
    assert_eq!(updated.effective.name.as_deref(), Some("Different Author"));
    assert_eq!(
        git(d.path(), &["config", "--local", "user.email"]),
        selected.email
    );
    assert_eq!(git(&linked_path, &["config", "user.name"]), selected.name);
    assert_eq!(git(d.path(), &["config", "--local", "core.abbrev"]), "9");
    std::fs::write(linked_path.join("outside-gitty"), "external commit").unwrap();
    commit(&linked_path, "from terminal");
    assert_eq!(
        git(&linked_path, &["log", "-1", "--format=%an <%ae>"]),
        "Different Author <different@example.org>"
    );
    git(d.path(), &["config", "extensions.worktreeConfig", "true"]);
    git(
        &linked_path,
        &["config", "--worktree", "user.email", "worktree@example.org"],
    );
    let overridden = service
        .repo(&worktree.session.handle)
        .unwrap()
        .git_identity()
        .unwrap();
    assert_eq!(
        overridden.local.email.as_deref(),
        Some("different@example.org")
    );
    assert_eq!(
        overridden.effective.email.as_deref(),
        Some("worktree@example.org")
    );
    git(
        d.path(),
        &["config", "--local", "user.name", "External Author"],
    );
    let error = service
        .set_git_identity(&main.session.handle, &selected, &before.local)
        .err()
        .unwrap();
    assert_eq!(error.code, "staleOperation");
    assert_eq!(git(d.path(), &["config", "user.name"]), "External Author");
    let invalid = CommitIdentity {
        name: "Bad\nName".into(),
        email: "bad@example.org".into(),
    };
    assert_eq!(
        service
            .set_git_identity(
                &main.session.handle,
                &invalid,
                &service
                    .repo(&main.session.handle)
                    .unwrap()
                    .git_identity()
                    .unwrap()
                    .local
            )
            .err()
            .unwrap()
            .code,
        "invalidRequest"
    );
}

#[test]
fn unborn_status_odd_paths_staged_untracked_and_persistence() {
    let d = init();
    let data = tempfile::tempdir().unwrap();
    let mut service = Service::new(data.path().into());
    let state = open(&mut service, d.path());
    assert!(state.session.head.is_none());
    assert_eq!(state.session.head_ref.as_deref(), Some("refs/heads/main"));
    let repo = service.repo(&state.session.handle).unwrap();
    assert!(repo
        .history(None, 20, HistoryQuery::default())
        .unwrap()
        .commits
        .is_empty());
    let odd = "-odd\tfile\nname.txt";
    std::fs::write(d.path().join(odd), "first\nsecond\n").unwrap();
    assert_eq!(repo.status().unwrap().entries[0].path, odd);
    let files = repo.diff_files(&DiffSpec::Untracked).unwrap();
    assert_eq!(files[0].additions, Some(2));
    assert_eq!(files[0].path, odd);
    assert_eq!(
        repo.diff(&DiffSpec::Untracked, odd).unwrap().hunks[0].lines[0].content,
        "first"
    );
    git(d.path(), &["add", "--", odd]);
    assert_eq!(repo.status().unwrap().entries[0].index_status, "A");
    assert_eq!(
        repo.diff_files(&DiffSpec::Staged).unwrap()[0].additions,
        Some(2)
    );
    assert_eq!(Service::new(data.path().into()).recent().unwrap().len(), 1);
}

#[test]
fn pinned_topological_walk_merge_parents_and_moving_refs() {
    let d = init();
    std::fs::write(d.path().join("base"), "base\n").unwrap();
    let root = commit(d.path(), "root");
    git(d.path(), &["checkout", "-b", "side"]);
    std::fs::write(d.path().join("side"), "side\n").unwrap();
    let side = commit(d.path(), "side");
    git(d.path(), &["checkout", "main"]);
    std::fs::write(d.path().join("main"), "main\n").unwrap();
    let main = commit(d.path(), "main");
    git(d.path(), &["merge", "--no-ff", "side", "-m", "merge"]);
    let merge = git(d.path(), &["rev-parse", "HEAD"]);
    let data = tempfile::tempdir().unwrap();
    let mut service = Service::new(data.path().into());
    let state = open(&mut service, d.path());
    let repo = service.repo(&state.session.handle).unwrap();
    let first = repo.history(None, 1, HistoryQuery::default()).unwrap();
    assert_eq!(first.commits[0].id, merge);
    assert_eq!(first.commits[0].parents, vec![main.clone(), side.clone()]);
    std::fs::write(d.path().join("later"), "later\n").unwrap();
    let later = commit(d.path(), "later");
    let mut ids = vec![merge.clone()];
    let mut cursor = first.cursor;
    while cursor.is_some() {
        let page = repo.history(cursor, 1, HistoryQuery::default()).unwrap();
        assert_eq!(page.generation, first.generation);
        ids.extend(page.commits.into_iter().map(|c| c.id));
        cursor = page.cursor;
    }
    assert_eq!(ids.len(), 4);
    assert!(!ids.contains(&later));
    assert_eq!(ids.last(), Some(&root));
    assert_eq!(
        ids.iter().collect::<std::collections::HashSet<_>>().len(),
        4
    );
    let files = repo
        .diff_files(&DiffSpec::Commit {
            oid: merge.clone(),
            parent: Some(side),
        })
        .unwrap();
    assert_eq!(files[0].path, "main");
    assert!(repo
        .diff_files(&DiffSpec::Commit {
            oid: merge,
            parent: Some(root.clone())
        })
        .is_err());
    let files = repo
        .diff_files(&DiffSpec::Commit {
            oid: root.clone(),
            parent: None,
        })
        .unwrap();
    assert_eq!(files[0].path, "base");
    let root_detail = repo.commit(&root).unwrap();
    assert!(root_detail.summary.parents.is_empty());
    assert_eq!(root_detail.summary.author, "Test Author");
    assert!(repo.commit("--all").is_err());
    assert!(repo.diff(&DiffSpec::Untracked, "../outside").is_err());
}

#[test]
fn rename_binary_mode_and_unstaged_diff() {
    let d = init();
    std::fs::write(d.path().join("old\tname"), "first\nsecond\nthird\n").unwrap();
    let root = commit(d.path(), "root");
    git(d.path(), &["mv", "--", "old\tname", "new\nname"]);
    std::fs::write(d.path().join("binary"), [0, 1, 2, 3]).unwrap();
    git(d.path(), &["add", "binary"]);
    let data = tempfile::tempdir().unwrap();
    let mut service = Service::new(data.path().into());
    let state = open(&mut service, d.path());
    let repo = service.repo(&state.session.handle).unwrap();
    let status = repo.status().unwrap();
    let rename = status
        .entries
        .iter()
        .find(|e| e.old_path.is_some())
        .unwrap();
    assert_eq!(rename.old_path.as_deref(), Some("old\tname"));
    let files = repo.diff_files(&DiffSpec::Staged).unwrap();
    let renamed = files.iter().find(|e| e.status == "R").unwrap();
    assert_eq!(renamed.path, "new\nname");
    assert_eq!(renamed.additions, Some(0));
    assert!(files.iter().find(|e| e.path == "binary").unwrap().binary);
    assert!(repo.diff(&DiffSpec::Staged, "binary").unwrap().binary);
    let patch = repo.diff(&DiffSpec::Staged, "new\nname").unwrap();
    assert!(patch.message.unwrap().contains("rename from"));
    let tip = commit(d.path(), "rename and binary");
    std::fs::write(d.path().join("new\nname"), "changed\nsecond\nthird\n").unwrap();
    let patch = repo.diff(&DiffSpec::Unstaged, "new\nname").unwrap();
    assert_eq!(patch.hunks[0].lines[0].old_line, Some(1));
    assert_eq!(patch.hunks[0].lines[1].new_line, Some(1));
    assert_eq!(
        repo.diff_files(&DiffSpec::Compare {
            base: root,
            target: tip
        })
        .unwrap()
        .len(),
        2
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            d.path().join("new\nname"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        assert!(repo
            .diff(&DiffSpec::Unstaged, "new\nname")
            .unwrap()
            .message
            .unwrap()
            .contains("new mode 100755"));
    }
}

#[test]
fn conflicts_bare_detached_linked_and_shallow_original_parents() {
    let d = init();
    std::fs::write(d.path().join("file"), "base\n").unwrap();
    let root = commit(d.path(), "root");
    git(d.path(), &["checkout", "-b", "side"]);
    std::fs::write(d.path().join("file"), "side\n").unwrap();
    commit(d.path(), "side");
    git(d.path(), &["checkout", "main"]);
    std::fs::write(d.path().join("file"), "main\n").unwrap();
    let main = commit(d.path(), "main");
    let failed = Command::new("git")
        .arg("-C")
        .arg(d.path())
        .args(["merge", "side"])
        .output()
        .unwrap();
    assert!(!failed.status.success());
    let data = tempfile::tempdir().unwrap();
    let mut service = Service::new(data.path().into());
    let state = open(&mut service, d.path());
    let repo = service.repo(&state.session.handle).unwrap();
    assert!(repo.status().unwrap().entries[0].conflicted);
    assert!(repo.diff_files(&DiffSpec::Staged).is_ok());
    assert!(repo.diff_files(&DiffSpec::Unstaged).is_ok());
    assert_eq!(repo.diff_files(&DiffSpec::Conflict).unwrap()[0].status, "U");
    assert!(!repo
        .diff(&DiffSpec::Conflict, "file")
        .unwrap()
        .hunks
        .is_empty());
    git(d.path(), &["merge", "--abort"]);
    let others = tempfile::tempdir().unwrap();
    let bare = others.path().join("bare.git");
    git(
        d.path(),
        &[
            "clone",
            "--bare",
            d.path().to_str().unwrap(),
            bare.to_str().unwrap(),
        ],
    );
    let b = open(&mut service, &bare);
    assert!(b.session.bare);
    assert_eq!(
        service
            .repo(&b.session.handle)
            .unwrap()
            .status()
            .unwrap_err()
            .code,
        "bareRepository"
    );
    let linked = others.path().join("linked");
    git(
        d.path(),
        &[
            "worktree",
            "add",
            "--detach",
            linked.to_str().unwrap(),
            &root,
        ],
    );
    let l = open(&mut service, &linked);
    assert!(l.session.linked_worktree);
    assert!(l.session.head_ref.is_none());
    let shallow = others.path().join("shallow");
    git(
        d.path(),
        &[
            "clone",
            "--depth=1",
            &format!("file://{}", d.path().display()),
            shallow.to_str().unwrap(),
        ],
    );
    let s = open(&mut service, &shallow);
    assert!(s.session.shallow);
    let page = service
        .repo(&s.session.handle)
        .unwrap()
        .history(None, 10, HistoryQuery::default())
        .unwrap();
    assert_eq!(page.commits.len(), 1);
    assert_eq!(page.commits[0].id, main);
    assert_eq!(page.commits[0].parents, vec![root]);
    assert!(page.shallow);
}

#[test]
fn search_literal_paths_dates_and_reads_do_not_modify_index_or_run_drivers() {
    let d = init();
    std::fs::write(d.path().join("literal[1].txt"), "before\r\n").unwrap();
    std::fs::write(d.path().join(".gitattributes"), "*.txt diff=custom\n").unwrap();
    commit(d.path(), "literal [search] message");
    git(
        d.path(),
        &["config", "diff.external", "gitty-must-never-execute-this"],
    );
    git(
        d.path(),
        &[
            "config",
            "diff.custom.textconv",
            "gitty-must-never-execute-this",
        ],
    );
    git(
        d.path(),
        &["config", "core.fsmonitor", "gitty-must-never-execute-this"],
    );
    std::fs::write(d.path().join("literal[1].txt"), "after\r\n").unwrap();
    let index = d.path().join(".git/index");
    let before = std::fs::read(&index).unwrap();
    let modified = std::fs::metadata(&index).unwrap().modified().unwrap();
    let data = tempfile::tempdir().unwrap();
    let mut service = Service::new(data.path().into());
    let state = open(&mut service, d.path());
    let repo = service.repo(&state.session.handle).unwrap();
    assert_eq!(repo.status().unwrap().entries.len(), 1);
    let patch = repo.diff(&DiffSpec::Unstaged, "literal[1].txt").unwrap();
    assert_eq!(patch.hunks[0].lines[0].content, "before\r");
    assert_eq!(patch.hunks[0].lines[1].content, "after\r");
    let search = repo
        .search(SearchQuery {
            text: "[search]".into(),
            branch: Some("main".into()),
            since: Some("2000-01-01".into()),
            until: Some("2099-01-01".into()),
            path: Some("literal[1].txt".into()),
        })
        .unwrap();
    assert_eq!(search.commits.len(), 1);
    assert!(!search.truncated);
    let search = repo
        .search(SearchQuery {
            text: "does not exist".into(),
            branch: None,
            since: None,
            until: None,
            path: None,
        })
        .unwrap();
    assert!(search.commits.is_empty());
    assert_eq!(std::fs::read(&index).unwrap(), before);
    assert_eq!(
        std::fs::metadata(index).unwrap().modified().unwrap(),
        modified
    );
    assert!(!d.path().join(".git/index.lock").exists());
}

#[test]
fn stale_handles_and_cursors_partial_clone_and_non_repositories_are_explicit() {
    let d = init();
    let data = tempfile::tempdir().unwrap();
    let mut service = Service::new(data.path().into());
    let state = open(&mut service, d.path());
    assert_eq!(
        service
            .repo(&state.session.handle)
            .unwrap()
            .history(Some("invented".into()), 1, HistoryQuery::default())
            .unwrap_err()
            .code,
        "staleCursor"
    );
    service.close(&state.session.handle).unwrap();
    assert!(service.repo(&state.session.handle).is_err());
    assert!(service
        .open(RepositoryLocation::Native {
            path: data.path().to_str().unwrap().into()
        })
        .is_err());
    git(d.path(), &["config", "remote.origin.promisor", "true"]);
    assert_eq!(
        service
            .open(RepositoryLocation::Native {
                path: d.path().to_str().unwrap().into()
            })
            .unwrap_err()
            .code,
        "unsupportedPartialClone"
    );
    #[cfg(not(windows))]
    assert_eq!(
        crate::wsl::distributions().unwrap_err().code,
        "unsupportedPlatform"
    );
}

#[test]
fn untracked_empty_binary_and_symlink_files() {
    let d = init();
    std::fs::write(d.path().join("empty"), "").unwrap();
    std::fs::write(d.path().join("binary"), [0, 1, 2]).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink("empty", d.path().join("link")).unwrap();
    let data = tempfile::tempdir().unwrap();
    let mut service = Service::new(data.path().into());
    let state = open(&mut service, d.path());
    let repo = service.repo(&state.session.handle).unwrap();
    let files = repo.diff_files(&DiffSpec::Untracked).unwrap();
    let empty = files.iter().find(|f| f.path == "empty").unwrap();
    assert!(!empty.binary);
    assert_eq!(empty.additions, Some(0));
    assert!(files.iter().find(|f| f.path == "binary").unwrap().binary);
    assert!(repo.diff(&DiffSpec::Untracked, "binary").unwrap().binary);
    assert!(repo
        .diff(&DiffSpec::Untracked, "empty")
        .unwrap()
        .hunks
        .is_empty());
    #[cfg(unix)]
    assert!(repo
        .diff(&DiffSpec::Untracked, "link")
        .unwrap()
        .message
        .unwrap()
        .contains("120000"));
}

#[test]
#[cfg(unix)]
fn repository_directory_with_trailing_newline_is_preserved() {
    let parent = tempfile::tempdir().unwrap();
    let path = parent.path().join("repository\n");
    std::fs::create_dir(&path).unwrap();
    git(&path, &["init", "-b", "main"]);
    let data = tempfile::tempdir().unwrap();
    let mut service = Service::new(data.path().into());
    let state = open(&mut service, &path);
    assert!(state.session.root.ends_with('\n'));
    assert_eq!(state.session.name, "repository\n");
}

#[test]
fn search_ors_all_text_fields_and_ands_structural_filters() {
    fn dated_commit(path: &Path, message: &str, name: &str, date: &str) -> String {
        git(path, &["add", "--all"]);
        let o = Command::new("git")
            .arg("-C")
            .arg(path)
            .args([
                "-c",
                &format!("user.name={name}"),
                "-c",
                "user.email=someone@example.org",
                "commit",
                "-m",
                message,
            ])
            .env("GIT_AUTHOR_DATE", date)
            .env("GIT_COMMITTER_DATE", date)
            .output()
            .unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        git(path, &["rev-parse", "HEAD"])
    }
    let d = init();
    std::fs::write(d.path().join("focus.txt"), "one\n").unwrap();
    let author_hit = dated_commit(
        d.path(),
        "ordinary root",
        "Cobalt Author",
        "2020-01-01T12:00:00Z",
    );
    std::fs::write(d.path().join("other.txt"), "other\n").unwrap();
    let message_hit = dated_commit(
        d.path(),
        "the cobalt message",
        "Different Person",
        "2021-01-01T12:00:00Z",
    );
    std::fs::write(d.path().join("focus.txt"), "two\n").unwrap();
    let ref_hit = dated_commit(
        d.path(),
        "ordinary tagged change",
        "Different Person",
        "2022-01-01T12:00:00Z",
    );
    git(
        d.path(),
        &[
            "tag",
            "-a",
            "CoBaLt-Release",
            "-m",
            "annotated release",
            &ref_hit,
        ],
    );
    git(d.path(), &["branch", "cobalt-alias", &ref_hit]);
    git(
        d.path(),
        &["update-ref", "refs/remotes/origin/cobalt-remote", &ref_hit],
    );
    std::fs::write(d.path().join("other.txt"), "later\n").unwrap();
    let tip = dated_commit(
        d.path(),
        "unrelated tip",
        "Different Person",
        "2023-01-01T12:00:00Z",
    );
    git(d.path(), &["checkout", "-b", "side", &author_hit]);
    std::fs::write(d.path().join("focus.txt"), "side\n").unwrap();
    let side = dated_commit(d.path(), "side work", "Cobalt Side", "2024-01-01T12:00:00Z");
    git(d.path(), &["checkout", "main"]);
    let data = tempfile::tempdir().unwrap();
    let mut service = Service::new(data.path().into());
    let state = open(&mut service, d.path());
    let repo = service.repo(&state.session.handle).unwrap();
    let query = |text: &str| SearchQuery {
        text: text.into(),
        branch: None,
        since: None,
        until: None,
        path: None,
    };
    let result = repo.search(query("COBALT")).unwrap();
    let actual: std::collections::HashSet<_> =
        result.commits.iter().map(|c| c.id.clone()).collect();
    assert_eq!(
        actual,
        [
            author_hit.clone(),
            message_hit.clone(),
            ref_hit.clone(),
            side.clone()
        ]
        .into_iter()
        .collect()
    );
    let result = repo
        .search(SearchQuery {
            text: "cobalt".into(),
            branch: Some("main".into()),
            since: Some("2021-06-01".into()),
            until: Some("2022-12-31".into()),
            path: Some("focus.txt".into()),
        })
        .unwrap();
    assert_eq!(result.commits.len(), 1);
    assert_eq!(result.commits[0].id, ref_hit);
    assert_eq!(result.commits[0].parents, vec![message_hit.clone()]);
    let refs = repo.search(query("cobalt-release")).unwrap();
    assert_eq!(refs.commits.len(), 1);
    assert_eq!(refs.commits[0].id, ref_hit);
    let remote = repo.search(query("refs/remotes/origin/cobalt")).unwrap();
    assert_eq!(remote.commits.len(), 1);
    assert_eq!(remote.commits[0].id, ref_hit);
    assert_eq!(
        repo.search(query("SOMEONE@EXAMPLE.ORG"))
            .unwrap()
            .commits
            .len(),
        5
    );
    assert_eq!(
        repo.search(query(&message_hit[..12].to_uppercase()))
            .unwrap()
            .commits[0]
            .id,
        message_hit
    );
    assert_eq!(repo.search(query(&tip)).unwrap().commits[0].id, tip);
    assert_eq!(repo.search(query("HEAD")).unwrap().commits[0].id, tip);
    let mut hash_filtered = query(&message_hit[..12]);
    hash_filtered.path = Some("focus.txt".into());
    assert!(repo.search(hash_filtered).unwrap().commits.is_empty());
    let mut branch_filtered = query("cobalt-release");
    branch_filtered.branch = Some("side".into());
    assert!(repo.search(branch_filtered).unwrap().commits.is_empty());
    let mut date_filtered = query(&tip);
    date_filtered.until = Some("2022-01-01".into());
    assert!(repo.search(date_filtered).unwrap().commits.is_empty());
}

#[test]
fn history_streams_more_than_one_hundred_thousand_commits_without_preloading() {
    use std::io::Write;
    use std::process::Stdio;
    let d = init();
    let mut child = Command::new("git")
        .arg("-C")
        .arg(d.path())
        .args(["fast-import", "--quiet"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    {
        let mut input = std::io::BufWriter::new(child.stdin.take().unwrap());
        for i in 0..100_005 {
            let message = format!("commit {i}\n");
            write!(
                input,
                "commit refs/heads/main\ncommitter Test <test@example.org> {} +0000\ndata {}\n{}\n",
                1_700_000_000 + i,
                message.len(),
                message
            )
            .unwrap();
        }
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let original_tip = git(d.path(), &["rev-parse", "HEAD"]);
    let expected = git(
        d.path(),
        &["rev-list", "--topo-order", "--skip=100000", &original_tip],
    );
    let expected: Vec<_> = expected.lines().map(String::from).collect();
    assert_eq!(expected.len(), 5);
    let data = tempfile::tempdir().unwrap();
    let mut service = Service::new(data.path().into());
    let state = open(&mut service, d.path());
    let repo = service.repo(&state.session.handle).unwrap();
    let started = std::time::Instant::now();
    let first = repo.history(None, 200, HistoryQuery::default()).unwrap();
    let first_elapsed = started.elapsed();
    assert_eq!(first.commits[0].id, original_tip);
    assert_eq!(first.commits.len(), 200);
    assert_eq!(
        repo.history.lock().unwrap().walks[&first.generation].cached_count,
        201
    );
    let started = std::time::Instant::now();
    let next = repo
        .history(first.cursor.clone(), 200, HistoryQuery::default())
        .unwrap();
    let next_elapsed = started.elapsed();
    assert_eq!(next.commits.len(), 200);
    assert_eq!(first.commits.last().unwrap().parents[0], next.commits[0].id);
    assert_eq!(
        repo.history.lock().unwrap().walks[&first.generation].cached_count,
        401
    );
    eprintln!("100,005-commit fixture (200/page): first={first_elapsed:?}, next={next_elapsed:?}");
    git(
        d.path(),
        &["update-ref", "refs/heads/main", expected.last().unwrap()],
    );
    let mut history = repo.history.lock().unwrap();
    let walk = history.walks.get_mut(&first.generation).unwrap();
    let (late, more) = walk.page(100_000, 3).unwrap();
    assert_eq!(late, expected[..3]);
    assert!(more);
    assert_eq!(walk.cached_count, 100_004);
    let (last, more) = walk.page(100_003, 3).unwrap();
    assert_eq!(last, expected[3..]);
    assert!(!more);
    drop(history);
    let replay = repo
        .history(first.cursor.clone(), 3, HistoryQuery::default())
        .unwrap();
    let replay_again = repo
        .history(first.cursor, 3, HistoryQuery::default())
        .unwrap();
    assert_eq!(
        replay.commits.iter().map(|c| &c.id).collect::<Vec<_>>(),
        replay_again
            .commits
            .iter()
            .map(|c| &c.id)
            .collect::<Vec<_>>()
    );
    assert_eq!(replay.cursor, replay_again.cursor);
}

#[test]
fn history_and_search_survive_ref_tips_exceeding_the_argv_limit() {
    use std::io::Write;
    use std::process::Stdio;
    // 1,200 distinct tips x 41 bytes is ~49 KB: more than Windows' ~32 KiB command line.
    const REFS: usize = 1_200;
    let d = init();
    let mut child = Command::new("git")
        .arg("-C")
        .arg(d.path())
        .args(["fast-import", "--quiet"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    {
        let mut input = std::io::BufWriter::new(child.stdin.take().unwrap());
        for i in 0..REFS {
            let message = format!("tip {i:04}\n");
            let content = format!("{i}\n");
            write!(
                input,
                "commit refs/heads/b{i}\ncommitter Test <test@example.org> {} +0000\ndata {}\n{}M 644 inline shared.txt\ndata {}\n{}\n",
                1_700_000_000 + i,
                message.len(),
                message,
                content.len(),
                content
            )
            .unwrap();
        }
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    git(d.path(), &["symbolic-ref", "HEAD", "refs/heads/b0"]);
    let data = tempfile::tempdir().unwrap();
    let mut service = Service::new(data.path().into());
    let state = open(&mut service, d.path());
    assert_eq!(state.refs.len(), REFS);
    let repo = service.repo(&state.session.handle).unwrap();
    let (tips, _) = repo.tips(None).unwrap();
    assert_eq!(tips.len(), REFS);
    assert!(tips.iter().map(|t| t.len() + 1).sum::<usize>() > 32 * 1024);

    let first = repo.history(None, 200, HistoryQuery::default()).unwrap();
    assert_eq!(first.commits.len(), 200);
    assert!(first.cursor.is_some());
    let next = repo
        .history(first.cursor.clone(), 200, HistoryQuery::default())
        .unwrap();
    assert_eq!(next.commits.len(), 200);
    let all: std::collections::HashSet<_> = first
        .commits
        .iter()
        .chain(&next.commits)
        .map(|c| &c.id)
        .collect();
    assert_eq!(all.len(), 400);

    let query = |text: &str, path: Option<&str>| SearchQuery {
        text: text.into(),
        branch: None,
        since: None,
        until: None,
        path: path.map(String::from),
    };
    let one = repo.search(query("tip 0777", None)).unwrap();
    assert_eq!(one.commits.len(), 1);
    assert!(!one.truncated);
    let last = repo.search(query("tip 1199", None)).unwrap();
    assert_eq!(last.commits.len(), 1);
    assert!(!last.truncated);
    // `--stdin` revisions combine with a pathspec after `--`.
    let pathed = repo.search(query("tip 0042", Some("shared.txt"))).unwrap();
    assert_eq!(pathed.commits.len(), 1);
    let none = repo.search(query("tip 0042", Some("missing.txt"))).unwrap();
    assert!(none.commits.is_empty());
}

fn store_commit(path: &Path, bytes: &[u8]) -> String {
    use std::io::Write;
    use std::process::Stdio;
    let mut child = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["hash-object", "-t", "commit", "-w", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(bytes).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim_end().into()
}

#[test]
fn batched_history_preserves_topology_unicode_large_bodies_and_detail_parity() {
    let d = init();
    let tree = git(d.path(), &["hash-object", "-t", "tree", "-w", "--stdin"]);
    let make = |parents: &[&str], subject: &str| {
        let parents = parents
            .iter()
            .map(|p| format!("parent {p}\n"))
            .collect::<String>();
        let body = format!(
            "{subject}\n\n{}\nno trailing newline",
            "工作 🦀\n".repeat(10_000)
        );
        let committer_date = match subject {
            "Røøt" => 1_700_000_001,
            "Left 🦀" => 1_700_000_003,
            "Right 工作" => 1_700_000_004,
            "Merge é" => 1_700_000_002,
            _ => unreachable!(),
        };
        let raw = format!("tree {tree}\n{parents}author Zoë 工作 <zoe@example.org> 1700000000 +1245\ncommitter Test <test@example.org> {committer_date} +0000\n\n{body}");
        (store_commit(d.path(), raw.as_bytes()), body)
    };
    let root = make(&[], "Røøt");
    let left = make(&[&root.0], "Left 🦀");
    let right = make(&[&root.0], "Right 工作");
    let merge = make(&[&left.0, &right.0], "Merge é");
    git(d.path(), &["update-ref", "refs/heads/main", &merge.0]);
    let expected = git(d.path(), &["rev-list", "--date-order", "HEAD"]);
    let data = tempfile::tempdir().unwrap();
    let mut service = Service::new(data.path().into());
    let state = open(&mut service, d.path());
    let repo = service.repo(&state.session.handle).unwrap();
    let page = repo.history(None, 200, HistoryQuery::default()).unwrap();
    assert_eq!(
        page.commits
            .iter()
            .map(|c| c.id.as_str())
            .collect::<Vec<_>>(),
        expected.lines().collect::<Vec<_>>()
    );
    assert_eq!(
        page.commits[0].parents,
        vec![left.0.clone(), right.0.clone()]
    );
    assert!(
        page.commits.iter().position(|c| c.id == right.0).unwrap()
            < page.commits.iter().position(|c| c.id == left.0).unwrap(),
        "newer committer date should order the right branch first"
    );
    assert!(page.cursor.is_none());
    for (id, body) in [root, left, right, merge] {
        let detail = repo.commit(&id).unwrap();
        assert_eq!(detail.body, body);
        let summary = page.commits.iter().find(|c| c.id == id).unwrap();
        assert_eq!(
            serde_json::to_value(summary).unwrap(),
            serde_json::to_value(detail.summary).unwrap()
        );
    }
    // A successful cat-file exit can still contain missing objects or wrong types.
    assert_eq!(
        crate::commit::batch(repo.location(), &["0".repeat(40)])
            .unwrap_err()
            .code,
        "git"
    );
    assert_eq!(
        crate::commit::batch(repo.location(), &[tree])
            .unwrap_err()
            .code,
        "gitParse"
    );
}

#[test]
fn batched_history_rejects_non_utf8_commit_metadata_without_lossy_conversion() {
    let d = init();
    let tree = git(d.path(), &["hash-object", "-t", "tree", "-w", "--stdin"]);
    let mut raw = format!("tree {tree}\nauthor Test <test@example.org> 1700000000 +0000\ncommitter Test <test@example.org> 1700000000 +0000\nencoding ISO-8859-1\n\nsubject ").into_bytes();
    raw.push(0xe9);
    let id = store_commit(d.path(), &raw);
    git(d.path(), &["update-ref", "refs/heads/main", &id]);
    let data = tempfile::tempdir().unwrap();
    let mut service = Service::new(data.path().into());
    let state = open(&mut service, d.path());
    let repo = service.repo(&state.session.handle).unwrap();
    assert_eq!(
        repo.history(None, 200, HistoryQuery::default())
            .unwrap_err()
            .code,
        "unsupportedEncoding"
    );
    assert_eq!(repo.commit(&id).unwrap_err().code, "unsupportedEncoding");
}

#[test]
fn commit_batch_enforces_aggregate_output_limit() {
    let d = init();
    let tree = git(d.path(), &["hash-object", "-t", "tree", "-w", "--stdin"]);
    let mut ids = Vec::new();
    for subject in ["first", "second"] {
        let raw = format!("tree {tree}\nauthor Test <test@example.org> 1700000000 +0000\ncommitter Test <test@example.org> 1700000000 +0000\n\n{subject}\n\n{}", "x".repeat(17 * 1024 * 1024));
        ids.push(store_commit(d.path(), raw.as_bytes()));
    }
    let location = RepositoryLocation::Native {
        path: d.path().to_str().unwrap().into(),
    };
    assert_eq!(
        crate::commit::batch(&location, &ids).unwrap_err().code,
        "outputLimit"
    );
}

#[test]
fn protected_global_safe_directory_and_system_config_are_honored() {
    use crate::process::{self, args};
    let d = init();
    let home = tempfile::tempdir().unwrap();
    let ignored = home.path().join("ignore");
    std::fs::write(&ignored, "ignored.txt\n").unwrap();
    std::fs::write(d.path().join("ignored.txt"), "ignored\n").unwrap();
    let global = home.path().join(".gitconfig");
    std::fs::write(&global, format!("[safe]\n directory = {}\n[core]\n excludesFile = {}\n fsmonitor = gitty-must-never-execute-this\n", d.path().display(), ignored.display())).unwrap();
    let system = home.path().join("system.gitconfig");
    std::fs::write(&system, "[gitty]\n marker = system-config-is-read\n").unwrap();
    let location = RepositoryLocation::Native {
        path: d.path().to_str().unwrap().into(),
    };
    let configured = |a: &[&str]| {
        let mut command = process::git_command(&location, &args(a)).unwrap();
        command
            .env("HOME", home.path())
            .env("XDG_CONFIG_HOME", home.path().join("xdg"))
            .env("GIT_CONFIG_GLOBAL", &global)
            .env("GIT_CONFIG_SYSTEM", &system)
            .env_remove("GIT_CONFIG_NOSYSTEM")
            .env("GIT_TEST_ASSUME_DIFFERENT_OWNER", "1");
        command
    };
    let output = process::run(configured(&["status", "--porcelain=v2", "-z"])).unwrap();
    assert!(
        output.success,
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.is_empty());
    let output = process::run(configured(&["config", "--get", "gitty.marker"])).unwrap();
    assert!(output.success);
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        "system-config-is-read"
    );
    std::fs::write(&global, "[core]\n fsmonitor = false\n").unwrap();
    let rejected = process::run(configured(&["status", "--porcelain=v2", "-z"])).unwrap();
    assert!(!rejected.success);
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("dubious ownership"));
}

#[test]
fn search_date_filter_does_not_prune_newer_ancestors() {
    let d = init();
    for (message, date) in [
        ("future ancestor", "2024-01-01T12:00:00Z"),
        ("older tip", "2020-01-01T12:00:00Z"),
    ] {
        let output = Command::new("git")
            .arg("-C")
            .arg(d.path())
            .args(["commit", "--allow-empty", "-m", message])
            .env("GIT_AUTHOR_DATE", date)
            .env("GIT_COMMITTER_DATE", date)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let data = tempfile::tempdir().unwrap();
    let mut service = Service::new(data.path().into());
    let state = open(&mut service, d.path());
    let result = service
        .repo(&state.session.handle)
        .unwrap()
        .search(SearchQuery {
            text: "future".into(),
            branch: Some("main".into()),
            since: Some("2023-01-01".into()),
            until: None,
            path: None,
        })
        .unwrap();
    assert_eq!(result.commits.len(), 1);
    assert_eq!(result.commits[0].subject, "future ancestor");
    assert_eq!(result.commits[0].timestamp, 1_704_110_400);
    let repo = service.repo(&state.session.handle).unwrap();
    let detail = repo.commit(&result.commits[0].id).unwrap();
    let json = serde_json::to_value(&detail).unwrap();
    assert_eq!(json["timestamp"], 1_704_110_400i64);
    assert!(
        json.get("summary").is_none(),
        "CommitDetail must be flattened"
    );
    let history = repo.history(None, 2, HistoryQuery::default()).unwrap();
    assert_eq!(history.commits[1].timestamp, detail.summary.timestamp);
}

#[test]
fn refresh_fingerprints_detect_repeated_content_edits_and_remote_changes() {
    let d = init();
    let tracked = d.path().join("tracked");
    let untracked = d.path().join("untracked");
    std::fs::write(&tracked, "base\n").unwrap();
    commit(d.path(), "base");
    let data = tempfile::tempdir().unwrap();
    let mut service = Service::new(data.path().into());
    let initial = open(&mut service, d.path());
    let repo = service.repo(&initial.session.handle).unwrap();
    let clean = repo.status().unwrap().fingerprint;
    assert_eq!(clean, repo.status().unwrap().fingerprint);
    std::fs::write(&tracked, "aaaa\n").unwrap();
    let dirty = repo.status().unwrap().fingerprint;
    assert_ne!(clean, dirty);
    let modified = std::fs::metadata(&tracked).unwrap().modified().unwrap();
    std::fs::write(&tracked, "bbbb\n").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&tracked)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
    assert_ne!(dirty, repo.status().unwrap().fingerprint);
    // Stage new content twice without changing porcelain's XY status.
    git(d.path(), &["add", "tracked"]);
    let staged = repo.status().unwrap().fingerprint;
    std::fs::write(&tracked, "cccc\n").unwrap();
    git(d.path(), &["add", "tracked"]);
    assert_ne!(staged, repo.status().unwrap().fingerprint);
    std::fs::write(&untracked, [0, 1, 2, 3]).unwrap();
    let first = repo.status().unwrap().fingerprint;
    assert_eq!(first, repo.status().unwrap().fingerprint);
    std::fs::write(&untracked, [0, 3, 2, 1]).unwrap();
    assert_ne!(first, repo.status().unwrap().fingerprint);
    std::fs::remove_file(&untracked).unwrap();
    let deleted = repo.status().unwrap().fingerprint;
    std::fs::write(&untracked, "").unwrap();
    assert_ne!(deleted, repo.status().unwrap().fingerprint);
    // Working edits must not unnecessarily invalidate pinned history generations.
    assert_eq!(initial.fingerprint, repo.state().unwrap().fingerprint);
    git(
        d.path(),
        &[
            "remote",
            "add",
            "origin",
            "https://example.invalid/repo.git",
        ],
    );
    let remote = repo.state().unwrap();
    assert_ne!(initial.fingerprint, remote.fingerprint);
    assert_eq!(remote.remotes, vec!["origin"]);
    git(d.path(), &["remote", "remove", "origin"]);
    assert_eq!(initial.fingerprint, repo.state().unwrap().fingerprint);
    let nested = d.path().join("nested");
    std::fs::create_dir(&nested).unwrap();
    git(&nested, &["init", "-b", "main"]);
    std::fs::write(nested.join("file"), "nested contents").unwrap();
    assert!(repo
        .status()
        .unwrap()
        .entries
        .iter()
        .any(|e| e.path == "nested/"));
}

#[test]
fn shallow_deepening_without_ref_movement_invalidates_state() {
    let source = init();
    for message in ["root", "middle", "tip"] {
        git(source.path(), &["commit", "--allow-empty", "-m", message]);
    }
    let destination = tempfile::tempdir().unwrap();
    let path = destination.path().join("shallow");
    git(
        destination.path(),
        &[
            "clone",
            "--depth=1",
            &format!("file://{}", source.path().display()),
            path.to_str().unwrap(),
        ],
    );
    let data = tempfile::tempdir().unwrap();
    let mut service = Service::new(data.path().into());
    let before = open(&mut service, &path);
    let repo = service.repo(&before.session.handle).unwrap();
    assert_eq!(
        repo.history(None, 10, HistoryQuery::default())
            .unwrap()
            .commits
            .len(),
        1
    );
    git(&path, &["fetch", "--deepen=1"]);
    let after = repo.state().unwrap();
    assert!(before.session.shallow && after.session.shallow);
    assert_eq!(before.session.head, after.session.head);
    assert_ne!(before.fingerprint, after.fingerprint);
    assert_eq!(
        repo.history(None, 10, HistoryQuery::default())
            .unwrap()
            .commits
            .len(),
        2
    );
}

#[test]
fn concurrent_opens_preserve_recent_entries_and_cursor_replays() {
    use std::sync::Arc;
    let repos: Vec<_> = (0..3).map(|_| init()).collect();
    git(repos[0].path(), &["commit", "--allow-empty", "-m", "root"]);
    git(repos[0].path(), &["commit", "--allow-empty", "-m", "tip"]);
    let data = tempfile::tempdir().unwrap();
    let service = Arc::new(Service::new(data.path().into()));
    let workers: Vec<_> = repos
        .iter()
        .map(|d| {
            let service = service.clone();
            let location = RepositoryLocation::Native {
                path: d.path().to_str().unwrap().into(),
            };
            std::thread::spawn(move || service.open(location).unwrap())
        })
        .collect();
    let states: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
    let recent = service.recent().unwrap();
    assert_eq!(recent.len(), states.len());
    for state in &states {
        assert!(recent.contains(&state.session.location));
    }
    let repo = service.repo(&states[0].session.handle).unwrap();
    let first = repo.history(None, 1, HistoryQuery::default()).unwrap();
    let workers: Vec<_> = (0..4)
        .map(|_| {
            let repo = repo.clone();
            let cursor = first.cursor.clone();
            std::thread::spawn(move || repo.history(cursor, 1, HistoryQuery::default()).unwrap())
        })
        .collect();
    for worker in workers {
        let page = worker.join().unwrap();
        assert_eq!(page.generation, first.generation);
        assert_eq!(page.commits.len(), 1);
        assert_eq!(page.commits[0].subject, "root");
        assert!(page.cursor.is_none());
    }
}

#[test]
fn blocked_walk_does_not_block_reads_other_sessions_or_close() {
    use std::sync::{mpsc, Arc};
    use std::time::Duration;
    let d = init();
    git(d.path(), &["commit", "--allow-empty", "-m", "root"]);
    let other = init();
    let data = tempfile::tempdir().unwrap();
    let service = Arc::new(Service::new(data.path().into()));
    let location = |path: &Path| RepositoryLocation::Native {
        path: path.to_str().unwrap().into(),
    };
    let first = service.open(location(d.path())).unwrap();
    let second = service.open(location(other.path())).unwrap();
    let repo = service.repo(&first.session.handle).unwrap();
    let guard = repo.history.lock().unwrap();
    let pending = repo.clone();
    let (waiting_tx, waiting_rx) = mpsc::channel();
    let walk = std::thread::spawn(move || {
        waiting_tx.send(()).unwrap();
        pending.history(None, 1, HistoryQuery::default())
    });
    waiting_rx.recv().unwrap();
    let worker_service = service.clone();
    let handle = first.session.handle.clone();
    let (done_tx, done_rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        let result = (|| -> Result<()> {
            let r = worker_service.repo(&handle)?;
            r.status()?;
            r.state()?;
            r.commit("HEAD")?;
            r.search(SearchQuery {
                text: "root".into(),
                branch: None,
                since: None,
                until: None,
                path: None,
            })?;
            worker_service.repo(&second.session.handle)?.history(
                None,
                1,
                HistoryQuery::default(),
            )?;
            worker_service.close(&handle)?;
            assert!(worker_service.repo(&handle).is_err());
            worker_service.close(&second.session.handle)?;
            Ok(())
        })();
        done_tx.send(result).unwrap();
    });
    let completed = done_rx.recv_timeout(Duration::from_secs(10));
    drop(guard); // Always release on failure so the test cannot leave blocked workers.
    reader.join().unwrap();
    assert!(
        walk.join().unwrap().is_ok(),
        "An acquired request may finish after close"
    );
    completed
        .expect("Independent requests waited for the history lock")
        .unwrap();
    assert!(service.repo(&first.session.handle).is_err());
}

#[test]
#[cfg(target_os = "linux")]
fn non_utf8_paths_report_unsupported_without_lossy_aliasing() {
    use std::os::unix::ffi::OsStringExt;
    let d = init();
    std::fs::write(
        d.path()
            .join(std::ffi::OsString::from_vec(vec![b'x', 0xff])),
        b"hello",
    )
    .unwrap();
    let data = tempfile::tempdir().unwrap();
    let mut service = Service::new(data.path().into());
    let state = open(&mut service, d.path());
    assert_eq!(
        service
            .repo(&state.session.handle)
            .unwrap()
            .status()
            .unwrap_err()
            .code,
        "unsupportedEncoding"
    );
}

// ---------------------------------------------------------------------------
// Staging, unstaging and committing. Every case runs against a real repository.
// ---------------------------------------------------------------------------

fn paths(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| s.to_string()).collect()
}
fn tracked_files(path: &Path) -> Vec<String> {
    git(path, &["ls-tree", "-r", "--name-only", "-z", "HEAD"])
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}
fn service_for(repository: &Path) -> (Service, TempDir, String) {
    let data = tempfile::tempdir().unwrap();
    let mut service = Service::new(data.path().into());
    let handle = open(&mut service, repository).session.handle;
    (service, data, handle)
}

#[test]
fn unborn_stage_unstage_and_initial_commit_keep_unusual_names_literal() {
    let d = init();
    std::fs::create_dir(d.path().join("sub dir")).unwrap();
    let names = [
        "plain.txt",
        "-dash file.txt",
        "star*[a-b]?.txt",
        "úñí çodé 工作.txt",
        "sub dir/nested\tfile.txt",
    ];
    for name in names {
        std::fs::write(d.path().join(name), format!("{name}\n")).unwrap();
    }
    let (service, _data, handle) = service_for(d.path());
    let repo = service.repo(&handle).unwrap();
    // Explicit paths only: an empty request is never "everything".
    assert_eq!(
        service.stage(&handle, &[]).unwrap_err().code,
        "invalidRequest"
    );
    assert_eq!(
        service.unstage(&handle, &[]).unwrap_err().code,
        "invalidRequest"
    );
    for rejected in ["../outside", "/etc/passwd", "sub dir/../../escape", "."] {
        assert_eq!(
            service
                .stage(&handle, &paths(&[rejected]))
                .unwrap_err()
                .code,
            "invalidPath",
            "{rejected:?} must not reach Git"
        );
    }
    assert_eq!(
        service.create_commit(&handle, " \n\t ").unwrap_err().code,
        "invalidRequest"
    );
    assert_eq!(
        service
            .create_commit(&handle, "nothing yet")
            .unwrap_err()
            .code,
        "nothingStaged"
    );
    service.stage(&handle, &paths(&names)).unwrap();
    let status = repo.status().unwrap();
    assert_eq!(status.entries.len(), names.len());
    assert!(status.entries.iter().all(|e| e.index_status == "A"));
    // Unstaging on an unborn branch empties the index entry again.
    service
        .unstage(&handle, &paths(&["star*[a-b]?.txt"]))
        .unwrap();
    let status = repo.status().unwrap();
    assert!(status
        .entries
        .iter()
        .any(|e| e.path == "star*[a-b]?.txt" && e.untracked));
    assert_eq!(
        status
            .entries
            .iter()
            .filter(|e| e.index_status == "A")
            .count(),
        names.len() - 1
    );
    assert!(d.path().join("star*[a-b]?.txt").exists());
    let created = service
        .create_commit(&handle, "initial commit\n\nwith a body")
        .unwrap();
    assert_eq!(created.oid, git(d.path(), &["rev-parse", "HEAD"]));
    assert_eq!(
        serde_json::to_value(&created).unwrap(),
        serde_json::json!({ "oid": created.oid })
    );
    let detail = repo.commit(&created.oid).unwrap();
    assert_eq!(detail.summary.subject, "initial commit");
    assert_eq!(detail.body, "initial commit\n\nwith a body\n");
    assert!(detail.summary.parents.is_empty());
    let mut committed = tracked_files(d.path());
    committed.sort();
    let mut expected: Vec<String> = names
        .iter()
        .filter(|n| **n != "star*[a-b]?.txt")
        .map(|s| s.to_string())
        .collect();
    expected.sort();
    assert_eq!(committed, expected);
    assert_eq!(
        repo.state().unwrap().session.head.as_deref(),
        Some(created.oid.as_str())
    );
}

#[test]
fn partially_staged_and_removed_files_commit_only_the_index() {
    let d = init();
    std::fs::write(d.path().join("tracked.txt"), "one\n").unwrap();
    std::fs::write(d.path().join("removed.txt"), "gone\n").unwrap();
    commit(d.path(), "root");
    let (service, _data, handle) = service_for(d.path());
    let repo = service.repo(&handle).unwrap();
    std::fs::write(d.path().join("tracked.txt"), "two\n").unwrap();
    service.stage(&handle, &paths(&["tracked.txt"])).unwrap();
    std::fs::write(d.path().join("tracked.txt"), "three\n").unwrap();
    std::fs::remove_file(d.path().join("removed.txt")).unwrap();
    service.stage(&handle, &paths(&["removed.txt"])).unwrap();
    let status = repo.status().unwrap();
    let tracked = status
        .entries
        .iter()
        .find(|e| e.path == "tracked.txt")
        .unwrap();
    assert_eq!(
        (
            tracked.index_status.as_str(),
            tracked.worktree_status.as_str()
        ),
        ("M", "M")
    );
    assert_eq!(
        status
            .entries
            .iter()
            .find(|e| e.path == "removed.txt")
            .unwrap()
            .index_status,
        "D"
    );
    let created = service.create_commit(&handle, "staged only").unwrap();
    assert_eq!(
        git(d.path(), &["show", &format!("{}:tracked.txt", created.oid)]),
        "two"
    );
    assert_eq!(
        std::fs::read_to_string(d.path().join("tracked.txt")).unwrap(),
        "three\n"
    );
    assert_eq!(tracked_files(d.path()), vec!["tracked.txt"]);
    // The unstaged edit survives the commit untouched.
    let status = repo.status().unwrap();
    assert_eq!(status.entries.len(), 1);
    assert_eq!(status.entries[0].worktree_status, "M");
    assert_eq!(status.entries[0].index_status, ".");
    // Unstaging a partially staged file restores the index from HEAD only.
    service.stage(&handle, &paths(&["tracked.txt"])).unwrap();
    std::fs::write(d.path().join("tracked.txt"), "five\n").unwrap();
    service.unstage(&handle, &paths(&["tracked.txt"])).unwrap();
    assert_eq!(git(d.path(), &["show", ":tracked.txt"]), "two");
    assert_eq!(
        std::fs::read_to_string(d.path().join("tracked.txt")).unwrap(),
        "five\n"
    );
    // Unstaging a staged deletion leaves the file deleted in the working tree.
    service.stage(&handle, &paths(&["tracked.txt"])).unwrap();
    std::fs::remove_file(d.path().join("tracked.txt")).unwrap();
    service.stage(&handle, &paths(&["tracked.txt"])).unwrap();
    service.unstage(&handle, &paths(&["tracked.txt"])).unwrap();
    assert!(!d.path().join("tracked.txt").exists());
    assert_eq!(git(d.path(), &["show", ":tracked.txt"]), "two");
    let status = repo.status().unwrap();
    assert_eq!(status.entries[0].worktree_status, "D");
    assert_eq!(status.entries[0].index_status, ".");
}

#[test]
fn amend_supports_message_only_and_staged_changes_without_committing_unstaged_content() {
    let d = init();
    std::fs::write(d.path().join("file"), "one\n").unwrap();
    let parent = commit(d.path(), "base");
    std::fs::write(d.path().join("file"), "original\n").unwrap();
    let original = commit(d.path(), "original message");
    let original_tree = git(d.path(), &["rev-parse", "HEAD^{tree}"]);
    let (service, _data, handle) = service_for(d.path());
    let repo = service.repo(&handle).unwrap();

    let status = repo.status().unwrap();
    let reworded = service
        .amend_commit(
            &handle,
            "reworded message\n\nwith context",
            &original,
            status.head_ref.as_deref(),
            &status.fingerprint,
        )
        .unwrap();
    assert_eq!(git(d.path(), &["rev-parse", "HEAD^"]), parent);
    assert_eq!(git(d.path(), &["rev-parse", "HEAD^{tree}"]), original_tree);
    assert_eq!(
        repo.commit(&reworded.oid).unwrap().summary.subject,
        "reworded message"
    );

    std::fs::write(d.path().join("file"), "staged\n").unwrap();
    service.stage(&handle, &paths(&["file"])).unwrap();
    std::fs::write(d.path().join("file"), "unstaged\n").unwrap();
    let status = repo.status().unwrap();
    let amended = service
        .amend_commit(
            &handle,
            "staged amendment",
            &reworded.oid,
            status.head_ref.as_deref(),
            &status.fingerprint,
        )
        .unwrap();
    assert_eq!(
        git(d.path(), &["show", &format!("{}:file", amended.oid)]),
        "staged"
    );
    assert_eq!(
        std::fs::read_to_string(d.path().join("file")).unwrap(),
        "unstaged\n"
    );
    assert_eq!(repo.status().unwrap().entries[0].worktree_status, "M");
}

#[test]
fn selected_commit_profile_only_overrides_commit_identity_and_amend_preserves_author() {
    let d = init();
    let (service, _data, handle) = service_for(d.path());
    let repo = service.repo(&handle).unwrap();
    let selected = CommitIdentity {
        name: "Zoë Selected".into(),
        email: "zoe@example.org".into(),
    };
    std::fs::write(d.path().join("first"), "first").unwrap();
    service.stage(&handle, &paths(&["first"])).unwrap();
    let first = service
        .create_commit_with_identity(&handle, "selected", Some(&selected))
        .unwrap();
    assert_eq!(
        git(
            d.path(),
            &["show", "-s", "--format=%an <%ae>|%cn <%ce>", &first.oid]
        ),
        "Zoë Selected <zoe@example.org>|Zoë Selected <zoe@example.org>"
    );
    assert_eq!(git(d.path(), &["config", "user.name"]), "Test Author");
    assert_eq!(git(d.path(), &["config", "user.email"]), "test@example.com");

    let status = repo.status().unwrap();
    let committer = CommitIdentity {
        name: "Other Committer".into(),
        email: "other@example.org".into(),
    };
    let amended = service
        .amend_commit_with_identity(
            &handle,
            "amended",
            Some(&committer),
            &first.oid,
            status.head_ref.as_deref(),
            &status.fingerprint,
            AmendOptions::default(),
        )
        .unwrap();
    assert_eq!(
        git(
            d.path(),
            &["show", "-s", "--format=%an <%ae>|%cn <%ce>", &amended.oid]
        ),
        "Zoë Selected <zoe@example.org>|Other Committer <other@example.org>"
    );

    std::fs::write(d.path().join("second"), "second").unwrap();
    service.stage(&handle, &paths(&["second"])).unwrap();
    let configured = service.create_commit(&handle, "configured").unwrap();
    assert_eq!(
        git(
            d.path(),
            &[
                "show",
                "-s",
                "--format=%an <%ae>|%cn <%ce>",
                &configured.oid
            ]
        ),
        "Test Author <test@example.com>|Test Author <test@example.com>"
    );

    std::fs::write(d.path().join("third"), "third").unwrap();
    service.stage(&handle, &paths(&["third"])).unwrap();
    for invalid in [
        CommitIdentity {
            name: "bad\nname".into(),
            email: "valid@example.org".into(),
        },
        CommitIdentity {
            name: "Valid".into(),
            email: "bad>\nGIT_CONFIG_COUNT=1@example.org".into(),
        },
    ] {
        assert_eq!(
            service
                .create_commit_with_identity(&handle, "rejected", Some(&invalid))
                .unwrap_err()
                .code,
            "invalidRequest"
        );
        assert_eq!(git(d.path(), &["rev-parse", "HEAD"]), configured.oid);
    }
}

#[test]
fn amend_revalidates_head_symbolic_ref_and_status_under_the_mutation_lock() {
    let d = init();
    std::fs::write(d.path().join("file"), "one\n").unwrap();
    let head = commit(d.path(), "original");
    let (service, _data, handle) = service_for(d.path());
    let repo = service.repo(&handle).unwrap();
    let status = repo.status().unwrap();

    std::fs::write(d.path().join("file"), "changed after review\n").unwrap();
    assert_eq!(
        service
            .amend_commit(
                &handle,
                "must be stale",
                &head,
                status.head_ref.as_deref(),
                &status.fingerprint,
            )
            .unwrap_err()
            .code,
        "staleOperation"
    );
    assert_eq!(git(d.path(), &["rev-parse", "HEAD"]), head);

    git(d.path(), &["restore", "file"]);
    let status = repo.status().unwrap();
    git(d.path(), &["checkout", "--detach"]);
    assert_eq!(
        service
            .amend_commit(
                &handle,
                "wrong ref",
                &head,
                status.head_ref.as_deref(),
                &status.fingerprint,
            )
            .unwrap_err()
            .code,
        "staleOperation"
    );
    git(d.path(), &["checkout", "main"]);

    let status = repo.status().unwrap();
    std::fs::write(d.path().join("other"), "new\n").unwrap();
    let moved = commit(d.path(), "external commit");
    assert_eq!(
        service
            .amend_commit(
                &handle,
                "wrong head",
                &head,
                status.head_ref.as_deref(),
                &status.fingerprint,
            )
            .unwrap_err()
            .code,
        "staleOperation"
    );
    assert_eq!(git(d.path(), &["rev-parse", "HEAD"]), moved);

    let unborn = init();
    let (service, _data, handle) = service_for(unborn.path());
    let status = service.repo(&handle).unwrap().status().unwrap();
    assert_eq!(
        service
            .amend_commit(
                &handle,
                "no commit",
                "missing",
                status.head_ref.as_deref(),
                &status.fingerprint,
            )
            .unwrap_err()
            .code,
        "unresolvedHead"
    );
}

#[test]
#[cfg(unix)]
fn amend_honors_hooks_and_signing_configuration() {
    use std::os::unix::fs::PermissionsExt;
    let d = init();
    std::fs::write(d.path().join("file"), "one\n").unwrap();
    let head = commit(d.path(), "original");
    let (service, _data, handle) = service_for(d.path());
    let repo = service.repo(&handle).unwrap();
    let hook = d.path().join(".git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\necho 'amend hook refusal' >&2\nexit 1\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let status = repo.status().unwrap();
    let error = service
        .amend_commit(
            &handle,
            "blocked",
            &head,
            status.head_ref.as_deref(),
            &status.fingerprint,
        )
        .unwrap_err();
    assert_eq!(error.code, "git");
    assert!(error.message.contains("amend hook refusal"));
    assert_eq!(git(d.path(), &["rev-parse", "HEAD"]), head);

    std::fs::remove_file(&hook).unwrap();
    git(d.path(), &["config", "commit.gpgsign", "true"]);
    git(
        d.path(),
        &["config", "gpg.program", "/nonexistent/gitty-signer"],
    );
    let status = repo.status().unwrap();
    assert_eq!(
        service
            .amend_commit(
                &handle,
                "unsigned",
                &head,
                status.head_ref.as_deref(),
                &status.fingerprint,
            )
            .unwrap_err()
            .code,
        "git"
    );
    assert_eq!(git(d.path(), &["rev-parse", "HEAD"]), head);
}

fn amend_with(
    service: &Service,
    handle: &str,
    message: &str,
    expected_head: &str,
    options: AmendOptions,
) -> Result<CreatedCommit> {
    let status = service.repo(handle).unwrap().status().unwrap();
    service.amend_commit_with_identity(
        handle,
        message,
        None,
        expected_head,
        status.head_ref.as_deref(),
        &status.fingerprint,
        options,
    )
}
const MESSAGE_ONLY: AmendOptions = AmendOptions {
    message_only: true,
    require_unpushed: false,
};
/// Runs Git where failure is the point of the test (a conflicting stash pop).
fn git_may_fail(path: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .output()
        .unwrap()
        .status
        .success()
}

#[test]
fn message_only_amend_ignores_the_index_while_the_default_amend_folds_it_in() {
    let d = init();
    std::fs::write(d.path().join("a"), "1\n2\n3\n").unwrap();
    std::fs::write(d.path().join("b"), "b0\n").unwrap();
    commit(d.path(), "base");
    std::fs::write(d.path().join("c"), "c\n").unwrap();
    let original = commit(d.path(), "original");
    let original_tree = git(d.path(), &["rev-parse", "HEAD^{tree}"]);
    let (service, _data, handle) = service_for(d.path());

    // Fully staged (b), partially staged (a), unstaged-only (c) and untracked (new).
    std::fs::write(d.path().join("b"), "staged\n").unwrap();
    git(d.path(), &["add", "b"]);
    std::fs::write(d.path().join("a"), "1\n2x\n3\n").unwrap();
    git(d.path(), &["add", "a"]);
    std::fs::write(d.path().join("a"), "1\n2x\n3y\n").unwrap();
    std::fs::write(d.path().join("c"), "c edited\n").unwrap();
    std::fs::write(d.path().join("new"), "untracked\n").unwrap();
    let snapshot = |d: &Path| {
        (
            git(d, &["ls-files", "--stage"]),
            git(d, &["diff", "--cached"]),
            git(d, &["diff"]),
            git(d, &["status", "--porcelain=v1"]),
            ["a", "b", "c", "new"].map(|f| std::fs::read(d.join(f)).unwrap()),
        )
    };
    let before = snapshot(d.path());

    let reworded = amend_with(
        &service,
        &handle,
        "only the message",
        &original,
        MESSAGE_ONLY,
    )
    .unwrap();
    assert_ne!(reworded.oid, original);
    assert_eq!(git(d.path(), &["rev-parse", "HEAD"]), reworded.oid);
    assert_eq!(git(d.path(), &["rev-parse", "HEAD^{tree}"]), original_tree);
    assert_eq!(
        git(d.path(), &["log", "-1", "--format=%s"]),
        "only the message"
    );
    assert_eq!(
        git(d.path(), &["rev-parse", "HEAD^"]),
        git(d.path(), &["rev-parse", &format!("{original}^")])
    );
    assert_eq!(
        snapshot(d.path()),
        before,
        "index and worktree must be untouched"
    );
    assert!(!d.path().join(".git/index.lock").exists());

    // Default semantics are unchanged: the staged index is folded into the commit,
    // while the unstaged remainder stays in the working tree.
    let folded = amend_with(
        &service,
        &handle,
        "with the index",
        &reworded.oid,
        AmendOptions::default(),
    )
    .unwrap();
    assert_eq!(
        git(d.path(), &["show", &format!("{}:b", folded.oid)]),
        "staged"
    );
    assert_eq!(
        git(d.path(), &["show", &format!("{}:a", folded.oid)]),
        "1\n2x\n3"
    );
    assert_eq!(git(d.path(), &["show", &format!("{}:c", folded.oid)]), "c");
    assert_eq!(
        std::fs::read_to_string(d.path().join("a")).unwrap(),
        "1\n2x\n3y\n"
    );
    assert_eq!(
        std::fs::read_to_string(d.path().join("new")).unwrap(),
        "untracked\n"
    );
}

#[test]
fn require_unpushed_is_independent_and_rechecks_remote_refs_added_after_the_read() {
    let d = init();
    std::fs::write(d.path().join("file"), "base\n").unwrap();
    let base = commit(d.path(), "base");
    std::fs::write(d.path().join("file"), "next\n").unwrap();
    let head = commit(d.path(), "next");
    let (service, _data, handle) = service_for(d.path());
    let repo = service.repo(&handle).unwrap();
    let detail = repo.commit(&head).unwrap();
    assert!(detail.can_edit_message, "{:?}", detail.edit_disabled_reason);

    // A remote-tracking ref appears after the read that enabled editing.
    git(d.path(), &["update-ref", "refs/remotes/origin/main", &head]);
    for options in [
        AmendOptions {
            message_only: true,
            require_unpushed: true,
        },
        AmendOptions {
            message_only: false,
            require_unpushed: true,
        },
    ] {
        let error = amend_with(&service, &handle, "published", &head, options).unwrap_err();
        assert_eq!(error.code, "pushedCommit", "{options:?}");
        assert!(error.message.contains("origin/main"));
        assert!(error.message.contains("not proof"));
        assert_eq!(git(d.path(), &["rev-parse", "HEAD"]), head);
        assert_eq!(git(d.path(), &["log", "-1", "--format=%s"]), "next");
    }
    // Each flag is independent: without requireUnpushed the write proceeds.
    let detail = repo.commit(&head).unwrap();
    assert!(!detail.can_edit_message);
    let reason = detail.edit_disabled_reason.unwrap();
    assert!(
        reason.contains("origin/main") && reason.contains("not proof"),
        "{reason}"
    );
    let reworded =
        amend_with(&service, &handle, "explicitly allowed", &head, MESSAGE_ONLY).unwrap();

    // The remote only has the parent, so the rewritten commit is unpushed.
    git(d.path(), &["update-ref", "refs/remotes/origin/main", &base]);
    let options = AmendOptions {
        message_only: true,
        require_unpushed: true,
    };
    let ok = amend_with(&service, &handle, "still local", &reworded.oid, options).unwrap();
    assert_eq!(git(d.path(), &["log", "-1", "--format=%s"]), "still local");
    assert!(repo.commit(&ok.oid).unwrap().can_edit_message);
    // A stale expectation is refused before any remote check or write.
    let status = repo.status().unwrap();
    git(
        d.path(),
        &["update-ref", "refs/remotes/origin/main", &ok.oid],
    );
    assert_eq!(
        service
            .amend_commit_with_identity(
                &handle,
                "stale",
                None,
                &head,
                status.head_ref.as_deref(),
                &status.fingerprint,
                options
            )
            .unwrap_err()
            .code,
        "staleOperation"
    );
}

#[test]
fn root_and_merge_heads_can_be_reworded_with_their_parents_and_tree_intact() {
    let d = init();
    std::fs::write(d.path().join("file"), "root\n").unwrap();
    let root = commit(d.path(), "root");
    let (service, _data, handle) = service_for(d.path());
    let repo = service.repo(&handle).unwrap();
    assert!(repo.commit(&root).unwrap().can_edit_message);
    let tree = git(d.path(), &["rev-parse", "HEAD^{tree}"]);
    let reworded = amend_with(&service, &handle, "new root", &root, MESSAGE_ONLY).unwrap();
    assert_eq!(
        git(d.path(), &["rev-list", "--parents", "-n1", "HEAD"]),
        reworded.oid
    );
    assert_eq!(git(d.path(), &["rev-parse", "HEAD^{tree}"]), tree);

    git(d.path(), &["checkout", "-qb", "side"]);
    std::fs::write(d.path().join("side"), "side\n").unwrap();
    commit(d.path(), "side");
    git(d.path(), &["checkout", "-q", "main"]);
    std::fs::write(d.path().join("main"), "main\n").unwrap();
    commit(d.path(), "main");
    git(d.path(), &["merge", "--no-ff", "-m", "merge side", "side"]);
    let merge = git(d.path(), &["rev-parse", "HEAD"]);
    let parents = git(d.path(), &["rev-list", "--parents", "-n1", "HEAD"]);
    let tree = git(d.path(), &["rev-parse", "HEAD^{tree}"]);
    // Staged work must not leak into the merge commit's tree.
    std::fs::write(d.path().join("extra"), "staged\n").unwrap();
    git(d.path(), &["add", "extra"]);
    assert!(repo.commit(&merge).unwrap().can_edit_message);
    let reworded = amend_with(&service, &handle, "merge, reworded", &merge, MESSAGE_ONLY).unwrap();
    assert_eq!(git(d.path(), &["rev-parse", "HEAD^{tree}"]), tree);
    assert_eq!(
        git(d.path(), &["rev-list", "--parents", "-n1", "HEAD"])
            .split(' ')
            .skip(1)
            .collect::<Vec<_>>(),
        parents.split(' ').skip(1).collect::<Vec<_>>()
    );
    assert_eq!(
        git(d.path(), &["log", "-1", "--format=%s"]),
        "merge, reworded"
    );
    assert_eq!(git(d.path(), &["diff", "--cached", "--name-only"]), "extra");
    assert_ne!(reworded.oid, merge);
}

#[test]
fn message_edit_eligibility_is_head_first_readable_and_never_fails_open() {
    let d = init();
    std::fs::write(d.path().join("file"), "one\n").unwrap();
    let first = commit(d.path(), "first");
    std::fs::write(d.path().join("file"), "two\n").unwrap();
    let head = commit(d.path(), "second");
    let (service, _data, handle) = service_for(d.path());
    let repo = service.repo(&handle).unwrap();
    let reason = |id: &str| {
        let detail = repo.commit(id).unwrap();
        assert_eq!(
            detail.can_edit_message,
            detail.edit_disabled_reason.is_none()
        );
        detail.edit_disabled_reason
    };
    // The commit is parsed whatever the verdict.
    assert_eq!(repo.commit(&first).unwrap().summary.subject, "first");
    assert_eq!(reason(&head), None);
    assert!(reason(&first).unwrap().contains("HEAD"));

    // A transient index.lock does not decide eligibility; the write itself still refuses.
    let lock = d.path().join(".git/index.lock");
    std::fs::write(&lock, "").unwrap();
    assert_eq!(reason(&head), None);
    let error = amend_with(&service, &handle, "locked", &head, MESSAGE_ONLY).unwrap_err();
    assert_eq!(error.code, "indexLocked");
    std::fs::remove_file(&lock).unwrap();

    // An operation in progress is an error while checking: it becomes the reason.
    std::fs::create_dir(d.path().join(".git/rebase-merge")).unwrap();
    let blocked = reason(&head).unwrap();
    assert!(
        blocked.contains("could not be checked") && blocked.contains("rebase"),
        "{blocked}"
    );
    assert_eq!(
        amend_with(&service, &handle, "mid-rebase", &head, MESSAGE_ONLY)
            .unwrap_err()
            .code,
        "operationInProgress"
    );
    std::fs::remove_dir(d.path().join(".git/rebase-merge")).unwrap();
    assert_eq!(reason(&head), None);

    // Unmerged paths without an operation, as left by a conflicting stash pop.
    std::fs::write(d.path().join("file"), "stashed\n").unwrap();
    git(d.path(), &["stash", "push", "-q"]);
    std::fs::write(d.path().join("file"), "three\n").unwrap();
    let head = commit(d.path(), "third");
    assert!(!git_may_fail(d.path(), &["stash", "pop", "-q"]));
    let conflicts = reason(&head).unwrap();
    assert!(conflicts.contains("unresolved conflicts"), "{conflicts}");
    assert_eq!(
        amend_with(&service, &handle, "conflicted", &head, MESSAGE_ONLY)
            .unwrap_err()
            .code,
        "unresolvedConflict"
    );
    git(d.path(), &["reset", "-q", "--hard"]);

    // A detached HEAD has no branch to rewrite, even though the commit is HEAD.
    git(d.path(), &["checkout", "-q", "--detach"]);
    assert!(reason(&head).unwrap().contains("detached"));
    git(d.path(), &["checkout", "-q", "main"]);
    assert_eq!(reason(&head), None);

    // Known remote-tracking refs say so, and say they are not online proof.
    git(d.path(), &["update-ref", "refs/remotes/origin/main", &head]);
    let pushed = reason(&head).unwrap();
    assert!(
        pushed.contains("origin/main") && pushed.contains("not proof"),
        "{pushed}"
    );
    git(d.path(), &["update-ref", "-d", "refs/remotes/origin/main"]);
    assert_eq!(reason(&head), None);

    let others = tempfile::tempdir().unwrap();
    let bare = others.path().join("bare.git");
    git(
        d.path(),
        &[
            "clone",
            "-q",
            "--bare",
            d.path().to_str().unwrap(),
            bare.to_str().unwrap(),
        ],
    );
    let (bare_service, _bare_data, bare_handle) = service_for(&bare);
    let detail = bare_service
        .repo(&bare_handle)
        .unwrap()
        .commit(&head)
        .unwrap();
    assert!(!detail.can_edit_message);
    assert!(detail.edit_disabled_reason.unwrap().contains("bare"));
    assert_eq!(
        bare_service
            .amend_commit_with_identity(
                &bare_handle,
                "bare",
                None,
                &head,
                Some("refs/heads/main"),
                "x",
                MESSAGE_ONLY
            )
            .unwrap_err()
            .code,
        "bareRepository"
    );
}

#[test]
#[cfg(unix)]
fn message_only_amend_still_runs_hooks_and_signing_and_reports_their_refusals() {
    use std::os::unix::fs::PermissionsExt;
    let d = init();
    std::fs::write(d.path().join("file"), "one\n").unwrap();
    let head = commit(d.path(), "original");
    let (service, _data, handle) = service_for(d.path());
    let hook = d.path().join(".git/hooks/pre-commit");
    std::fs::write(
        &hook,
        "#!/bin/sh\necho 'message-only hook refusal' >&2\nexit 1\n",
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let error = amend_with(&service, &handle, "blocked", &head, MESSAGE_ONLY).unwrap_err();
    assert_eq!(error.code, "git");
    assert!(error.message.contains("message-only hook refusal"));
    assert_eq!(git(d.path(), &["rev-parse", "HEAD"]), head);

    std::fs::remove_file(&hook).unwrap();
    git(d.path(), &["config", "commit.gpgsign", "true"]);
    git(
        d.path(),
        &["config", "gpg.program", "/nonexistent/gitty-signer"],
    );
    let error = amend_with(&service, &handle, "unsigned", &head, MESSAGE_ONLY).unwrap_err();
    assert_eq!(error.code, "git");
    assert_eq!(git(d.path(), &["rev-parse", "HEAD"]), head);
}

#[test]
fn renames_stage_as_their_removed_and_added_paths() {
    let d = init();
    std::fs::write(d.path().join("old name.txt"), "first\nsecond\nthird\n").unwrap();
    commit(d.path(), "root");
    std::fs::rename(
        d.path().join("old name.txt"),
        d.path().join("renamed 工作.txt"),
    )
    .unwrap();
    let (service, _data, handle) = service_for(d.path());
    let repo = service.repo(&handle).unwrap();
    service
        .stage(&handle, &paths(&["old name.txt", "renamed 工作.txt"]))
        .unwrap();
    let files = repo.diff_files(&DiffSpec::Staged).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].status, "R");
    assert_eq!(files[0].path, "renamed 工作.txt");
    assert_eq!(files[0].old_path.as_deref(), Some("old name.txt"));
    let created = service.create_commit(&handle, "rename").unwrap();
    assert_eq!(tracked_files(d.path()), vec!["renamed 工作.txt"]);
    assert_eq!(repo.commit(&created.oid).unwrap().summary.subject, "rename");
    assert!(repo.status().unwrap().entries.is_empty());
}

#[test]
fn commits_are_refused_for_bare_repositories_conflicts_and_other_operations() {
    let d = init();
    std::fs::write(d.path().join("file"), "base\n").unwrap();
    commit(d.path(), "root");
    git(d.path(), &["checkout", "-qb", "side"]);
    std::fs::write(d.path().join("file"), "side\n").unwrap();
    commit(d.path(), "side");
    git(d.path(), &["checkout", "-q", "main"]);
    std::fs::write(d.path().join("file"), "main\n").unwrap();
    commit(d.path(), "main");
    let others = tempfile::tempdir().unwrap();
    let bare = others.path().join("bare.git");
    git(
        d.path(),
        &[
            "clone",
            "--bare",
            d.path().to_str().unwrap(),
            bare.to_str().unwrap(),
        ],
    );
    let (service, _data, handle) = service_for(d.path());
    let bare_handle = service
        .open(RepositoryLocation::Native {
            path: bare.to_str().unwrap().into(),
        })
        .unwrap()
        .session
        .handle;
    for code in [
        service
            .stage(&bare_handle, &paths(&["file"]))
            .unwrap_err()
            .code,
        service
            .unstage(&bare_handle, &paths(&["file"]))
            .unwrap_err()
            .code,
        service
            .create_commit(&bare_handle, "message")
            .unwrap_err()
            .code,
    ] {
        assert_eq!(code, "bareRepository");
    }
    // A conflicted merge: writing underneath it would change what the merge means.
    let merge = Command::new("git")
        .arg("-C")
        .arg(d.path())
        .args(["merge", "side"])
        .output()
        .unwrap();
    assert!(!merge.status.success());
    for code in [
        service.stage(&handle, &paths(&["file"])).unwrap_err().code,
        service
            .unstage(&handle, &paths(&["file"]))
            .unwrap_err()
            .code,
        service.create_commit(&handle, "message").unwrap_err().code,
    ] {
        assert_eq!(code, "operationInProgress");
    }
    assert!(
        d.path().join(".git/MERGE_HEAD").exists(),
        "state is never cleaned up"
    );
    git(d.path(), &["merge", "--abort"]);
    // Directory-shaped states are detected as well.
    std::fs::create_dir(d.path().join(".git/rebase-merge")).unwrap();
    assert_eq!(
        service.stage(&handle, &paths(&["file"])).unwrap_err().code,
        "operationInProgress"
    );
    std::fs::remove_dir(d.path().join(".git/rebase-merge")).unwrap();
    service.stage(&handle, &paths(&["file"])).unwrap();
}

#[test]
fn unresolved_conflicts_without_operation_state_are_reported_not_flattened() {
    let d = init();
    std::fs::create_dir(d.path().join("work dir")).unwrap();
    let file = d.path().join("work dir/file");
    std::fs::write(&file, "one\ntwo\nthree\n").unwrap();
    commit(d.path(), "root");
    std::fs::write(&file, "one\nstashed\nthree\n").unwrap();
    git(d.path(), &["stash", "-q"]);
    std::fs::write(&file, "one\nconflicting\nthree\n").unwrap();
    commit(d.path(), "conflicting");
    let popped = Command::new("git")
        .arg("-C")
        .arg(d.path())
        .args(["stash", "pop"])
        .output()
        .unwrap();
    assert!(!popped.status.success());
    let (service, _data, handle) = service_for(d.path());
    let repo = service.repo(&handle).unwrap();
    assert!(repo.status().unwrap().entries[0].conflicted);
    assert!(!d.path().join(".git/MERGE_HEAD").exists());
    for code in [
        service
            .stage(&handle, &paths(&["work dir/file"]))
            .unwrap_err()
            .code,
        service
            .unstage(&handle, &paths(&["work dir/file"]))
            .unwrap_err()
            .code,
        // A directory-shaped selection that contains the conflict is refused too.
        service
            .stage(&handle, &paths(&["work dir/"]))
            .unwrap_err()
            .code,
        service.create_commit(&handle, "message").unwrap_err().code,
    ] {
        assert_eq!(code, "unresolvedConflict");
    }
    // A sibling whose name merely starts with the same characters is unaffected.
    std::fs::write(d.path().join("work dirty"), "unrelated\n").unwrap();
    service.stage(&handle, &paths(&["work dirty"])).unwrap();
    // The conflicted stages are still intact for Git to resolve.
    assert_eq!(
        git(d.path(), &["ls-files", "--unmerged"]).lines().count(),
        3
    );
}

#[test]
fn a_held_index_lock_is_respected_and_never_removed() {
    let d = init();
    std::fs::write(d.path().join("file"), "one\n").unwrap();
    commit(d.path(), "root");
    std::fs::write(d.path().join("file"), "two\n").unwrap();
    let (service, _data, handle) = service_for(d.path());
    let lock = d.path().join(".git/index.lock");
    std::fs::write(&lock, b"pid 1234").unwrap();
    for code in [
        service.stage(&handle, &paths(&["file"])).unwrap_err().code,
        service
            .unstage(&handle, &paths(&["file"]))
            .unwrap_err()
            .code,
        service.create_commit(&handle, "message").unwrap_err().code,
    ] {
        assert_eq!(code, "indexLocked");
    }
    assert_eq!(std::fs::read(&lock).unwrap(), b"pid 1234");
    std::fs::remove_file(&lock).unwrap();
    service.stage(&handle, &paths(&["file"])).unwrap();
    assert!(!lock.exists());
}

#[test]
fn a_missing_identity_is_reported_without_touching_the_index() {
    let d = init();
    std::fs::write(d.path().join("file"), "one\n").unwrap();
    commit(d.path(), "root");
    git(d.path(), &["config", "user.name", ""]);
    git(d.path(), &["config", "user.email", ""]);
    std::fs::write(d.path().join("file"), "two\n").unwrap();
    let (service, _data, handle) = service_for(d.path());
    service.stage(&handle, &paths(&["file"])).unwrap();
    let head = git(d.path(), &["rev-parse", "HEAD"]);
    let error = service.create_commit(&handle, "message").unwrap_err();
    assert_eq!(error.code, "git");
    assert!(
        error.message.to_lowercase().contains("ident"),
        "identity failures must be explained: {}",
        error.message
    );
    assert_eq!(git(d.path(), &["rev-parse", "HEAD"]), head);
    assert_eq!(git(d.path(), &["show", ":file"]), "two");
    assert_eq!(
        std::fs::read_to_string(d.path().join("file")).unwrap(),
        "two\n"
    );
}

#[test]
#[cfg(unix)]
fn configured_hooks_and_signing_run_and_their_failures_preserve_the_index() {
    use std::os::unix::fs::PermissionsExt;
    let d = init();
    std::fs::write(d.path().join("file"), "one\n").unwrap();
    commit(d.path(), "root");
    let head = git(d.path(), &["rev-parse", "HEAD"]);
    let hook = d.path().join(".git/hooks/pre-commit");
    std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
    std::fs::write(&hook, "#!/bin/sh\necho 'gitty hook refusal' >&2\nexit 1\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(d.path().join("file"), "two\n").unwrap();
    let (service, _data, handle) = service_for(d.path());
    service.stage(&handle, &paths(&["file"])).unwrap();
    let error = service.create_commit(&handle, "blocked").unwrap_err();
    assert_eq!(error.code, "git");
    assert!(
        error.message.contains("gitty hook refusal"),
        "hook output must reach the user: {}",
        error.message
    );
    assert_eq!(git(d.path(), &["rev-parse", "HEAD"]), head);
    assert_eq!(git(d.path(), &["show", ":file"]), "two");
    assert_eq!(
        std::fs::read_to_string(d.path().join("file")).unwrap(),
        "two\n"
    );
    // Signing is honored too: a broken signer fails the commit, never bypasses it.
    std::fs::remove_file(&hook).unwrap();
    git(d.path(), &["config", "commit.gpgsign", "true"]);
    git(
        d.path(),
        &["config", "gpg.program", "/nonexistent/gitty-signer"],
    );
    let error = service.create_commit(&handle, "unsigned").unwrap_err();
    assert_eq!(error.code, "git");
    assert_eq!(git(d.path(), &["rev-parse", "HEAD"]), head);
    assert_eq!(git(d.path(), &["show", ":file"]), "two");
    git(d.path(), &["config", "commit.gpgsign", "false"]);
    let created = service.create_commit(&handle, "signed off").unwrap();
    assert_eq!(created.oid, git(d.path(), &["rev-parse", "HEAD"]));
    // The post-commit hook runs after the commit; the reported ID is what HEAD is.
    assert_ne!(created.oid, head);
}

#[test]
fn writes_serialize_per_repository_across_sessions_and_linked_worktrees() {
    use std::sync::Arc;
    let d = init();
    std::fs::write(d.path().join("root"), "root\n").unwrap();
    commit(d.path(), "root");
    let others = tempfile::tempdir().unwrap();
    let linked = others.path().join("linked");
    git(
        d.path(),
        &["worktree", "add", "-b", "side", linked.to_str().unwrap()],
    );
    let data = tempfile::tempdir().unwrap();
    let service = Arc::new(Service::new(data.path().into()));
    let location = |path: &Path| RepositoryLocation::Native {
        path: path.to_str().unwrap().into(),
    };
    let first = service.open(location(d.path())).unwrap().session.handle;
    let second = service.open(location(d.path())).unwrap().session.handle;
    let worktree = service.open(location(&linked)).unwrap().session.handle;
    for i in 0..8 {
        std::fs::write(d.path().join(format!("file {i}")), format!("{i}\n")).unwrap();
        std::fs::write(linked.join(format!("linked {i}")), format!("{i}\n")).unwrap();
    }
    let workers: Vec<_> = (0..8)
        .map(|i| {
            let service = service.clone();
            let handle = if i % 2 == 0 {
                first.clone()
            } else {
                second.clone()
            };
            let shared = worktree.clone();
            std::thread::spawn(move || {
                service.stage(&handle, &paths(&[&format!("file {i}")]))?;
                service.stage(&shared, &paths(&[&format!("linked {i}")]))
            })
        })
        .collect();
    for worker in workers {
        worker
            .join()
            .unwrap()
            .expect("concurrent writes must not fight over the index lock");
    }
    let staged: Vec<String> = git(d.path(), &["diff", "--cached", "--name-only", "-z"])
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();
    assert_eq!(staged.len(), 8);
    assert!(!d.path().join(".git/index.lock").exists());
    let main_commit = service.create_commit(&first, "eight files").unwrap();
    let linked_commit = service
        .create_commit(&worktree, "eight linked files")
        .unwrap();
    assert_eq!(
        main_commit.oid,
        git(d.path(), &["rev-parse", "refs/heads/main"])
    );
    assert_eq!(
        linked_commit.oid,
        git(&linked, &["rev-parse", "refs/heads/side"])
    );
    assert_eq!(tracked_files(d.path()).len(), 9);
    assert_eq!(tracked_files(&linked).len(), 9);
}

#[test]
#[cfg(unix)]
fn a_slow_hook_blocks_only_its_own_repository() {
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use std::time::{Duration, Instant};
    let slow = init();
    let other = init();
    for d in [&slow, &other] {
        std::fs::write(d.path().join("file"), "one\n").unwrap();
        commit(d.path(), "root");
        std::fs::write(d.path().join("file"), "two\n").unwrap();
    }
    let started = slow.path().join("hook-started");
    let hook = slow.path().join(".git/hooks/pre-commit");
    std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
    std::fs::write(
        &hook,
        format!(
            "#!/bin/sh\ntouch '{}'\nsleep 3\n",
            started.to_str().unwrap()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let data = tempfile::tempdir().unwrap();
    let service = Arc::new(Service::new(data.path().into()));
    let location = |path: &Path| RepositoryLocation::Native {
        path: path.to_str().unwrap().into(),
    };
    let committing = service.open(location(slow.path())).unwrap().session.handle;
    let same_repository = service.open(location(slow.path())).unwrap().session.handle;
    let unrelated = service.open(location(other.path())).unwrap().session.handle;
    service.stage(&committing, &paths(&["file"])).unwrap();
    let finished = Arc::new(AtomicBool::new(false));
    let worker = {
        let service = service.clone();
        let finished = finished.clone();
        std::thread::spawn(move || {
            let result = service.create_commit(&committing, "slow hook");
            finished.store(true, Ordering::SeqCst);
            result
        })
    };
    while !started.exists() {
        std::thread::sleep(Duration::from_millis(20));
    }
    let at = Instant::now();
    service.stage(&unrelated, &paths(&["file"])).unwrap();
    assert!(
        !finished.load(Ordering::SeqCst) && at.elapsed() < Duration::from_secs(2),
        "an unrelated repository must not wait behind another repository's hook"
    );
    let at = Instant::now();
    service.stage(&same_repository, &paths(&["file"])).unwrap();
    assert!(
        at.elapsed() >= Duration::from_secs(1),
        "a second session for the same repository must wait for the running write"
    );
    assert!(worker.join().unwrap().is_ok());
    std::fs::remove_file(&hook).unwrap();
}

#[test]
fn in_progress_detection_does_not_depend_on_the_reference_backend() {
    let parent = tempfile::tempdir().unwrap();
    let d = parent.path().join("reftable");
    let created = Command::new("git")
        .args(["init", "-b", "main", "--ref-format=reftable"])
        .arg(&d)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .output()
        .unwrap();
    if !created.status.success() {
        eprintln!("skipping: this Git has no reftable backend");
        return;
    }
    git(&d, &["config", "user.name", "Test Author"]);
    git(&d, &["config", "user.email", "test@example.com"]);
    std::fs::write(d.join("file"), "base\n").unwrap();
    commit(&d, "root");
    git(&d, &["checkout", "-qb", "side"]);
    std::fs::write(d.join("file"), "side\n").unwrap();
    commit(&d, "side");
    git(&d, &["checkout", "-q", "main"]);
    std::fs::write(d.join("file"), "main\n").unwrap();
    commit(&d, "main");
    let conflicted = Command::new("git")
        .arg("-C")
        .arg(&d)
        .args(["cherry-pick", "side"])
        .output()
        .unwrap();
    assert!(!conflicted.status.success());
    // A reftable repository keeps CHERRY_PICK_HEAD out of the Git directory.
    assert!(!d.join(".git/CHERRY_PICK_HEAD").exists());
    let (service, _data, handle) = service_for(&d);
    assert_eq!(
        service.stage(&handle, &paths(&["file"])).unwrap_err().code,
        "operationInProgress"
    );
    assert_eq!(
        service.create_commit(&handle, "message").unwrap_err().code,
        "operationInProgress"
    );
    git(&d, &["cherry-pick", "--abort"]);
    std::fs::write(d.join("file"), "resolved\n").unwrap();
    service.stage(&handle, &paths(&["file"])).unwrap();
    let created = service
        .create_commit(&handle, "resolved outside Gitty")
        .unwrap();
    assert_eq!(created.oid, git(&d, &["rev-parse", "HEAD"]));
}

#[test]
fn directory_entries_from_status_stage_as_the_single_path_they_represent() {
    let d = init();
    std::fs::write(d.path().join("root"), "root\n").unwrap();
    commit(d.path(), "root");
    let nested = d.path().join("embedded repo");
    std::fs::create_dir(&nested).unwrap();
    git(&nested, &["init", "-b", "main"]);
    git(&nested, &["config", "user.name", "Test Author"]);
    git(&nested, &["config", "user.email", "test@example.com"]);
    std::fs::write(nested.join("inner"), "inner\n").unwrap();
    commit(&nested, "inner");
    let (service, _data, handle) = service_for(d.path());
    let repo = service.repo(&handle).unwrap();
    // Status reports an embedded repository as one directory entry.
    let entry = repo
        .status()
        .unwrap()
        .entries
        .into_iter()
        .find(|e| e.path.starts_with("embedded repo"))
        .unwrap();
    assert_eq!(entry.path, "embedded repo/");
    service
        .stage(&handle, std::slice::from_ref(&entry.path))
        .unwrap();
    assert_eq!(
        git(
            d.path(),
            &["ls-files", "--stage", "-z", "--", "embedded repo"]
        )
        .split(' ')
        .next()
        .unwrap(),
        "160000"
    );
    service.unstage(&handle, &[entry.path]).unwrap();
    assert!(repo
        .status()
        .unwrap()
        .entries
        .iter()
        .any(|e| e.path == "embedded repo/" && e.untracked));
}

#[test]
fn large_path_batches_and_messages_do_not_travel_on_the_command_line() {
    let d = init();
    std::fs::write(d.path().join("root"), "root\n").unwrap();
    commit(d.path(), "root");
    // Windows caps an entire command line near 32767 UTF-16 units, so this batch
    // could not be expressed as arguments on every platform.
    let names: Vec<String> = (0..400)
        .map(|i| format!("{i:04} staged file with spaces -[*?] {}", "n".repeat(60)))
        .collect();
    for name in &names {
        std::fs::write(d.path().join(name), "content\n").unwrap();
    }
    let total: usize = names.iter().map(|n| n.len() + 1).sum();
    assert!(
        total > 32_767,
        "fixture must exceed the Windows limit: {total}"
    );
    let (service, _data, handle) = service_for(d.path());
    let repo = service.repo(&handle).unwrap();
    service.stage(&handle, &names).unwrap();
    let staged: Vec<String> = git(d.path(), &["diff", "--cached", "--name-only", "-z"])
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();
    assert_eq!(staged.len(), names.len());
    // A commit message far past any argument limit, with characters that a shell
    // or an option parser would otherwise be tempted to interpret.
    let message = format!(
        "--not-an-option: 工作 \"quoted\" 'single' $(echo no) `no`\n\n{}",
        "Ünicode body line with a trailing period.\n".repeat(1000)
    );
    assert!(message.len() > 40_000);
    let created = service.create_commit(&handle, &message).unwrap();
    assert_eq!(created.oid, git(d.path(), &["rev-parse", "HEAD"]));
    let detail = repo.commit(&created.oid).unwrap();
    assert_eq!(
        detail.summary.subject,
        "--not-an-option: 工作 \"quoted\" 'single' $(echo no) `no`"
    );
    assert_eq!(detail.body, message);
    assert_eq!(tracked_files(d.path()).len(), names.len() + 1);
    // The same batch size unstages in one request.
    std::fs::write(d.path().join(&names[0]), "changed\n").unwrap();
    service.stage(&handle, &names).unwrap();
    service.unstage(&handle, &names).unwrap();
    assert!(repo
        .status()
        .unwrap()
        .entries
        .iter()
        .all(|e| e.index_status == "."));
}

#[test]
#[cfg(unix)]
fn hooks_cannot_consume_the_commit_message_from_shared_stdin() {
    use std::os::unix::fs::PermissionsExt;
    let d = init();
    std::fs::write(d.path().join("file"), "one\n").unwrap();
    commit(d.path(), "root");
    let capture = d.path().join("hook-stdin");
    let hook = d.path().join(".git/hooks/pre-commit");
    std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
    std::fs::write(
        &hook,
        format!("#!/bin/sh\ncat > '{}'\n", capture.to_str().unwrap()),
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(d.path().join("file"), "two\n").unwrap();
    let (service, _data, handle) = service_for(d.path());
    service.stage(&handle, &paths(&["file"])).unwrap();
    let created = service
        .create_commit(&handle, "subject read by Git\n\nbody read by Git\n")
        .unwrap();
    assert_eq!(
        service
            .repo(&handle)
            .unwrap()
            .commit(&created.oid)
            .unwrap()
            .body,
        "subject read by Git\n\nbody read by Git\n"
    );
    // Git consumes the message before hooks run, so a hook reading stdin sees EOF
    // rather than the message, and can never block waiting for input.
    assert_eq!(std::fs::read(&capture).unwrap(), b"");
    std::fs::remove_file(&hook).unwrap();
}

#[test]
fn a_broken_head_is_reported_instead_of_being_treated_as_an_unborn_branch() {
    let d = init();
    std::fs::write(d.path().join("file"), "one\n").unwrap();
    commit(d.path(), "root");
    let head = std::fs::read_to_string(d.path().join(".git/HEAD")).unwrap();
    std::fs::write(d.path().join("file"), "two\n").unwrap();
    let (service, _data, handle) = service_for(d.path());
    service.stage(&handle, &paths(&["file"])).unwrap();
    // Detached at an object that does not exist: `rev-parse --verify --quiet`
    // reports exactly what an unborn branch reports.
    std::fs::write(d.path().join(".git/HEAD"), format!("{}\n", "0".repeat(40))).unwrap();
    let error = service.create_commit(&handle, "message").unwrap_err();
    assert_eq!(error.code, "unresolvedHead");
    assert_eq!(git(d.path(), &["show", ":file"]), "two");
    std::fs::write(d.path().join(".git/HEAD"), &head).unwrap();
    let created = service.create_commit(&handle, "message").unwrap();
    assert_eq!(created.oid, git(d.path(), &["rev-parse", "HEAD"]));
}

/// Timing report, not an assertion. Point it at a slow repository:
/// `GITTY_TIMING_REPO=/path/to/repo cargo test timing_report -- --ignored --nocapture`
#[test]
#[ignore]
fn timing_report() {
    let Ok(path) = std::env::var("GITTY_TIMING_REPO") else {
        eprintln!("Set GITTY_TIMING_REPO to a repository path.");
        return;
    };
    let data = tempfile::tempdir().unwrap();
    let service = Service::new(data.path().into());
    let handle = service
        .open(RepositoryLocation::Native { path })
        .unwrap()
        .session
        .handle;
    let repo = service.repo(&handle).unwrap();
    let time = |label: &str, run: &dyn Fn()| {
        run(); // warm the file cache
        let start = std::time::Instant::now();
        run();
        eprintln!("{label:<34}{:>8.1?}", start.elapsed());
    };
    time("state", &|| drop(repo.state().unwrap()));
    time("status (refresh fingerprint)", &|| {
        drop(repo.status().unwrap())
    });
    time("operation_state (old, alone)", &|| {
        drop(repo.operation_state().unwrap())
    });
    time("old refresh (2x op + 2x state + status)", &|| {
        drop(repo.operation_state().unwrap());
        drop(repo.state().unwrap());
        drop(repo.status().unwrap());
        drop(repo.state().unwrap());
        drop(repo.operation_state().unwrap());
    });
    time("snapshot (new refresh)", &|| drop(repo.snapshot().unwrap()));
    time("status only (after stage/unstage)", &|| {
        drop(repo.status().unwrap())
    });
}

fn read(path: &Path, name: &str) -> String {
    std::fs::read_to_string(path.join(name)).unwrap()
}
fn fingerprint_of(service: &Service, handle: &str) -> String {
    service.repo(handle).unwrap().status().unwrap().fingerprint
}

#[test]
fn discard_restores_from_the_index_and_keeps_the_staged_half() {
    let d = init();
    for name in ["edited", "partial", "gone", "untouched"] {
        std::fs::write(d.path().join(name), format!("{name} base\n")).unwrap();
    }
    commit(d.path(), "base");
    std::fs::write(d.path().join("edited"), "edited work\n").unwrap();
    std::fs::write(d.path().join("partial"), "partial staged\n").unwrap();
    git(d.path(), &["add", "partial"]);
    std::fs::write(d.path().join("partial"), "partial staged\nplus worktree\n").unwrap();
    std::fs::remove_file(d.path().join("gone")).unwrap();
    std::fs::write(d.path().join("untouched"), "untouched work\n").unwrap();
    let (service, _data, handle) = service_for(d.path());
    let fp = fingerprint_of(&service, &handle);
    service
        .discard(&handle, &paths(&["edited", "partial", "gone"]), &fp)
        .unwrap();
    assert_eq!(read(d.path(), "edited"), "edited base\n");
    assert_eq!(read(d.path(), "gone"), "gone base\n");
    // The staged half is the new floor; only the extra working-tree line is lost.
    assert_eq!(read(d.path(), "partial"), "partial staged\n");
    assert_eq!(
        git(d.path(), &["diff", "--cached", "--name-only"]),
        "partial"
    );
    // A path that was not named is never touched.
    assert_eq!(read(d.path(), "untouched"), "untouched work\n");
}

#[test]
fn discard_deletes_only_the_named_untracked_files_and_keeps_names_literal() {
    let d = init();
    std::fs::write(d.path().join("tracked"), "base\n").unwrap();
    commit(d.path(), "base");
    std::fs::create_dir(d.path().join("sub dir")).unwrap();
    let doomed = ["-n", "star*[a-b]?.txt", "úñí 工作.txt", "sub dir/deep file"];
    for name in doomed {
        std::fs::write(d.path().join(name), "x\n").unwrap();
    }
    // Same shape as a doomed pattern, but not named: a glob must not reach it.
    for name in ["star1.txt", "keep.txt", "sub dir/sibling"] {
        std::fs::write(d.path().join(name), "keep\n").unwrap();
    }
    let (service, _data, handle) = service_for(d.path());
    let fp = fingerprint_of(&service, &handle);
    service.discard(&handle, &paths(&doomed), &fp).unwrap();
    for name in doomed {
        assert!(!d.path().join(name).exists(), "{name} should be gone");
    }
    for name in ["star1.txt", "keep.txt", "sub dir/sibling", "tracked"] {
        assert!(d.path().join(name).exists(), "{name} must survive");
    }
}

#[test]
fn discard_batches_many_untracked_paths_across_several_git_processes() {
    let d = init();
    std::fs::write(d.path().join("tracked"), "base\n").unwrap();
    commit(d.path(), "base");
    // Far more argument bytes than one batch allows.
    let names: Vec<String> = (0..600)
        .map(|i| format!("generated-file-with-a-long-name-{i:04}.txt"))
        .collect();
    for name in &names {
        std::fs::write(d.path().join(name), "x\n").unwrap();
    }
    let (service, _data, handle) = service_for(d.path());
    let fp = fingerprint_of(&service, &handle);
    service.discard(&handle, &names, &fp).unwrap();
    assert!(names.iter().all(|n| !d.path().join(n).exists()));
    assert!(d.path().join("tracked").exists());
}

#[test]
fn discard_refuses_a_stale_fingerprint_and_changes_nothing() {
    let d = init();
    std::fs::write(d.path().join("file"), "base\n").unwrap();
    commit(d.path(), "base");
    std::fs::write(d.path().join("file"), "reviewed edit\n").unwrap();
    std::fs::write(d.path().join("fresh"), "reviewed\n").unwrap();
    let (service, _data, handle) = service_for(d.path());
    let reviewed = fingerprint_of(&service, &handle);
    // An edit lands after the user looked, with the same status letters.
    std::fs::write(d.path().join("file"), "unreviewed longer edit\n").unwrap();
    let error = service
        .discard(&handle, &paths(&["file", "fresh"]), &reviewed)
        .unwrap_err();
    assert_eq!(error.code, "staleOperation");
    assert_eq!(read(d.path(), "file"), "unreviewed longer edit\n");
    assert_eq!(read(d.path(), "fresh"), "reviewed\n");
}

#[test]
fn discard_refuses_staged_only_unknown_empty_and_escaping_paths() {
    let d = init();
    std::fs::write(d.path().join("staged"), "base\n").unwrap();
    std::fs::write(d.path().join("clean"), "base\n").unwrap();
    std::fs::write(d.path().join("intent"), "base\n").unwrap();
    commit(d.path(), "base");
    std::fs::write(d.path().join("staged"), "staged work\n").unwrap();
    git(d.path(), &["add", "staged"]);
    std::fs::write(d.path().join("added"), "intent to add\n").unwrap();
    git(d.path(), &["add", "--intent-to-add", "added"]);
    let (service, _data, handle) = service_for(d.path());
    let fp = fingerprint_of(&service, &handle);
    for (path, code) in [
        ("staged", "invalidRequest"),
        ("clean", "invalidRequest"),
        ("added", "invalidRequest"),
        ("../outside", "invalidPath"),
    ] {
        assert_eq!(
            service
                .discard(&handle, &paths(&[path]), &fp)
                .unwrap_err()
                .code,
            code,
            "{path}"
        );
    }
    assert_eq!(
        service.discard(&handle, &[], &fp).unwrap_err().code,
        "invalidRequest"
    );
    assert_eq!(read(d.path(), "staged"), "staged work\n");
    assert_eq!(read(d.path(), "added"), "intent to add\n");
}

#[test]
fn discard_is_refused_during_an_operation_and_never_removes_a_nested_repository() {
    let d = init();
    std::fs::write(d.path().join("file"), "base\n").unwrap();
    commit(d.path(), "base");
    let nested = d.path().join("nested");
    std::fs::create_dir(&nested).unwrap();
    git(&nested, &["init", "-b", "main"]);
    std::fs::write(nested.join("inner"), "inner\n").unwrap();
    std::fs::write(d.path().join("file"), "edited\n").unwrap();
    let (service, _data, handle) = service_for(d.path());
    let fp = fingerprint_of(&service, &handle);
    assert_eq!(
        service
            .discard(&handle, &paths(&["nested"]), &fp)
            .unwrap_err()
            .code,
        "invalidRequest"
    );
    assert!(nested.join("inner").exists());
    std::fs::write(
        d.path().join(".git/MERGE_HEAD"),
        format!("{}\n", git(d.path(), &["rev-parse", "HEAD"])),
    )
    .unwrap();
    assert_eq!(
        service
            .discard(&handle, &paths(&["file"]), &fp)
            .unwrap_err()
            .code,
        "operationInProgress"
    );
    assert_eq!(read(d.path(), "file"), "edited\n");
}

#[test]
fn discard_works_before_the_first_commit() {
    let d = init();
    std::fs::write(d.path().join("fresh"), "x\n").unwrap();
    std::fs::write(d.path().join("indexed"), "indexed\n").unwrap();
    git(d.path(), &["add", "indexed"]);
    std::fs::write(d.path().join("indexed"), "indexed\nmore\n").unwrap();
    let (service, _data, handle) = service_for(d.path());
    let fp = fingerprint_of(&service, &handle);
    service
        .discard(&handle, &paths(&["fresh", "indexed"]), &fp)
        .unwrap();
    assert!(!d.path().join("fresh").exists());
    assert_eq!(read(d.path(), "indexed"), "indexed\n");
}

fn untracked(path: &Path) -> Vec<String> {
    git(path, &["status", "--porcelain=v1", "-uall", "-z"])
        .split('\0')
        .filter_map(|record| record.strip_prefix("?? "))
        .map(String::from)
        .collect()
}

#[test]
fn ignore_path_appends_one_exact_line_and_refuses_to_repeat_itself() {
    let d = init();
    std::fs::write(d.path().join("tracked"), "base\n").unwrap();
    commit(d.path(), "base");
    std::fs::create_dir(d.path().join("sub")).unwrap();
    for name in ["secret.env", "sub/secret.env", "sub/other"] {
        std::fs::write(d.path().join(name), "x\n").unwrap();
    }
    let (service, _data, handle) = service_for(d.path());
    service.ignore_path(&handle, "secret.env").unwrap();
    assert_eq!(read(d.path(), ".gitignore"), "/secret.env\n");
    // Anchored: the same name deeper in the tree is a different file.
    let remaining = untracked(d.path());
    assert!(remaining.contains(&"sub/secret.env".to_string()));
    assert!(!remaining.contains(&"secret.env".to_string()));
    // Already ignored, so no longer untracked: refused, and no second line.
    assert_eq!(
        service.ignore_path(&handle, "secret.env").unwrap_err().code,
        "invalidRequest"
    );
    assert_eq!(read(d.path(), ".gitignore"), "/secret.env\n");
}

#[test]
fn ignore_path_keeps_existing_content_and_adds_the_missing_newline() {
    let d = init();
    std::fs::write(d.path().join("tracked"), "base\n").unwrap();
    commit(d.path(), "base");
    std::fs::write(d.path().join(".gitignore"), "target/\r\nnode_modules").unwrap();
    git(d.path(), &["add", ".gitignore"]);
    git(d.path(), &["commit", "-m", "ignore"]);
    std::fs::write(d.path().join("scratch"), "x\n").unwrap();
    let (service, _data, handle) = service_for(d.path());
    service.ignore_path(&handle, "scratch").unwrap();
    assert_eq!(
        read(d.path(), ".gitignore"),
        "target/\r\nnode_modules\n/scratch\n"
    );
}

#[test]
fn ignore_path_escapes_names_so_only_that_file_is_ignored() {
    let d = init();
    std::fs::write(d.path().join("tracked"), "base\n").unwrap();
    commit(d.path(), "base");
    let ignored = [
        "star*[a-b]?.txt",
        "#hash",
        "!bang",
        "has space.txt",
        "back\\slash",
    ];
    // Look-alikes that an unescaped pattern would also swallow.
    let kept = ["starX.txt", "hash", "bang", "has_space.txt"];
    for name in ignored.iter().chain(kept.iter()) {
        std::fs::write(d.path().join(name), "x\n").unwrap();
    }
    let (service, _data, handle) = service_for(d.path());
    for name in ignored {
        service.ignore_path(&handle, name).unwrap();
    }
    let mut left = untracked(d.path());
    left.sort();
    let mut expected: Vec<String> = kept.iter().map(|s| s.to_string()).collect();
    expected.push(".gitignore".into());
    expected.sort();
    assert_eq!(left, expected);
}

#[test]
fn ignore_path_refuses_tracked_missing_and_escaping_targets() {
    let d = init();
    std::fs::write(d.path().join("tracked"), "base\n").unwrap();
    commit(d.path(), "base");
    let (service, _data, handle) = service_for(d.path());
    for (path, code) in [
        ("tracked", "invalidRequest"),
        ("missing", "invalidRequest"),
        ("../outside", "invalidPath"),
    ] {
        assert_eq!(
            service.ignore_path(&handle, path).unwrap_err().code,
            code,
            "{path}"
        );
    }
    assert!(!d.path().join(".gitignore").exists());
    #[cfg(unix)]
    {
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("elsewhere");
        std::fs::write(&target, "outside\n").unwrap();
        std::os::unix::fs::symlink(&target, d.path().join(".gitignore")).unwrap();
        std::fs::write(d.path().join("scratch"), "x\n").unwrap();
        assert!(service.ignore_path(&handle, "scratch").is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "outside\n");
    }
}

#[test]
fn open_path_refuses_what_it_must_not_launch_before_starting_anything() {
    let d = init();
    std::fs::write(d.path().join("tracked"), "base\n").unwrap();
    std::fs::write(d.path().join("run.sh"), "#!/bin/sh\n").unwrap();
    commit(d.path(), "base");
    std::fs::create_dir(d.path().join("folder")).unwrap();
    let (service, _data, handle) = service_for(d.path());
    for (path, code) in [
        ("run.sh", "openRefused"),
        ("folder", "openRefused"),
        ("gone", "notFound"),
        ("../outside", "invalidPath"),
    ] {
        assert_eq!(
            service.open_path(&handle, path).unwrap_err().code,
            code,
            "{path}"
        );
    }
    assert_eq!(
        service.reveal_path(&handle, "gone").unwrap_err().code,
        "notFound"
    );
}

/// One linear `main` of `count` commits (oldest first), written with a single
/// `git fast-import` stream. `message(i)` is the full commit message.
fn import_linear(path: &Path, count: usize, message: impl Fn(usize) -> String) {
    use std::io::Write;
    use std::process::Stdio;
    let mut child = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["fast-import", "--quiet"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    {
        let mut input = std::io::BufWriter::new(child.stdin.take().unwrap());
        for i in 0..count {
            let message = format!("{}\n", message(i));
            write!(
                input,
                "commit refs/heads/main\ncommitter Test <test@example.org> {} +0000\ndata {}\n{}\n",
                1_700_000_000 + i,
                message.len(),
                message
            )
            .unwrap();
        }
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn text_query(text: &str) -> SearchQuery {
    SearchQuery {
        text: text.into(),
        branch: None,
        since: None,
        until: None,
        path: None,
    }
}

#[test]
fn search_hydrates_results_in_one_batch_with_the_summaries_of_the_per_commit_path() {
    let d = init();
    import_linear(d.path(), 100, |i| {
        if i % 5 == 0 {
            format!("plain {i}")
        } else {
            format!("subject {i} hydrate-token\n\nbody of {i}")
        }
    });
    let (service, _data, handle) = service_for(d.path());
    let repo = service.repo(&handle).unwrap();
    let (found, spawns) =
        crate::process::count_spawns(|| repo.search(text_query("hydrate-token")).unwrap());
    assert_eq!(found.commits.len(), 80);
    assert!(!found.truncated);
    // Previously ~3 processes per result (~240). Now: state reads + one log
    // stream + one `cat-file --batch`.
    assert!(spawns <= 10, "search launched {spawns} processes");
    let expected = git(
        d.path(),
        &["log", "--topo-order", "--grep=hydrate-token", "--format=%H"],
    );
    assert_eq!(
        found
            .commits
            .iter()
            .map(|c| c.id.as_str())
            .collect::<Vec<_>>(),
        expected.lines().collect::<Vec<_>>()
    );
    for index in [0, 1, 39, 79] {
        let summary = &found.commits[index];
        assert_eq!(
            serde_json::to_value(summary).unwrap(),
            serde_json::to_value(repo.commit(&summary.id).unwrap().summary).unwrap()
        );
    }
}

#[test]
fn search_truncation_boundary_and_process_count_with_501_matches() {
    let d = init();
    // Commit 0 (the oldest) lacks the "alpha" token: 500 alpha matches, 501 boundary matches.
    import_linear(d.path(), 501, |i| {
        if i == 0 {
            "boundary 0".into()
        } else {
            format!("boundary {i} alpha")
        }
    });
    let (service, _data, handle) = service_for(d.path());
    let repo = service.repo(&handle).unwrap();
    let (exact, exact_spawns) =
        crate::process::count_spawns(|| repo.search(text_query("alpha")).unwrap());
    assert_eq!(exact.commits.len(), 500);
    assert!(!exact.truncated);
    let (over, over_spawns) =
        crate::process::count_spawns(|| repo.search(text_query("boundary")).unwrap());
    assert_eq!(over.commits.len(), 500);
    assert!(over.truncated);
    // 500 results hydrate as three batches (200 + 200 + 100), not 1,500 processes.
    assert!(exact_spawns <= 12, "{exact_spawns} processes");
    assert!(over_spawns <= 12, "{over_spawns} processes");
    let expected = git(d.path(), &["rev-list", "--topo-order", "main"]);
    assert_eq!(
        over.commits
            .iter()
            .map(|c| c.id.as_str())
            .collect::<Vec<_>>(),
        expected.lines().take(500).collect::<Vec<_>>()
    );
}

/// Holds the first search on `repo` mid-scan until `release` is signalled. The
/// searching thread reports `started` once its first record has been scanned.
fn paused_search(
    repo: std::sync::Arc<crate::repository::Repository>,
    text: &'static str,
) -> (
    std::thread::JoinHandle<Result<SearchResult>>,
    std::sync::mpsc::Receiver<()>,
    std::sync::mpsc::Sender<()>,
) {
    let (started_tx, started) = std::sync::mpsc::channel();
    let (release, release_rx) = std::sync::mpsc::channel::<()>();
    let worker = std::thread::spawn(move || {
        let mut first = true;
        crate::repository::SEARCH_HOOK.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                if std::mem::take(&mut first) {
                    started_tx.send(()).unwrap();
                    release_rx
                        .recv_timeout(std::time::Duration::from_secs(20))
                        .unwrap();
                }
            }));
        });
        repo.search(text_query(text))
    });
    (worker, started, release)
}

#[test]
fn a_newer_search_cancels_the_in_flight_one_for_the_same_session() {
    let d = init();
    import_linear(d.path(), 600, |i| format!("scan {i}"));
    let (service, _data, handle) = service_for(d.path());
    let repo = service.repo(&handle).unwrap();
    let (first, started, release) = paused_search(repo.clone(), "matches-nothing");
    started
        .recv_timeout(std::time::Duration::from_secs(20))
        .unwrap();
    // The superseding search runs on this thread (no hook installed here).
    let second = repo.search(text_query("scan 599")).unwrap();
    assert_eq!(second.commits.len(), 1);
    release.send(()).unwrap();
    let error = first.join().unwrap().unwrap_err();
    assert_eq!(error.code, "cancelled");
    assert_eq!(error.message, "Search superseded");
    // A finished search leaves nothing behind to cancel.
    assert_eq!(
        repo.search(text_query("scan 1")).unwrap().commits.len(),
        111
    );
}

#[test]
fn repository_cancel_search_is_a_no_op_when_idle_and_cancels_when_in_flight() {
    let d = init();
    import_linear(d.path(), 50, |i| format!("scan {i}"));
    let (service, _data, handle) = service_for(d.path());
    service.cancel_search(&handle).unwrap();
    service.cancel_search("unknown-handle").unwrap();
    // Cancelling an idle session does not poison the next search.
    assert_eq!(
        service
            .repo(&handle)
            .unwrap()
            .search(text_query("scan 7"))
            .unwrap()
            .commits
            .len(),
        1
    );
    let repo = service.repo(&handle).unwrap();
    let (running, started, release) = paused_search(repo, "matches-nothing");
    started
        .recv_timeout(std::time::Duration::from_secs(20))
        .unwrap();
    service.cancel_search(&handle).unwrap();
    release.send(()).unwrap();
    assert_eq!(running.join().unwrap().unwrap_err().code, "cancelled");
}

#[test]
fn closing_a_session_cancels_its_in_flight_search_with_code_cancelled() {
    let d = init();
    import_linear(d.path(), 50, |i| format!("scan {i}"));
    let (service, _data, handle) = service_for(d.path());
    let repo = service.repo(&handle).unwrap();
    let (running, started, release) = paused_search(repo, "matches-nothing");
    started
        .recv_timeout(std::time::Duration::from_secs(20))
        .unwrap();
    service.close(&handle).unwrap();
    release.send(()).unwrap();
    // The in-flight search reports `cancelled` (not invalidHandle); new lookups fail.
    assert_eq!(running.join().unwrap().unwrap_err().code, "cancelled");
    assert_eq!(service.repo(&handle).err().unwrap().code, "invalidHandle");
}
