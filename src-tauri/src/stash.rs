//! Stash selectors are display data only. Mutations resolve stable object IDs
//! against the current reflog while holding the shared repository write lock.
use crate::{
    dto::{Error, Result},
    process::{self, args},
    remote::action_result,
    remote_dto::{ActionOutput, StashAction, StashEntry},
    repository::{Repository, Service},
};

impl Service {
    pub fn stash_action(&self, handle: &str, action: StashAction) -> Result<ActionOutput> {
        self.mutate(handle, |repo| repo.stash_action(action))
    }
}

/// Shared message rule for saving and editing: bounded and NUL-free so it can
/// round-trip through the reflog and the IPC boundary.
fn validate_stash_message(message: &str) -> Result<()> {
    if message.len() > 4096 || message.contains('\0') {
        return Err(Error::new(
            "invalidRequest",
            "Stash messages must be at most 4096 bytes without NUL.",
        ));
    }
    Ok(())
}

impl Repository {
    /// Resolve a stable object ID against the current stash reflog. Duplicate
    /// entries (possible after external Git surgery) are ambiguous.
    fn stash_entry(&self, oid: &str) -> Result<StashEntry> {
        let stashes = self.stashes()?;
        let mut matching = stashes.into_iter().filter(|s| s.oid == oid);
        let entry = matching.next().ok_or_else(|| {
            Error::new(
                "staleStash",
                "This stash no longer exists. Refresh the stash list.",
            )
        })?;
        if matching.next().is_some() {
            return Err(Error::new("ambiguousStash", "This object occurs more than once in the stash list. Manage its duplicate entries in Git."));
        }
        Ok(entry)
    }

    fn stash_selector(&self, oid: &str) -> Result<String> {
        self.stash_entry(oid).map(|entry| entry.selector)
    }

