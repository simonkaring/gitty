//! Complete-hunk index edits. Only Git-generated raw bytes become patches;
//! lossy display strings and client-supplied text never enter a write.
use crate::{
    dto::*,
    mutate::validate_mutation_path,
    process::args,
    repository::{fingerprint, Repository},
};

pub(crate) fn stale() -> Error {
    Error::new(
        "staleDiff",
        "The diff or index changed. Refresh the preview and select the hunk again.",
    )
}

fn hunk_offsets(bytes: &[u8]) -> Vec<usize> {
    let mut offset = 0;
    bytes
        .split_inclusive(|b| *b == b'\n')
        .filter_map(|line| {
            let start = offset;
            offset += line.len();
            line.starts_with(b"@@ ").then_some(start)
        })
        .collect()
}

pub(crate) fn action(
    diff: &FileDiff,
    bytes: &[u8],
    index: &[u8],
    spec: &DiffSpec,
    modified: bool,
) -> HunkAction {
    let offsets = hunk_offsets(bytes);
    let header = &bytes[..offsets.first().copied().unwrap_or(bytes.len())];
    // A plain modification has exactly these four headers. Mode changes,
    // symlinks, submodules, copies, renames, adds and deletes cannot slip through.
    let headers: Vec<_> = header.split_inclusive(|b| *b == b'\n').collect();
    let regular = headers.len() == 4
        && headers[0].starts_with(b"diff --git ")
        && headers[1].starts_with(b"index ")
        && (headers[1].ends_with(b" 100644\n") || headers[1].ends_with(b" 100755\n"))
        && headers[2].starts_with(b"--- ")
        && headers[3].starts_with(b"+++ ");
    let reason = if diff.truncated {
        Some("Hunk actions are unavailable for truncated previews. Use the whole-file buttons or Git.")
    } else if diff.binary || bytes.contains(&0) || !modified || !regular || offsets.is_empty() {
        Some("Hunk actions require a modified regular text file with unchanged mode. Use the whole-file buttons for binary, renamed, added, deleted or metadata-only changes.")
    } else {
        None
    };
    HunkAction {
        fingerprint: reason.is_none().then(|| {
            fingerprint((
                "hunk-v1",
                &diff.path,
                matches!(spec, DiffSpec::Staged),
                index,
                bytes,
            ))
        }),
        reason: reason.map(String::from),
    }
}

/// Keep the original quoted path headers and body bytes, including CR, invalid
/// UTF-8 and no-newline markers. Only ASCII hunk coordinates are regenerated.
/// Earlier omitted hunks must not contribute their line-count deltas: forward
/// application is based on the old range, reverse application on the new range.
fn selected_patch(bytes: &[u8], hunk_index: usize, reverse: bool) -> Result<Vec<u8>> {
    let offsets = hunk_offsets(bytes);
    let start = *offsets
        .get(hunk_index)
        .ok_or_else(|| Error::new("invalidHunk", "Select an existing complete hunk."))?;
    let end = offsets.get(hunk_index + 1).copied().unwrap_or(bytes.len());
    let body_start = start
        + bytes[start..end]
            .iter()
            .position(|b| *b == b'\n')
            .ok_or_else(|| Error::new("gitParse", "Incomplete hunk header"))?
        + 1;
    // The optional function heading after the closing @@ may itself be non-UTF8.
    let fields: Vec<_> = bytes[start..body_start]
        .split(|b| *b == b' ')
        .take(4)
        .collect();
    let range = |s: &str| -> Result<(u64, u64)> {
        let (start, count) = s[1..].split_once(',').unwrap_or((&s[1..], "1"));
        Ok((
            start
                .parse()
                .map_err(|_| Error::new("gitParse", "Invalid hunk start"))?,
            count
                .parse()
                .map_err(|_| Error::new("gitParse", "Invalid hunk count"))?,
        ))
    };
    if fields.len() < 4 || !fields[1].starts_with(b"-") || !fields[2].starts_with(b"+") {
        return Err(Error::new("gitParse", "Invalid hunk ranges"));
    }
    let ascii = |bytes| {
        std::str::from_utf8(bytes).map_err(|_| Error::new("gitParse", "Invalid hunk range"))
    };
    let (old_start, old_count) = range(ascii(fields[1])?)?;
    let (new_start, new_count) = range(ascii(fields[2])?)?;
    // Empty ranges refer to the line *before* the insertion/deletion.
    let (old_start, new_start) = if reverse {
        (
            if old_count == 0 {
                new_start.saturating_sub(1)
            } else if new_count == 0 {
                new_start + 1
            } else {
                new_start
            },
            new_start,
        )
    } else {
        (
            old_start,
            if new_count == 0 {
                old_start.saturating_sub(1)
            } else if old_count == 0 {
                old_start + 1
            } else {
                old_start
            },
        )
    };
    let mut patch = bytes[..offsets[0]].to_vec();
    patch.extend_from_slice(
        format!("@@ -{old_start},{old_count} +{new_start},{new_count} @@\n").as_bytes(),
    );
    patch.extend_from_slice(&bytes[body_start..end]);
    Ok(patch)
}

