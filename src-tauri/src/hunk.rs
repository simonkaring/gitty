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

impl Repository {
    pub(crate) fn change_hunk(
        &self,
        path: &str,
        hunk_index: usize,
        expected: &str,
        reverse: bool,
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
        let patch = selected_patch(&bytes, hunk_index, reverse)?;
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
        let output = self.write(&a, &patch, 32 * 1024 * 1024)?;
        if !output.success {
            return Err(self.failed(&output));
        }
        Ok(())
    }
}
