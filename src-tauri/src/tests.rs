use crate::{dto::*, repository::Service};
use std::{path::Path, process::Command};
use tempfile::TempDir;

fn git(path: &Path, args: &[&str]) -> String {
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
fn init() -> TempDir {
    let d = tempfile::tempdir().unwrap();
    git(d.path(), &["init", "-b", "main"]);
    git(d.path(), &["config", "user.name", "Test Author"]);
    git(d.path(), &["config", "user.email", "test@example.com"]);
    d
}
fn commit(path: &Path, message: &str) -> String {
    git(path, &["add", "--all"]);
    git(path, &["commit", "-m", message]);
    git(path, &["rev-parse", "HEAD"])
}
fn open(service: &mut Service, path: &Path) -> RepositoryState {
    service
        .open(RepositoryLocation::Native {
            path: path.to_str().unwrap().into(),
        })
        .unwrap()
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
        let raw = format!("tree {tree}\n{parents}author Zoë 工作 <zoe@example.org> 1700000000 +1245\ncommitter Test <test@example.org> 1700000001 +0000\n\n{body}");
        (store_commit(d.path(), raw.as_bytes()), body)
    };
    let root = make(&[], "Røøt");
    let left = make(&[&root.0], "Left 🦀");
    let right = make(&[&root.0], "Right 工作");
    let merge = make(&[&left.0, &right.0], "Merge é");
    git(d.path(), &["update-ref", "refs/heads/main", &merge.0]);
    let expected = git(d.path(), &["rev-list", "--topo-order", "HEAD"]);
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