    pub fn stashes(&self) -> Result<Vec<StashEntry>> {
        let bytes = process::checked(
            self.location(),
            &args(&[
                "stash",
                "list",
                "-z",
                "--no-show-signature",
                "--no-decorate",
                "--no-color",
                "--format=%H%x00%gd%x00%gs%x00%P%x00%an%x00%ae%x00%ct",
            ]),
        )?;
        let raw = process::text(bytes)?;
        let mut fields = raw.split_terminator('\0');
        let mut entries = Vec::new();
        while let Some(oid) = fields.next() {
            let selector = fields
                .next()
                .ok_or_else(|| Error::new("gitParse", "Missing stash selector"))?;
            let message = fields
                .next()
                .ok_or_else(|| Error::new("gitParse", "Missing stash message"))?;
            let parents = fields
                .next()
                .ok_or_else(|| Error::new("gitParse", "Missing stash parents"))?;
            let author = fields
                .next()
                .ok_or_else(|| Error::new("gitParse", "Missing stash author"))?;
            let email = fields
                .next()
                .ok_or_else(|| Error::new("gitParse", "Missing stash email"))?;
            let timestamp = fields
                .next()
                .ok_or_else(|| Error::new("gitParse", "Missing stash timestamp"))?;
            if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(Error::new("gitParse", "Invalid stash object ID"));
            }
            let parents: Vec<String> = parents
                .split(' ')
                .filter(|p| !p.is_empty())
                .map(String::from)
                .collect();
            if parents
                .iter()
                .any(|p| !matches!(p.len(), 40 | 64) || !p.bytes().all(|b| b.is_ascii_hexdigit()))
            {
                return Err(Error::new("gitParse", "Invalid stash parent object ID"));
            }
            let timestamp = timestamp
                .parse::<i64>()
                .map_err(|_| Error::new("gitParse", "Malformed stash timestamp"))?;
            entries.push(StashEntry {
                oid: oid.into(),
                selector: selector.into(),
                message: message.into(),
                parents,
                author: author.into(),
                email: email.into(),
                timestamp,
            });
        }
        Ok(entries)
    }

    pub(crate) fn stash_action(&self, action: StashAction) -> Result<ActionOutput> {
        self.require_writable()?;
        if !self.unmerged()?.is_empty() {
            return Err(Error::new(
                "unresolvedConflict",
                "Resolve existing conflicts before changing stashes.",
            ));
        }
        // Git's stash implementation internally invokes `clean ... :/`.
        // Literal pathspec mode would treat that as a filename and leave saved
        // untracked files behind. This API accepts no pathspecs, so allow Git's
        // own internal pathspecs without weakening file-level mutation commands.
        let mut a = args(&["--no-literal-pathspecs", "stash"]);
        match &action {
            StashAction::Save {
                message,
                include_untracked,
            } => {
                let head = self.head_commit()?.ok_or_else(|| {
                    Error::new("unbornHead", "Create an initial commit before stashing.")
                })?;
                // `stash push` internally resets --hard. In particular a staged
                // deletion with an ignored replacement must not lose that file.
                self.protect_untracked(&[head])?;
                a.push("push".into());
                if *include_untracked {
                    a.push("--include-untracked".into());
                }
                if let Some(message) = message {
                    validate_stash_message(message)?;
                    a.extend(args(&["--message", message]));
                }
                a.push("--".into());
            }
            StashAction::Apply { oid, .. }
            | StashAction::Pop { oid, .. }
            | StashAction::Drop { oid } => {
                if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err(Error::new(
                        "invalidStash",
                        "Choose a stash by its full object ID.",
                    ));
                }
                let selector = self.stash_selector(oid)?;
                let verb = match action {
                    StashAction::Apply { .. } => "apply",
                    StashAction::Pop { .. } => "pop",
                    _ => "drop",
                };
                if verb != "drop" && !self.status_entries()?.entries.is_empty() {
                    return Err(Error::new("dirtyWorktree", "Commit or stash staged, unstaged and untracked changes before applying a stash."));
                }
                if verb != "drop" {
                    self.protect_untracked(std::slice::from_ref(oid))?;
                }
                if verb == "drop" {
                    a.extend(args(&["drop", "--", &selector]));
                } else {
                    // Apply the pinned object, not a selector an external Git
                    // process could have renumbered while we checked the tree.
                    a.push("apply".into());
                    if matches!(
                        action,
                        StashAction::Apply {
                            restore_index: true,
                            ..
                        } | StashAction::Pop {
                            restore_index: true,
                            ..
                        }
                    ) {
                        a.push("--index".into());
                    }
                    a.extend(args(&["--", oid]));
                    let applied = action_result(self.write(&a, &[], &[], 0)?)?;
                    if verb == "apply" {
                        return Ok(applied);
                    }
                    // Native pop retains its numeric selector through apply;
                    // external writers (including a merge driver) can insert a
                    // stash during that time, causing native pop to drop another
                    // entry. Re-resolve after success; never drop after conflicts.
                    let dropped = (|| {
                        let selector = self.stash_selector(oid)?;
                        action_result(self.write(&args(&["stash", "drop", "--", &selector]), &[], &[], 0)?)
                    })().map_err(|e: Error| Error::new("mutationUnverified", format!(
                        "The stash was applied, but its removal could not be verified: {} Refresh before another action; do not apply it again blindly.", e.message
                    )))?;
                    // This is serialized across Gitty sessions, not a reflog CAS
                    // against external Git: deletion still uses Git's selector
                    // API and native ref lock, just as standalone stash drop.
                    return Ok(ActionOutput {
                        output: [applied.output, dropped.output]
                            .into_iter()
                            .filter(|s| !s.is_empty())
                            .collect::<Vec<_>>()
                            .join("\n"),
                    });
                }
            }
            StashAction::EditMessage { oid, message } => {
                if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err(Error::new(
                        "invalidStash",
                        "Choose a stash by its full object ID.",
                    ));
                }
                validate_stash_message(message)?;
                let entry = self.stash_entry(oid)?;
                if &entry.message == message {
                    return Ok(ActionOutput {
                        output: String::new(),
                    });
                }
                // Pin the object before dropping its reflog entry: a crash or
                // concurrent GC must not turn a message edit into lost work.
                // Interrupted edits leave a discoverable recovery ref behind.
                let recovery = format!("refs/gitty/stash-recovery/{}", crate::repository::token());
                action_result(self.write(
                    &args(&["update-ref", &recovery, oid, ""]),
                    &[],
                    &[],
                    0,
                )?)?;
                let edited: Result<ActionOutput> = (|| {
                    let dropped = action_result(self.write(
                        &args(&["stash", "drop", "--", &entry.selector]),
                        &[],
                        &[],
                        0,
                    )?)?;
                    let stored: Result<ActionOutput> = self
                        .write(
                            &args(&["stash", "store", "--message", message, oid]),
                            &[],
                            &[],
                            0,
                        )
                        .and_then(action_result);
                    match stored {
                        Ok(stored) => Ok(ActionOutput {
                            output: [dropped.output, stored.output]
                                .into_iter()
                                .filter(|s| !s.is_empty())
                                .collect::<Vec<_>>()
                                .join("\n"),
                        }),
                        Err(error) => {
                            // The entry is already out of the reflog: put it back
                            // under its original message so no work is lost.
                            let restored: Result<ActionOutput> = self
                                .write(
                                    &args(&["stash", "store", "--message", &entry.message, oid]),
                                    &[],
                                    &[],
                                    0,
                                )
                                .and_then(action_result);
                            let detail = match restored {
                            Ok(_) => format!("The stash message could not be changed, and the original stash entry was restored. {}", error.message),
                            Err(_) => "The stash entry was removed from Stashes but could not be re-stored.".into(),
                        };
                            Err(Error::new("mutationUnverified", detail))
                        }
                    }
                })();
                let recovery_error = |error: Error| {
                    Error::new("mutationUnverified", format!(
                    "{} Saved work is protected by {recovery}. Inspect Stashes before restoring with: git stash store {recovery}. After verifying recovery, remove the backup with: git update-ref -d {recovery} {oid}", error.message
                ))
                };
                let edited = edited.map_err(recovery_error)?;
                action_result(
                    self.write(&args(&["update-ref", "-d", &recovery, oid]), &[], &[], 0)
                        .map_err(recovery_error)?,
                )
                .map_err(recovery_error)?;
                return Ok(edited);
            }
        }
        action_result(self.write(&a, &[], &[], 0)?)
    }

    /// An explicitly requested merge save, identified independently of reflog order.
    pub(crate) fn save_merge_work(&self) -> Result<Option<StashEntry>> {
        if self.status_entries()?.entries.is_empty() {
            return Ok(None);
        }
        let label = format!("Gitty merge work {}", crate::repository::token());
        let saved = (|| {
            self.stash_action(StashAction::Save {
                message: Some(label.clone()),
                include_untracked: true,
            })?;
            let mut matches = self
                .stashes()?
                .into_iter()
                .filter(|stash| stash.message.ends_with(&label));
            let stash = matches.next().ok_or_else(|| {
                Error::new(
                    "mutationUnverified",
                    "The saved merge stash could not be identified.",
                )
            })?;
            if matches.next().is_some() {
                return Err(Error::new(
                    "mutationUnverified",
                    "The saved merge stash is ambiguous.",
                ));
            }
            if !self.status_entries()?.entries.is_empty() {
                return Err(Error::new(
                    "dirtyWorktree",
                    "Some local changes could not be stashed. The merge was not attempted.",
                ));
            }
            Ok(Some(stash))
        })();
        saved.map_err(|error: Error| Error::new(&error.code, format!("{} Refresh and inspect local work and Stashes before retrying. Any saved work is labeled '{label}'.", error.message)))
    }
}