fn split_raw_lines(slice: &[u8]) -> Vec<&[u8]> {
    let mut lines = Vec::new();
    let mut rest = slice;
    while !rest.is_empty() {
        if let Some(pos) = rest.iter().position(|b| *b == b'\n') {
            lines.push(&rest[..pos + 1]);
            rest = &rest[pos + 1..];
        } else {
            lines.push(rest);
            break;
        }
    }
    lines
}

fn selected_lines_patch(
    bytes: &[u8],
    hunk_index: usize,
    reverse: bool,
    line_indices: &[usize],
) -> Result<Vec<u8>> {
    let offsets = hunk_offsets(bytes);
    let start = *offsets
        .get(hunk_index)
        .ok_or_else(|| Error::new("invalidHunk", "Select an existing complete hunk."))?;
    let end = offsets.get(hunk_index + 1).copied().unwrap_or(bytes.len());
    let hunk_bytes = &bytes[start..end];
    let body_start = start
        + hunk_bytes
            .iter()
            .position(|b| *b == b'\n')
            .ok_or_else(|| Error::new("gitParse", "Incomplete hunk header"))?
        + 1;

    let fields: Vec<_> = bytes[start..body_start]
        .split(|b| *b == b' ')
        .take(4)
        .collect();
    let range = |s: &str| -> Result<(u64, u64)> {
        let (start, count) = s[1..].split_once(',').unwrap_or((&s[1..], "1"));
        Ok((
            start
                .parse()
                .map_err(|_| Error::new("gitParse", "Invalid hunk start"))?,
            count
                .parse()
                .map_err(|_| Error::new("gitParse", "Invalid hunk count"))?,
        ))
    };
    if fields.len() < 4 || !fields[1].starts_with(b"-") || !fields[2].starts_with(b"+") {
        return Err(Error::new("gitParse", "Invalid hunk ranges"));
    }
    let ascii =
        |b| std::str::from_utf8(b).map_err(|_| Error::new("gitParse", "Invalid hunk range"));
    let (old_start, _old_count) = range(ascii(fields[1])?)?;
    let (new_start, _new_count) = range(ascii(fields[2])?)?;

    let raw_lines = split_raw_lines(&bytes[body_start..end]);
    if line_indices.is_empty() {
        return Err(Error::new(
            "invalidSelection",
            "Select one or more changed lines.",
        ));
    }
    if line_indices.len() > raw_lines.len() || line_indices.len() > 20_000 {
        return Err(Error::new("invalidSelection", "Selection exceeds limit."));
    }

    let mut selected_set = std::collections::HashSet::with_capacity(line_indices.len());
    for &idx in line_indices {
        if idx >= raw_lines.len() {
            return Err(Error::new(
                "invalidSelection",
                "Selected line is out of range.",
            ));
        }
        if !selected_set.insert(idx) {
            return Err(Error::new("invalidSelection", "Duplicate line selection."));
        }
        let line = raw_lines[idx];
        match line.first() {
            Some(b'+') | Some(b'-') => {}
            _ => {
                return Err(Error::new(
                    "invalidSelection",
                    "Only changed lines can be selected.",
                ));
            }
        }
    }

    let has_meta_after =
        |idx: usize| -> bool { idx + 1 < raw_lines.len() && raw_lines[idx + 1].starts_with(b"\\") };

    let mut patch_body = Vec::new();
    let mut patch_old_count: u64 = 0;
    let mut patch_new_count: u64 = 0;
    let mut additions_in_patch: usize = 0;
    let mut deletions_in_patch: usize = 0;

    let mut idx = 0;
    while idx < raw_lines.len() {
        let line = raw_lines[idx];
        if line.starts_with(b"\\") {
            idx += 1;
            continue;
        }

        let is_selected = selected_set.contains(&idx);
        let has_no_newline = has_meta_after(idx);
        let first_byte = *line.first().unwrap_or(&b' ');

        match first_byte {
            b' ' => {
                patch_body.extend_from_slice(line);
                if has_no_newline {
                    patch_body.extend_from_slice(raw_lines[idx + 1]);
                }
                patch_old_count += 1;
                patch_new_count += 1;
            }
            b'+' => {
                if reverse {
                    if is_selected {
                        patch_body.extend_from_slice(line);
                        if has_no_newline {
                            patch_body.extend_from_slice(raw_lines[idx + 1]);
                        }
                        patch_new_count += 1;
                        additions_in_patch += 1;
                    } else {
                        if has_no_newline {
                            return Err(Error::new(
                                "unsupportedHunk",
                                "Partial staging across a newline-at-EOF transition is unsupported. Use full-hunk staging or Git.",
                            ));
                        }
                        let mut ctx = line.to_vec();
                        ctx[0] = b' ';
                        patch_body.extend_from_slice(&ctx);
                        patch_old_count += 1;
                        patch_new_count += 1;
                    }
                } else if is_selected {
                    patch_body.extend_from_slice(line);
                    if has_no_newline {
                        patch_body.extend_from_slice(raw_lines[idx + 1]);
                    }
                    patch_new_count += 1;
                    additions_in_patch += 1;
                }
            }
            b'-' => {
                if reverse {
                    if is_selected {
                        patch_body.extend_from_slice(line);
                        if has_no_newline {
                            patch_body.extend_from_slice(raw_lines[idx + 1]);
                        }
                        patch_old_count += 1;
                        deletions_in_patch += 1;
                    }
                } else if is_selected {
                    patch_body.extend_from_slice(line);
                    if has_no_newline {
                        patch_body.extend_from_slice(raw_lines[idx + 1]);
                    }
                    patch_old_count += 1;
                    deletions_in_patch += 1;
                } else {
                    if has_no_newline {
                        return Err(Error::new(
                            "unsupportedHunk",
                            "Partial staging across a newline-at-EOF transition is unsupported. Use full-hunk staging or Git.",
                        ));
                    }
                    let mut ctx = line.to_vec();
                    ctx[0] = b' ';
                    patch_body.extend_from_slice(&ctx);
                    patch_old_count += 1;
                    patch_new_count += 1;
                }
            }
            _ => {}
        }

        if has_no_newline {
            idx += 2;
        } else {
            idx += 1;
        }
    }

    if additions_in_patch == 0 && deletions_in_patch == 0 {
        return Err(Error::new(
            "invalidSelection",
            "Select one or more changed lines.",
        ));
    }

    let (patch_old_start, patch_new_start) = if reverse {
        let base_start = new_start;
        let s_old = if patch_old_count == 0 {
            base_start.saturating_sub(1)
        } else if patch_new_count == 0 {
            base_start + 1
        } else {
            base_start
        };
        (s_old, base_start)
    } else {
        let s_new = if patch_new_count == 0 {
            old_start.saturating_sub(1)
        } else if patch_old_count == 0 {
            old_start + 1
        } else {
            old_start
        };
        (old_start, s_new)
    };

    let mut patch = bytes[..offsets[0]].to_vec();
    patch.extend_from_slice(
        format!(
            "@@ -{patch_old_start},{patch_old_count} +{patch_new_start},{patch_new_count} @@\n"
        )
        .as_bytes(),
    );
    patch.extend_from_slice(&patch_body);
    Ok(patch)
}

