use crate::{dto::*, repository::Service};
use std::{fs, path::Path, process::Command};
use tempfile::TempDir;

fn git(root: &Path, args: &[&str]) -> Vec<u8> {
    let o = Command::new("git")
        .arg("-C")
        .arg(root)
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
        "{args:?}: {}",
        String::from_utf8_lossy(&o.stderr)
    );
    o.stdout
}
struct Fixture {
    root: TempDir,
    _data: TempDir,
    service: Service,
    handle: String,
}
impl Fixture {
    fn new(path: &str, bytes: &[u8]) -> Self {
        let root = tempfile::tempdir().unwrap();
        git(root.path(), &["init", "-b", "main"]);
        for (key, value) in [
            ("user.name", "Hunk Test"),
            ("user.email", "hunk@example.com"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
        ] {
            git(root.path(), &["config", key, value]);
        }
        fs::write(root.path().join(path), bytes).unwrap();
        git(root.path(), &["add", "--", path]);
        git(root.path(), &["commit", "-qm", "base"]);
        let data = tempfile::tempdir().unwrap();
        let service = Service::new(data.path().into());
        let state = service
            .open(RepositoryLocation::Native {
                path: root.path().to_str().unwrap().into(),
            })
            .unwrap();
        Self {
            root,
            _data: data,
            service,
            handle: state.session.handle,
        }
    }
    fn write(&self, path: &str, bytes: &[u8]) {
        fs::write(self.root.path().join(path), bytes).unwrap();
    }
    fn diff(&self, path: &str, reverse: bool) -> FileDiff {
        self.service
            .repo(&self.handle)
            .unwrap()
            .diff(
                &if reverse {
                    DiffSpec::Staged
                } else {
                    DiffSpec::Unstaged
                },
                path,
            )
            .unwrap()
    }
    fn apply(&self, path: &str, index: usize, reverse: bool) {
        let d = self.diff(path, reverse);
        let fp = d.hunk_action.unwrap().fingerprint.expect("actionable");
        if reverse {
            self.service
                .unstage_hunk(&self.handle, path, index, &fp, None)
        } else {
            self.service
                .stage_hunk(&self.handle, path, index, &fp, None)
        }
        .unwrap();
    }
    fn apply_lines(&self, path: &str, index: usize, lines: &[usize], reverse: bool) {
        let d = self.diff(path, reverse);
        let fp = d.hunk_action.unwrap().fingerprint.expect("actionable");
        if reverse {
            self.service
                .unstage_hunk(&self.handle, path, index, &fp, Some(lines.to_vec()))
        } else {
            self.service
                .stage_hunk(&self.handle, path, index, &fp, Some(lines.to_vec()))
        }
        .unwrap();
    }
    fn indexed(&self, path: &str) -> Vec<u8> {
        git(self.root.path(), &["show", &format!(":{path}")])
    }
}
fn lines() -> String {
    (0..60).map(|i| format!("line {i:02}\n")).collect()
}

#[test]
fn stage_and_commit_only_selected_hunk_preserves_worktree_and_other_staged_edits() {
    let base = lines();
    let f = Fixture::new("file", base.as_bytes());
    let changed = base
        .replace("line 02\n", "first edit\n")
        .replace("line 45\n", "second edit\n");
    f.write("file", changed.as_bytes());
    assert_eq!(f.diff("file", false).hunks.len(), 2);
    f.apply("file", 1, false);
    let selected = base.replace("line 45\n", "second edit\n");
    assert_eq!(f.indexed("file"), selected.as_bytes());
    assert_eq!(
        fs::read(f.root.path().join("file")).unwrap(),
        changed.as_bytes()
    );
    f.service.create_commit(&f.handle, "selected only").unwrap();
    assert_eq!(
        git(f.root.path(), &["show", "HEAD:file"]),
        selected.as_bytes()
    );
    assert_eq!(f.diff("file", false).hunks.len(), 1);
    // A separate staged path and a pre-existing edit in this file survive.
    f.write("other", b"keep staged\n");
    git(f.root.path(), &["add", "other"]);
    f.apply("file", 0, false);
    assert_eq!(f.indexed("other"), b"keep staged\n");
    assert_eq!(f.indexed("file"), changed.as_bytes());
    f.apply("file", 0, true);
    assert_eq!(f.indexed("file"), selected.as_bytes());
    assert_eq!(f.indexed("other"), b"keep staged\n");
    assert_eq!(
        fs::read(f.root.path().join("file")).unwrap(),
        changed.as_bytes()
    );
}

#[test]
fn omitted_hunks_do_not_shift_selected_insertions_or_reverse_deletions() {
    let base = lines();
    let f = Fixture::new("file", base.as_bytes());
    let first = base.replace("line 02\n", "extra a\nextra b\nline 02\n");
    let both = first.replace("line 45\nline 46\n", "replacement\n");
    f.write("file", both.as_bytes());
    f.apply("file", 1, false);
    assert_eq!(
        f.indexed("file"),
        base.replace("line 45\nline 46\n", "replacement\n")
            .as_bytes()
    );
    f.apply("file", 0, false);
    assert_eq!(f.indexed("file"), both.as_bytes());
    f.apply("file", 1, true);
    assert_eq!(f.indexed("file"), first.as_bytes());
    f.apply("file", 0, true);
    assert_eq!(f.indexed("file"), base.as_bytes());
    assert_eq!(
        fs::read(f.root.path().join("file")).unwrap(),
        both.as_bytes()
    );
}

#[test]
fn rejects_stale_worktree_index_direction_and_invalid_selection_without_writing() {
    let base = lines();
    let f = Fixture::new("file", base.as_bytes());
    let changed = base.replace("line 02", "edited!");
    f.write("file", changed.as_bytes());
    let fp = f
        .diff("file", false)
        .hunk_action
        .unwrap()
        .fingerprint
        .unwrap();
    f.write("file", changed.replace("line 50", "outside").as_bytes());
    assert_eq!(
        f.service
            .stage_hunk(&f.handle, "file", 0, &fp, None)
            .unwrap_err()
            .code,
        "staleDiff"
    );
    assert_eq!(f.indexed("file"), base.as_bytes());
    let fp = f
        .diff("file", false)
        .hunk_action
        .unwrap()
        .fingerprint
        .unwrap();
    assert_eq!(
        f.service
            .stage_hunk(&f.handle, "file", 999, &fp, None)
            .unwrap_err()
            .code,
        "invalidHunk"
    );
    // An external index edit invalidates the previous display, even if context matches.
    git(f.root.path(), &["add", "file"]);
    assert_eq!(
        f.service
            .stage_hunk(&f.handle, "file", 0, &fp, None)
            .unwrap_err()
            .code,
        "staleDiff"
    );
    assert_eq!(
        f.service
            .unstage_hunk(&f.handle, "file", 0, &fp, None)
            .unwrap_err()
            .code,
        "staleDiff"
    );
    let staged_fp = f
        .diff("file", true)
        .hunk_action
        .unwrap()
        .fingerprint
        .unwrap();
    f.write("file", base.replace("line 30", "external").as_bytes());
    git(f.root.path(), &["add", "file"]);
    let before = f.indexed("file");
    assert_eq!(
        f.service
            .unstage_hunk(&f.handle, "file", 0, &staged_fp, None)
            .unwrap_err()
            .code,
        "staleDiff"
    );
    assert_eq!(f.indexed("file"), before);
}

#[test]
fn raw_bytes_crlf_missing_newline_and_quoted_paths_round_trip() {
    let path = if cfg!(windows) {
        "space ü.txt"
    } else {
        "-odd\tname\nü.txt"
    };
    let base = lines().replace('\n', "\r\n").into_bytes();
    let mut base = [base, b"tail \xff".to_vec()].concat();
    // A function heading containing non-UTF8 must also remain display-only.
    base.splice(0..0, b"function \xfe() {\r\n".iter().copied());
    let f = Fixture::new(path, &base);
    let mut changed = base.clone();
    let p = changed.windows(7).position(|w| w == b"line 02").unwrap();
    changed.splice(p..p + 7, b"edit \xfd".iter().copied());
    changed.extend_from_slice(b" more \xfc");
    f.write(path, &changed);
    assert_eq!(f.diff(path, false).hunks.len(), 2);
    let fp = f
        .diff(path, false)
        .hunk_action
        .unwrap()
        .fingerprint
        .unwrap();
    let mut same_display = changed.clone();
    let p = same_display.iter().position(|b| *b == 0xfd).unwrap();
    same_display[p] = 0xfb;
    assert_eq!(
        String::from_utf8_lossy(&changed),
        String::from_utf8_lossy(&same_display)
    );
    f.write(path, &same_display);
    assert_eq!(
        f.service
            .stage_hunk(&f.handle, path, 1, &fp, None)
            .unwrap_err()
            .code,
        "staleDiff"
    );
    f.write(path, &changed);
    f.apply(path, 1, false);
    let selected = [base.clone(), b" more \xfc".to_vec()].concat();
    assert_eq!(f.indexed(path), selected);
    f.apply(path, 0, false);
    assert_eq!(f.indexed(path), changed);
    f.apply(path, 1, true);
    f.apply(path, 0, true);
    assert_eq!(f.indexed(path), base);
    assert_eq!(fs::read(f.root.path().join(path)).unwrap(), changed);
}

#[test]
fn deterministic_diff_ignores_display_configuration() {
    let base = lines();
    let f = Fixture::new("file", base.as_bytes());
    f.write(
        "file",
        base.replace("line 02", "first")
            .replace("line 45", "last")
            .as_bytes(),
    );
    let before = f.diff("file", false);
    for (key, value) in [
        ("diff.context", "100"),
        ("diff.interHunkContext", "100"),
        ("diff.algorithm", "histogram"),
        ("diff.noprefix", "true"),
        ("diff.mnemonicPrefix", "true"),
        ("diff.suppressBlankEmpty", "true"),
        ("diff.relative", "true"),
        ("apply.ignoreWhitespace", "change"),
        ("apply.whitespace", "fix"),
    ] {
        git(f.root.path(), &["config", key, value]);
    }
    let after = f.diff("file", false);
    assert_eq!(after.hunks.len(), 2);
    assert_eq!(
        before.hunk_action.unwrap().fingerprint,
        after.hunk_action.unwrap().fingerprint
    );
    f.apply("file", 1, false);
    assert_eq!(
        f.indexed("file"),
        base.replace("line 45", "last").as_bytes()
    );
}

#[test]
fn empty_ranges_and_final_newline_transitions_round_trip() {
    for (before, after) in [
        ("", "new\n"),
        ("old\n", ""),
        ("old\n", "old"),
        ("old", "old\n"),
    ] {
        let f = Fixture::new("file", before.as_bytes());
        f.write("file", after.as_bytes());
        f.apply("file", 0, false);
        assert_eq!(f.indexed("file"), after.as_bytes());
        f.apply("file", 0, true);
        assert_eq!(f.indexed("file"), before.as_bytes());
        assert_eq!(
            fs::read(f.root.path().join("file")).unwrap(),
            after.as_bytes()
        );
    }
}

#[test]
fn external_index_lock_is_respected_and_unrelated_external_staging_is_preserved() {
    let f = Fixture::new("file", b"before\n");
    f.write("file", b"after\n");
    let fp = f
        .diff("file", false)
        .hunk_action
        .unwrap()
        .fingerprint
        .unwrap();
    // Another process can stage an unrelated path after display; it must survive.
    f.write("other", b"external staged edit\n");
    git(f.root.path(), &["add", "other"]);
    let lock = f.root.path().join(".git/index.lock");
    fs::write(&lock, b"external lock").unwrap();
    assert_eq!(
        f.service
            .stage_hunk(&f.handle, "file", 0, &fp, None)
            .unwrap_err()
            .code,
        "indexLocked"
    );
    assert_eq!(fs::read(&lock).unwrap(), b"external lock");
    fs::remove_file(lock).unwrap();
    f.service
        .stage_hunk(&f.handle, "file", 0, &fp, None)
        .unwrap();
    assert_eq!(f.indexed("file"), b"after\n");
    assert_eq!(f.indexed("other"), b"external staged edit\n");
}

fn unsupported(f: &Fixture, path: &str, reverse: bool) {
    let d = f.diff(path, reverse);
    let a = d.hunk_action.unwrap();
    assert!(a.fingerprint.is_none(), "{path} must not be actionable");
    assert!(a.reason.unwrap().contains("whole-file"));
    let e = if reverse {
        f.service.unstage_hunk(&f.handle, path, 0, "forged", None)
    } else {
        f.service.stage_hunk(&f.handle, path, 0, "forged", None)
    }
    .unwrap_err();
    assert_eq!(e.code, "unsupportedHunk");
}

#[test]
fn binary_rename_add_delete_and_truncated_previews_are_read_only() {
    let base = lines();
    let f = Fixture::new("file", base.as_bytes());
    f.write("file", b"binary\0data");
    unsupported(&f, "file", false);
    // A forced text diff must not make NUL-containing blobs actionable.
    f.write(".gitattributes", b"file diff\n");
    unsupported(&f, "file", false);
    f.write("file", base.as_bytes());
    git(f.root.path(), &["mv", "file", "renamed"]);
    f.write("renamed", base.replace("line 02", "changed").as_bytes());
    git(f.root.path(), &["add", "renamed"]);
    unsupported(&f, "renamed", true);
    f.write("added", b"new file\n");
    git(f.root.path(), &["add", "added"]);
    unsupported(&f, "added", true);
    fs::remove_file(f.root.path().join("renamed")).unwrap();
    unsupported(&f, "renamed", false);
    let huge = "many\n".repeat(20_001);
    f.write("renamed", huge.as_bytes());
    assert!(f.diff("renamed", false).truncated);
    unsupported(&f, "renamed", false);
}

#[cfg(unix)]
#[test]
fn mode_changes_and_symlinks_are_read_only() {
    use std::os::unix::{fs::symlink, fs::PermissionsExt};
    let f = Fixture::new("file", b"before\n");
    git(f.root.path(), &["config", "core.filemode", "true"]);
    f.write("file", b"after\n");
    fs::set_permissions(
        f.root.path().join("file"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    unsupported(&f, "file", false);
    git(f.root.path(), &["add", "file"]);
    unsupported(&f, "file", true);
    symlink("before", f.root.path().join("link")).unwrap();
    git(f.root.path(), &["add", "link"]);
    git(f.root.path(), &["commit", "-qm", "link"]);
    fs::remove_file(f.root.path().join("link")).unwrap();
    symlink("after", f.root.path().join("link")).unwrap();
    unsupported(&f, "link", false);
}

#[test]
fn oversized_diff_has_explicit_fallback_and_whole_file_staging_still_works() {
    let f = Fixture::new("file", b"base\n");
    let mut large = vec![b'x'; 32 * 1024 * 1024 + 1];
    large.push(b'\n');
    f.write("file", &large);
    let error = f
        .service
        .repo(&f.handle)
        .unwrap()
        .diff(&DiffSpec::Unstaged, "file")
        .unwrap_err();
    assert_eq!(error.code, "outputLimit");
    assert!(error.message.contains("whole-file"));
    assert_eq!(
        f.service
            .stage_hunk(&f.handle, "file", 0, "forged", None)
            .unwrap_err()
            .code,
        "outputLimit"
    );
    assert_eq!(f.indexed("file"), b"base\n");
    f.service.stage(&f.handle, &["file".into()]).unwrap();
    assert_eq!(
        git(f.root.path(), &["rev-parse", ":file"]),
        git(f.root.path(), &["hash-object", "file"])
    );
    f.service.unstage(&f.handle, &["file".into()]).unwrap();
    assert_eq!(f.indexed("file"), b"base\n");
    assert_eq!(
        fs::metadata(f.root.path().join("file")).unwrap().len(),
        large.len() as u64
    );
}

#[test]
fn line_staging_adjacent_additions_deletions_and_replacements() {
    let base = lines();
    let f = Fixture::new("file", base.as_bytes());
    let changed = base
        .replace("line 02\n", "new 02a\nnew 02b\nnew 02c\n")
        .replace("line 03\n", "")
        .replace("line 05\n", "edited 05\n");
    f.write("file", changed.as_bytes());

    let d = f.diff("file", false);
    assert_eq!(d.hunks.len(), 1);
    let hunk = &d.hunks[0];

    // Find indices:
    let idx_02b = hunk
        .lines
        .iter()
        .position(|l| l.kind == "add" && l.content == "new 02b")
        .unwrap();

    // Stage only 'new 02b':
    f.apply_lines("file", 0, &[idx_02b], false);

    // Verify index has line 02, line 03, and new 02b (git diff puts removals before additions)
    let idx_bytes = f.indexed("file");
    let idx_str = String::from_utf8(idx_bytes).unwrap();
    assert!(idx_str.contains("line 02\nline 03\nnew 02b\nline 04\n"));
    assert!(!idx_str.contains("new 02a"));
    assert!(!idx_str.contains("edited 05"));
    // Worktree file is untouched:
    assert_eq!(
        fs::read(f.root.path().join("file")).unwrap(),
        changed.as_bytes()
    );

    // Now stage deletion of line 03:
    let d2 = f.diff("file", false);
    let hunk2 = &d2.hunks[0];
    let idx_del_03_now = hunk2
        .lines
        .iter()
        .position(|l| l.kind == "remove" && l.content == "line 03")
        .unwrap();
    f.apply_lines("file", 0, &[idx_del_03_now], false);

    let idx_bytes2 = f.indexed("file");
    let idx_str2 = String::from_utf8(idx_bytes2).unwrap();
    assert!(!idx_str2.contains("line 03\n"));
    assert!(idx_str2.contains("line 02\nnew 02b\nline 04\n"));

    // Now in staged diff, unstage 'new 02b':
    let staged_d = f.diff("file", true);
    let staged_hunk = &staged_d.hunks[0];
    let idx_staged_02b = staged_hunk
        .lines
        .iter()
        .position(|l| l.kind == "add" && l.content == "new 02b")
        .unwrap();
    f.apply_lines("file", 0, &[idx_staged_02b], true);

    let idx_bytes3 = f.indexed("file");
    let idx_str3 = String::from_utf8(idx_bytes3).unwrap();
    assert!(!idx_str3.contains("new 02b"));
    // line 03 deletion is still staged:
    assert!(!idx_str3.contains("line 03\n"));

    // Now unstage the deletion of line 03:
    let staged_d2 = f.diff("file", true);
    let staged_hunk2 = &staged_d2.hunks[0];
    let idx_staged_del_03 = staged_hunk2
        .lines
        .iter()
        .position(|l| l.kind == "remove" && l.content == "line 03")
        .unwrap();
    f.apply_lines("file", 0, &[idx_staged_del_03], true);

    // Everything is back to base in the index:
    assert_eq!(f.indexed("file"), base.as_bytes());
    // Worktree still has all changes:
    assert_eq!(
        fs::read(f.root.path().join("file")).unwrap(),
        changed.as_bytes()
    );
}

#[test]
fn line_staging_at_hunk_start_end_and_discontiguous_selections() {
    let base = lines();
    let f = Fixture::new("file", base.as_bytes());
    let mut changed = format!("lead 1\nlead 2\n{base}");
    changed = changed.replace("line 25\nline 26\n", "mid 1\nmid 2\n");
    changed.push_str("tail 1\ntail 2\n");
    f.write("file", changed.as_bytes());

    let d = f.diff("file", false);
    // Hunk 0 starts at beginning of file with additions
    let h0 = &d.hunks[0];
    let idx_lead2 = h0
        .lines
        .iter()
        .position(|l| l.kind == "add" && l.content == "lead 2")
        .unwrap();
    f.apply_lines("file", 0, &[idx_lead2], false);

    let idx_str = String::from_utf8(f.indexed("file")).unwrap();
    assert!(idx_str.starts_with("lead 2\nline 00\n"));
    assert!(!idx_str.contains("lead 1\n"));

    // Tail additions in the last hunk:
    let d_last = f.diff("file", false);
    let last_hunk_idx = d_last.hunks.len() - 1;
    let h_last = &d_last.hunks[last_hunk_idx];
    let idx_tail1 = h_last
        .lines
        .iter()
        .position(|l| l.kind == "add" && l.content == "tail 1")
        .unwrap();
    f.apply_lines("file", last_hunk_idx, &[idx_tail1], false);

    let idx_str2 = String::from_utf8(f.indexed("file")).unwrap();
    assert!(idx_str2.ends_with("line 59\ntail 1\n"));
    assert!(!idx_str2.contains("tail 2\n"));

    // Middle hunk: discontiguous selection of an add and a remove:
    let d_mid = f.diff("file", false);
    let h_mid = &d_mid.hunks[1];
    let idx_rem_25 = h_mid
        .lines
        .iter()
        .position(|l| l.kind == "remove" && l.content == "line 25")
        .unwrap();
    let idx_add_mid2 = h_mid
        .lines
        .iter()
        .position(|l| l.kind == "add" && l.content == "mid 2")
        .unwrap();
    f.apply_lines("file", 1, &[idx_rem_25, idx_add_mid2], false);

    let idx_str3 = String::from_utf8(f.indexed("file")).unwrap();
    assert!(!idx_str3.contains("line 25\n"));
    assert!(idx_str3.contains("line 26\n")); // unselected removal remained in index!
    assert!(idx_str3.contains("mid 2\n"));
    assert!(!idx_str3.contains("mid 1\n")); // unselected addition not in index!
}

#[test]
fn line_staging_multiple_hunks_with_earlier_omitted_deltas() {
    let base = lines();
    let f = Fixture::new("file", base.as_bytes());
    // Hunk 0 adds 20 lines at line 02
    let extra_20: String = (0..20).map(|i| format!("extra {i}\n")).collect();
    let changed = base
        .replace("line 02\n", &format!("line 02\n{extra_20}"))
        .replace("line 45\n", "target edit\n");
    f.write("file", changed.as_bytes());

    let d = f.diff("file", false);
    assert_eq!(d.hunks.len(), 2);
    // Hunk 1 is at line 45. Stage only 'target edit' from Hunk 1 without staging Hunk 0!
    let h1 = &d.hunks[1];
    let idx_target = h1
        .lines
        .iter()
        .position(|l| l.kind == "add" && l.content == "target edit")
        .unwrap();
    let idx_remove_45 = h1
        .lines
        .iter()
        .position(|l| l.kind == "remove" && l.content == "line 45")
        .unwrap();
    f.apply_lines("file", 1, &[idx_target, idx_remove_45], false);

    let idx_str = String::from_utf8(f.indexed("file")).unwrap();
    assert!(idx_str.contains("line 44\ntarget edit\nline 46\n"));
    assert!(!idx_str.contains("extra 0\n"));

    // Now unstage 'target edit' from staged diff:
    let staged_d = f.diff("file", true);
    let staged_hunk = &staged_d.hunks[0];
    let idx_staged_target = staged_hunk
        .lines
        .iter()
        .position(|l| l.kind == "add" && l.content == "target edit")
        .unwrap();
    let idx_staged_rem_45 = staged_hunk
        .lines
        .iter()
        .position(|l| l.kind == "remove" && l.content == "line 45")
        .unwrap();
    f.apply_lines("file", 0, &[idx_staged_target, idx_staged_rem_45], true);

    assert_eq!(f.indexed("file"), base.as_bytes());
}

#[test]
fn line_staging_pure_additions_empty_ranges_and_pure_deletions() {
    let f = Fixture::new("file", b"line A\nline B\nline C\n");
    // Delete all lines
    f.write("file", b"");
    let d = f.diff("file", false);
    let hunk = &d.hunks[0];
    let idx_b = hunk
        .lines
        .iter()
        .position(|l| l.kind == "remove" && l.content == "line B")
        .unwrap();
    f.apply_lines("file", 0, &[idx_b], false);

    // Only line B deleted in index:
    assert_eq!(f.indexed("file"), b"line A\nline C\n");

    // Unstage line B deletion:
    let staged_d = f.diff("file", true);
    let staged_hunk = &staged_d.hunks[0];
    let idx_staged_b = staged_hunk
        .lines
        .iter()
        .position(|l| l.kind == "remove" && l.content == "line B")
        .unwrap();
    f.apply_lines("file", 0, &[idx_staged_b], true);
    assert_eq!(f.indexed("file"), b"line A\nline B\nline C\n");

    // Pure addition to an empty file
    let f2 = Fixture::new("empty", b"");
    f2.write("empty", b"first\nsecond\nthird\n");
    let d2 = f2.diff("empty", false);
    let hunk2 = &d2.hunks[0];
    let idx_second = hunk2
        .lines
        .iter()
        .position(|l| l.kind == "add" && l.content == "second")
        .unwrap();
    f2.apply_lines("empty", 0, &[idx_second], false);
    assert_eq!(f2.indexed("empty"), b"second\n");

    let staged_d2 = f2.diff("empty", true);
    let staged_hunk2 = &staged_d2.hunks[0];
    let idx_staged_second = staged_hunk2
        .lines
        .iter()
        .position(|l| l.kind == "add" && l.content == "second")
        .unwrap();
    f2.apply_lines("empty", 0, &[idx_staged_second], true);
    assert_eq!(f2.indexed("empty"), b"");
}

#[test]
fn line_staging_crlf_invalid_utf8_and_quoted_paths() {
    let path = if cfg!(windows) {
        "space ü.txt"
    } else {
        "-odd\tname\nü.txt"
    };
    let base = b"line 01\r\nline 02\r\nline 03\r\n\xff\r\n";
    let f = Fixture::new(path, base);
    let changed = b"line 01\r\nline 02 modified\r\nline 02b\r\nline 03\r\n\xff\r\n";
    f.write(path, changed);

    let d = f.diff(path, false);
    let hunk = &d.hunks[0];
    let idx_02b = hunk
        .lines
        .iter()
        .position(|l| l.kind == "add" && l.content.contains("line 02b"))
        .unwrap();
    f.apply_lines(path, 0, &[idx_02b], false);

    let idx_bytes = f.indexed(path);
    assert!(idx_bytes.ends_with(b"\xff\r\n"));
    assert!(idx_bytes.windows(10).any(|w| w == b"line 02b\r\n"));

    let staged_d = f.diff(path, true);
    let staged_hunk = &staged_d.hunks[0];
    let idx_staged_02b = staged_hunk
        .lines
        .iter()
        .position(|l| l.kind == "add" && l.content.contains("line 02b"))
        .unwrap();
    f.apply_lines(path, 0, &[idx_staged_02b], true);
    assert_eq!(f.indexed(path), base);
}

#[test]
fn line_staging_validation_rejects_invalid_selections_without_modifying_state() {
    let base = lines();
    let f = Fixture::new("file", base.as_bytes());
    f.write("file", base.replace("line 02\n", "edited 02\n").as_bytes());
    let d = f.diff("file", false);
    let fp = d.hunk_action.unwrap().fingerprint.unwrap();

    // 1. Empty selection
    let err = f
        .service
        .stage_hunk(&f.handle, "file", 0, &fp, Some(vec![]))
        .unwrap_err();
    assert_eq!(err.code, "invalidSelection");
    assert!(err.message.contains("Select one or more"));

    // 2. Out of range
    let err = f
        .service
        .stage_hunk(&f.handle, "file", 0, &fp, Some(vec![9999]))
        .unwrap_err();
    assert_eq!(err.code, "invalidSelection");
    assert!(err.message.contains("out of range"));

    // 3. Duplicates
    let hunk = &d.hunks[0];
    let add_idx = hunk.lines.iter().position(|l| l.kind == "add").unwrap();
    let err = f
        .service
        .stage_hunk(&f.handle, "file", 0, &fp, Some(vec![add_idx, add_idx]))
        .unwrap_err();
    assert_eq!(err.code, "invalidSelection");
    assert!(err.message.contains("Duplicate"));

    // 4. Selecting a context line
    let ctx_idx = hunk.lines.iter().position(|l| l.kind == "context").unwrap();
    let err = f
        .service
        .stage_hunk(&f.handle, "file", 0, &fp, Some(vec![ctx_idx]))
        .unwrap_err();
    assert_eq!(err.code, "invalidSelection");
    assert!(err.message.contains("Only changed lines"));

    // 5. Stale fingerprint
    let err = f
        .service
        .stage_hunk(&f.handle, "file", 0, "stale-fp", Some(vec![add_idx]))
        .unwrap_err();
    assert_eq!(err.code, "staleDiff");

    // State is untouched:
    assert_eq!(f.indexed("file"), base.as_bytes());
}

#[test]
fn line_staging_unsupported_newline_eof_transitions_rejected_cleanly() {
    let f = Fixture::new("file", b"old");
    f.write("file", b"old\nnew\n");
    let d = f.diff("file", false);
    let hunk = &d.hunks[0];
    // In this diff, -old lacked a newline. If we only select +new:
    let add_new_idx = hunk
        .lines
        .iter()
        .position(|l| l.kind == "add" && l.content == "new")
        .unwrap();
    let fp = d.hunk_action.unwrap().fingerprint.unwrap();
    let err = f
        .service
        .stage_hunk(&f.handle, "file", 0, &fp, Some(vec![add_new_idx]))
        .unwrap_err();
    assert_eq!(err.code, "unsupportedHunk");
    assert!(err.message.contains("newline-at-EOF"));
    assert_eq!(f.indexed("file"), b"old");
}
