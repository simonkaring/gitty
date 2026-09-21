use crate::{
    dto::*,
    process::{self, args},
    repository::{resolve, string, validate_path, Repository},
};
use std::collections::HashMap;

impl Repository {
    fn diff_args(&self, spec: &DiffSpec) -> Result<Vec<String>> {
        let mut a = args(&[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--find-renames",
            "--ignore-submodules=none",
        ]);
        match spec {
            DiffSpec::Commit { oid, parent } => {
                let commit = self.commit(oid)?;
                let base = if let Some(parent) = parent {
                    let id = resolve(self.location(), parent)?;
                    if !commit.summary.parents.contains(&id) {
                        return Err(Error::new(
                            "invalidParent",
                            "Selected parent is not a parent of this commit",
                        ));
                    }
                    id
                } else if let Some(id) = commit.summary.parents.first() {
                    id.clone()
                } else {
                    string(self.location(), &["hash-object", "-t", "tree", "--stdin"])?
                };
                a.extend([base, commit.summary.id]);
            }
            DiffSpec::Compare { base, target } => {
                a.extend([
                    resolve(self.location(), base)?,
                    resolve(self.location(), target)?,
                ]);
            }
            DiffSpec::Staged => {
                self.require_worktree()?;
                a.push("--cached".into());
            }
            DiffSpec::Unstaged => {
                self.require_worktree()?;
            }
            DiffSpec::Conflict => {
                self.require_worktree()?;
                a.push("--ours".into());
            }
            DiffSpec::Untracked => {
                return Err(Error::new(
                    "invalidDiff",
                    "Untracked diffs require a file path",
                ));
            }
        }
        Ok(a)
    }
    fn untracked_patch(&self, path: &str, stats: bool) -> Result<Vec<u8>> {
        validate_path(path)?;
        if !self
            .status_entries()?
            .entries
            .iter()
            .any(|e| e.path == path && e.untracked)
        {
            return Err(Error::new(
                "notUntracked",
                "The file is not currently untracked",
            ));
        }
        let mut a = args(&[
            "diff",
            "--no-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
        ]);
        a.push(if stats { "--numstat" } else { "--patch" }.into());
        if stats {
            a.push("-z".into());
        }
        a.extend(args(&["--", "/dev/null", path]));
        let output = process::git(self.location(), &a)?;
        if output.success || output.code == Some(1) {
            Ok(output.stdout)
        } else {
            Err(Error::new(
                "git",
                String::from_utf8_lossy(&output.stderr).into_owned(),
            ))
        }
    }
    pub fn diff_files(&self, spec: &DiffSpec) -> Result<Vec<DiffFile>> {
        if matches!(spec, DiffSpec::Untracked) {
            let status = self.status_entries()?;
            return status
                .entries
                .into_iter()
                .filter(|e| e.untracked)
                .map(|entry| {
                    let output = process::text(self.untracked_patch(&entry.path, true)?)?;
                    let mut f = output.splitn(3, '\t');
                    let a = if output.is_empty() {
                        Some(0)
                    } else {
                        f.next().unwrap_or("").parse().ok()
                    };
                    let d = if output.is_empty() {
                        Some(0)
                    } else {
                        f.next().unwrap_or("").parse().ok()
                    };
                    Ok(DiffFile {
                        path: entry.path,
                        old_path: None,
                        status: "A".into(),
                        additions: a,
                        deletions: d,
                        binary: a.is_none() || d.is_none(),
                    })
                })
                .collect();
        }
        let mut a = self.diff_args(spec)?;
        a.extend(args(&["--raw", "--numstat", "-z", "--no-abbrev", "--"]));
        let raw = process::text(process::checked(self.location(), &a)?)?;
        let mut files = parse_diff_files(&raw)?;
        if matches!(spec, DiffSpec::Conflict) {
            let status = self.status_entries()?;
            files.retain(|f| {
                status
                    .entries
                    .iter()
                    .any(|e| e.conflicted && e.path == f.path)
            });
            for f in &mut files {
                f.status = "U".into();
            }
        }
        Ok(files)
    }
    pub fn diff(&self, spec: &DiffSpec, path: &str) -> Result<FileDiff> {
        validate_path(path)?;
        let bytes = if matches!(spec, DiffSpec::Untracked) {
            self.untracked_patch(path, false)?
        } else {
            let files = self.diff_files(spec)?;
            let file = files.iter().find(|f| f.path == path).ok_or_else(|| {
                Error::new("fileNotInDiff", "File is not part of the selected diff")
            })?;
            let mut a = self.diff_args(spec)?;
            a.extend(args(&["--patch", "--unified=3", "--", path]));
            if let Some(old_path) = &file.old_path {
                a.push(old_path.clone());
            }
            process::checked(self.location(), &a)?
        };
        // Patch bodies may contain arbitrary blob bytes, unlike paths. Replacement characters are display-only.
        let mut diff = parse_patch(path, &String::from_utf8_lossy(&bytes))?;
        if matches!(spec, DiffSpec::Conflict) {
            let note = "Unmerged file: showing the working tree against stage 2 (ours). Conflict resolution is read-only.";
            diff.message = Some(match diff.message {
                Some(m) => format!("{note}\n{m}"),
                None => note.into(),
            });
        }
        Ok(diff)
    }
}

