use crate::{
    dto::*,
    process::{self, args},
    repository::{resolve, string, validate_path, Repository},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::collections::HashMap;

const IMAGE_LIMIT: usize = 16 * 1024 * 1024;

fn image_mime(path: &str) -> Option<&'static str> {
    Some(
        match path.rsplit_once('.')?.1.to_ascii_lowercase().as_str() {
            "svg" => "image/svg+xml",
            "png" | "apng" => "image/png",
            "jpg" | "jpeg" | "jfif" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "bmp" | "dib" => "image/bmp",
            "ico" | "cur" => "image/x-icon",
            "avif" => "image/avif",
            "tif" | "tiff" => "image/tiff",
            "heic" => "image/heic",
            "heif" => "image/heif",
            "jxl" => "image/jxl",
            _ => return None,
        },
    )
}

impl Repository {
    fn diff_args(&self, spec: &DiffSpec) -> Result<Vec<String>> {
        let mut a = args(&[
            "-c",
            "diff.suppressBlankEmpty=false",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--find-renames",
            "--ignore-submodules=none",
            "--full-index",
            "--diff-algorithm=myers",
            "--no-indent-heuristic",
            "--inter-hunk-context=0",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--line-prefix=",
            "--no-relative",
            "--output-indicator-new=+",
            "--output-indicator-old=-",
            "--output-indicator-context= ",
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
    fn require_untracked(&self, path: &str) -> Result<()> {
        if !self
            .status_entries_at(Some(path))?
            .entries
            .iter()
            .any(|e| e.path == path && e.untracked)
        {
            return Err(Error::new(
                "notUntracked",
                "The file is not currently untracked",
            ));
        }
        Ok(())
    }

    fn untracked_patch(&self, path: &str) -> Result<Vec<u8>> {
        let a = args(&[
            "diff",
            "--no-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--patch",
            "--",
            "/dev/null",
            path,
        ]);
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
        self.read_diff(spec, path, false)
    }
    pub fn preview_diff(&self, spec: &DiffSpec, path: &str) -> Result<FileDiff> {
        self.read_diff(spec, path, true)
    }
    fn read_diff(&self, spec: &DiffSpec, path: &str, images: bool) -> Result<FileDiff> {
        self.diff_with_patch(spec, path, images)
            .map(|(diff, _)| diff)
            .map_err(|e| {
                if e.code == "outputLimit" {
                    Error::new("outputLimit", "The diff exceeds the preview size limit. Hunk actions are unavailable; use the whole-file buttons or Git.")
                } else {
                    e
                }
            })
    }

    fn image_side(
        &self,
        path: &str,
        entry: Option<&(String, String)>,
        working: bool,
    ) -> Option<ImageSide> {
        if entry.is_some_and(|(mode, _)| mode == "000000") {
            return None;
        }
        let data = (|| {
            let mime = image_mime(path)
                .ok_or_else(|| Error::new("imageUnavailable", "Unsupported image format."))?;
            let bytes = match entry {
                Some((mode, oid)) if matches!(mode.as_str(), "100644" | "100755") => {
                    if working {
                        self.working_image_bytes(path)?
                    } else {
                        let size = string(self.location(), &["cat-file", "-s", oid])?;
                        if size.parse::<usize>().unwrap_or(usize::MAX) > IMAGE_LIMIT {
                            return Err(Error::new(
                                "imageLimit",
                                "Image exceeds the 16 MiB preview limit.",
                            ));
                        }
                        process::checked(self.location(), &args(&["cat-file", "blob", oid]))?
                    }
                }
                Some(_) => return Err(Error::new("imageUnavailable", "Not a regular file.")),
                None => self.working_image_bytes(path)?,
            };
            Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
        })();
        let (data_url, error) = match data {
            Ok(url) => (Some(url), None),
            Err(error) => (None, Some(error.message)),
        };
        Some(ImageSide {
            path: path.into(),
            data_url,
            error,
        })
    }
    /// A working-file preview needs status/rename metadata, not line statistics
    /// for every changed file. Plain modifications use a path-scoped raw read.
    /// Adds/deletes retain whole-diff rename pairing (without numstat), since
    /// restricting the pathspec to a rename destination would turn it into an add.
    fn working_diff_file(&self, spec: &DiffSpec, path: &str) -> Result<DiffFile> {
        let missing = || Error::new("fileNotInDiff", "File is not part of the selected diff");
        if matches!(spec, DiffSpec::Conflict)
            && !self
                .status_entries_at(Some(path))?
                .entries
                .iter()
                .any(|entry| entry.path == path && entry.conflicted)
        {
            return Err(missing());
        }
        let mut a = self.diff_args(spec)?;
        a.extend(args(&[
            "--raw",
            "-z",
            "--no-abbrev",
            "--no-renames",
            "--",
            path,
        ]));
        let raw = process::text(process::checked(self.location(), &a)?)?;
        let file = match parse_diff_files(&raw)?
            .into_iter()
            .find(|file| file.path == path)
        {
            Some(file) => file,
            None if matches!(spec, DiffSpec::Unstaged | DiffSpec::Conflict)
                && self
                    .status_entries_at(Some(path))?
                    .entries
                    .iter()
                    .any(|entry| {
                        entry.path == path && !entry.untracked && entry.worktree_status != "."
                    }) =>
            {
                return Err(Error::new(
                    "noPatch",
                    "Git reports this file as changed but has no diff to preview. This can happen when Git normalizes line endings.",
                ));
            }
            None => return Err(missing()),
        };
        if !matches!(file.status.as_str(), "A" | "D") {
            return Ok(file);
        }
        let mut a = self.diff_args(spec)?;
        a.extend(args(&["--raw", "-z", "--no-abbrev", "--"]));
        let raw = process::text(process::checked(self.location(), &a)?)?;
        parse_diff_files(&raw)?
            .into_iter()
            .find(|file| file.path == path)
            .ok_or_else(missing)
    }
    pub(crate) fn diff_snapshot(&self, spec: &DiffSpec, path: &str) -> Result<(FileDiff, Vec<u8>)> {
        self.diff_with_patch(spec, path, false)
    }

    fn diff_with_patch(
        &self,
        spec: &DiffSpec,
        path: &str,
        images: bool,
    ) -> Result<(FileDiff, Vec<u8>)> {
        validate_path(path)?;
        let actionable = matches!(spec, DiffSpec::Staged | DiffSpec::Unstaged);
        let index = || {
            process::checked(
                self.location(),
                &args(&["ls-files", "--stage", "-z", "--", path]),
            )
        };
        let before = if actionable { index()? } else { vec![] };
        let mut modified = false;
        let mut image = None;
        let bytes = if matches!(spec, DiffSpec::Untracked) {
            self.require_untracked(path)?;
            if let Some(mime) = image_mime(path).filter(|_| images) {
                image = Some(ImageDiff {
                    before: None,
                    after: self.image_side(path, None, true),
                    source_diff: mime == "image/svg+xml",
                });
            }
            self.untracked_patch(path)
        } else {
            let file = if matches!(
                spec,
                DiffSpec::Staged | DiffSpec::Unstaged | DiffSpec::Conflict
            ) {
                self.working_diff_file(spec, path)?
            } else {
                self.diff_files(spec)?
                    .into_iter()
                    .find(|file| file.path == path)
                    .ok_or_else(|| {
                        Error::new("fileNotInDiff", "File is not part of the selected diff")
                    })?
            };
            let old_path = file.old_path.as_deref().unwrap_or(path);
            if images && !matches!(spec, DiffSpec::Conflict) {
                let old_mime = image_mime(old_path);
                let new_mime = image_mime(path);
                if old_mime.is_some() || new_mime.is_some() {
                    image = Some(ImageDiff {
                        before: self.image_side(old_path, Some(&file.before), false),
                        after: self.image_side(
                            path,
                            Some(&file.after),
                            matches!(spec, DiffSpec::Unstaged),
                        ),
                        source_diff: [old_mime, new_mime].contains(&Some("image/svg+xml")),
                    });
                }
            }
            modified = file.status == "M" && file.old_path.is_none() && !file.binary;
            let mut a = self.diff_args(spec)?;
            a.extend(args(&["--patch", "--unified=3", "--", path]));
            if let Some(old_path) = &file.old_path {
                a.push(old_path.clone());
            }
            process::checked(self.location(), &a)
        };
        // Patch bodies may contain arbitrary blob bytes, unlike paths. Replacement characters are display-only.
        let (mut diff, bytes, patch_available) = match bytes {
            Ok(bytes) => (
                parse_patch(path, &String::from_utf8_lossy(&bytes))?,
                bytes,
                true,
            ),
            Err(error) if error.code == "outputLimit" && image.is_some() => {
                let mut diff = parse_patch(path, "")?;
                diff.truncated = true;
                diff.message = Some("The source diff exceeds the preview size limit.".into());
                (diff, vec![], false)
            }
            Err(error) => return Err(error),
        };
        diff.image = image;
        if actionable {
            if before != index()? {
                return Err(crate::hunk::stale());
            }
            if patch_available {
                diff.hunk_action =
                    Some(crate::hunk::action(&diff, &bytes, &before, spec, modified));
            }
        }
        if matches!(spec, DiffSpec::Conflict) {
            let note = "Unmerged file: showing the working tree against stage 2 (ours). This diff is read-only; use the conflict editor to resolve the full file.";
            diff.message = Some(match diff.message {
                Some(m) => format!("{note}\n{m}"),
                None => note.into(),
            });
        }
        Ok((diff, bytes))
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
                before: (fields[0][1..].into(), fields[2].into()),
                after: (fields[1].into(), fields[3].into()),
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
        hunk_action: None,
        image: None,
        message: if metadata.is_empty() {
            None
        } else {
            Some(metadata.join("\n"))
        },
    })
}