impl Repository {
    pub(crate) fn change_hunk(
        &self,
        path: &str,
        hunk_index: usize,
        expected: &str,
        reverse: bool,
        line_indices: Option<&[usize]>,
    ) -> Result<()> {
        let validated = validate_mutation_path(path)?;
        if validated != path {
            return Err(Error::new("invalidPath", "Select a regular file."));
        }
        self.require_writable()?;
        if self.unmerged()?.iter().any(|p| p == path) {
            return Err(Error::new(
                "unresolvedConflict",
                "Resolve this file before staging hunks.",
            ));
        }
        let spec = if reverse {
            DiffSpec::Staged
        } else {
            DiffSpec::Unstaged
        };
        let snapshot = || {
            self.diff_snapshot(&spec, path).map_err(|e| {
                if e.code == "fileNotInDiff" {
                    stale()
                } else {
                    e
                }
            })
        };
        let (diff, bytes) = snapshot()?;
        let action = diff.hunk_action.as_ref().unwrap();
        if let Some(reason) = &action.reason {
            return Err(Error::new("unsupportedHunk", reason));
        }
        if action.fingerprint.as_deref() != Some(expected) {
            return Err(stale());
        }
        let patch = if let Some(lines) = line_indices {
            selected_lines_patch(&bytes, hunk_index, reverse, lines)?
        } else {
            selected_patch(&bytes, hunk_index, reverse)?
        };
        // Catch index/worktree edits during preparation as well as since display.
        // This is NOT an atomic compare-and-swap with external Git processes:
        // Service serializes Gitty writers only. Git apply acquires index.lock,
        // reads the then-current index, and checks context under its own lock.
        // An external non-overlapping edit in the remaining window is preserved;
        // incompatible context/lock failures are surfaced, never forced/retried.
        let (latest, _) = snapshot()?;
        if latest
            .hunk_action
            .as_ref()
            .and_then(|a| a.fingerprint.as_deref())
            != Some(expected)
        {
            return Err(stale());
        }
        let mut a = args(&[
            "-c",
            "apply.ignoreWhitespace=no",
            "apply",
            "--cached",
            "--whitespace=nowarn",
        ]);
        if reverse {
            a.push("--reverse".into());
        }
        a.push("-".into());
        let output = self.write(&a, &[], &patch, 32 * 1024 * 1024)?;
        if !output.success {
            return Err(self.failed(&output));
        }
        Ok(())
    }
}