pub fn parse_diff_files(raw: &str) -> Result<Vec<DiffFile>> {
    let mut records = raw.split('\0').peekable();
    let mut files: Vec<DiffFile> = vec![];
    let mut indices: HashMap<String, usize> = HashMap::new();
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        if record.starts_with(':') {
            let fields: Vec<_> = record.split_whitespace().collect();
            if fields.len() != 5 {
                return Err(Error::new("gitParse", "Malformed raw diff record"));
            }
            let code = fields[4].chars().next().unwrap_or('M').to_string();
            let first = records
                .next()
                .ok_or_else(|| Error::new("gitParse", "Missing diff path"))?;
            let (path, old_path) = if code == "R" || code == "C" {
                (
                    records
                        .next()
                        .ok_or_else(|| Error::new("gitParse", "Missing rename target"))?,
                    Some(first.into()),
                )
            } else {
                (first, None)
            };
            // Unmerged raw output can include both U and M records for the same file.
            if let Some(&i) = indices.get(path) {
                if code == "U" {
                    files[i].status = code;
                }
                continue;
            }
            indices.insert(path.to_string(), files.len());
            files.push(DiffFile {
                path: path.into(),
                old_path,
                status: code,
                additions: Some(0),
                deletions: Some(0),
                binary: false,
            });
        } else {
            let f: Vec<_> = record.splitn(3, '\t').collect();
            if f.len() != 3 {
                return Err(Error::new("gitParse", "Malformed numstat record"));
            }
            let path = if f[2].is_empty() {
                records
                    .next()
                    .ok_or_else(|| Error::new("gitParse", "Missing numstat rename source"))?;
                records
                    .next()
                    .ok_or_else(|| Error::new("gitParse", "Missing numstat rename target"))?
            } else {
                f[2]
            };
            if let Some(&i) = indices.get(path) {
                let file = &mut files[i];
                file.additions = f[0].parse().ok();
                file.deletions = f[1].parse().ok();
                file.binary = f[0] == "-" || f[1] == "-";
            }
        }
    }
    Ok(files)
}
pub fn parse_patch(path: &str, raw: &str) -> Result<FileDiff> {
    let mut hunks: Vec<DiffHunk> = vec![];
    let mut metadata = vec![];
    let mut binary = false;
    let mut truncated = false;
    let mut old = 0u64;
    let mut new = 0u64;
    let mut count = 0;
    for line in raw.split_terminator('\n') {
        if line.starts_with("@@ ") {
            let f: Vec<_> = line.split_whitespace().collect();
            old = f
                .get(1)
                .and_then(|s| s.strip_prefix('-'))
                .and_then(|s| s.split(',').next())
                .and_then(|s| s.parse().ok())
                .ok_or_else(|| Error::new("gitParse", "Invalid old hunk range"))?;
            new = f
                .get(2)
                .and_then(|s| s.strip_prefix('+'))
                .and_then(|s| s.split(',').next())
                .and_then(|s| s.parse().ok())
                .ok_or_else(|| Error::new("gitParse", "Invalid new hunk range"))?;
            hunks.push(DiffHunk {
                header: line.into(),
                lines: vec![],
            });
            continue;
        }
        if line.starts_with("diff --git ") {
            continue;
        }
        if line.starts_with("Binary files ") || line == "GIT binary patch" {
            binary = true;
            metadata.push(line.to_string());
            continue;
        }
        if let Some(hunk) = hunks.last_mut() {
            count += 1;
            if count > 20_000 {
                truncated = true;
                break;
            }
            let (kind, content, old_line, new_line) = match line.as_bytes().first() {
                Some(b' ') => {
                    let o = old;
                    let n = new;
                    old += 1;
                    new += 1;
                    ("context", &line[1..], Some(o), Some(n))
                }
                Some(b'+') => {
                    let n = new;
                    new += 1;
                    ("add", &line[1..], None, Some(n))
                }
                Some(b'-') => {
                    let o = old;
                    old += 1;
                    ("remove", &line[1..], Some(o), None)
                }
                _ => ("meta", line, None, None),
            };
            hunk.lines.push(DiffLine {
                kind: kind.into(),
                content: content.into(),
                old_line,
                new_line,
            });
        } else if !line.starts_with("--- ") && !line.starts_with("+++ ") && !line.is_empty() {
            metadata.push(line.into());
        }
    }
    if truncated {
        metadata.push("Patch display truncated after 20,000 lines.".into());
    }
    Ok(FileDiff {
        path: path.into(),
        hunks,
        binary,
        truncated,
        message: if metadata.is_empty() {
            None
        } else {
            Some(metadata.join("\n"))
        },
    })
}
