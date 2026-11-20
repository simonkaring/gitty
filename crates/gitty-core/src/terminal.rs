//! Typed reviews for the terminal client. Existing CLI and desktop writes keep their contracts.
use crate::{
    dto::{CommitIdentity, CreatedCommit, DiffFile, DiffSpec, Error, FileDiff, Result},
    repository::{fingerprint, Repository, Service},
};
use std::{collections::hash_map::DefaultHasher, hash::Hasher};

fn stale() -> Error {
    Error::new(
        "staleOperation",
        "Repository changed; refresh and review again.",
    )
}

pub struct StageReview {
    paths: Vec<String>,
    unstage: bool,
    fingerprint: String,
    pub preview: FileDiff,
}

impl StageReview {
    pub fn paths(&self) -> &[String] {
        &self.paths
    }

    pub fn is_unstage(&self) -> bool {
        self.unstage
    }
}

pub struct CommitReview {
    handle: String,
    head_ref: Option<String>,
    files: Vec<DiffFile>,
    head: Option<String>,
    index: Vec<u8>,
    identity: Option<CommitIdentity>,
}

impl CommitReview {
    pub fn head_ref(&self) -> Option<&str> {
        self.head_ref.as_deref()
    }

    pub fn files(&self) -> &[DiffFile] {
        &self.files
    }

    pub fn identity(&self) -> Option<&CommitIdentity> {
        self.identity.as_ref()
    }
}

/// The changed paths a stash was reviewed against. Stashing keeps content, so the
/// guard pins which files are affected and HEAD rather than their exact bytes.
pub struct StashReview {
    /// `(path, untracked)` for every changed entry.
    entries: Vec<(String, bool)>,
    head: Option<String>,
    pub include_untracked: bool,
}

impl StashReview {
    pub fn entries(&self) -> &[(String, bool)] {
        &self.entries
    }
}

impl Repository {
    fn terminal_stash_entries(&self) -> Result<Vec<(String, bool)>> {
        let status = self.status_entries()?;
        if status.entries.iter().any(|entry| entry.conflicted) {
            return Err(Error::new(
                "unresolvedConflict",
                "Resolve existing conflicts before stashing.",
            ));
        }
        Ok(status
            .entries
            .into_iter()
            .map(|entry| (entry.path, entry.untracked))
            .collect())
    }

    pub fn terminal_review_stash(&self) -> Result<StashReview> {
        let entries = self.terminal_stash_entries()?;
        if entries.is_empty() {
            return Err(Error::new(
                "nothingToStash",
                "There are no changes to stash.",
            ));
        }
        let include_untracked = entries.iter().all(|(_, untracked)| *untracked);
        Ok(StashReview {
            entries,
            head: self.head_commit()?,
            include_untracked,
        })
    }

    fn terminal_index(&self, paths: &[String]) -> Result<Vec<u8>> {
        let mut args = vec!["ls-files", "--stage", "-z", "--"];
        args.extend(paths.iter().map(String::as_str));
        let output = self.check(&args)?;
        if !output.success {
            return Err(self.failed(&output));
        }
        Ok(output.stdout)
    }

    fn terminal_head(&self) -> Result<(Option<String>, Option<String>)> {
        let output = self.check(&["symbolic-ref", "--quiet", "HEAD"])?;
        let reference = match output.code {
            Some(0) => Some(
                crate::process::text(output.stdout)?
                    .trim_end_matches('\n')
                    .to_owned(),
            ),
            Some(1) => None,
            _ => return Err(self.failed(&output)),
        };
        Ok((self.head_commit()?, reference))
    }

    fn terminal_stage_fingerprint(&self, paths: &[String], unstage: bool) -> Result<String> {
        let index = self.terminal_index(paths)?;
        if unstage {
            return Ok(fingerprint((self.terminal_head()?, index)));
        }
        let mut entries = Vec::new();
        let mut untracked = DefaultHasher::new();
        for path in paths {
            for entry in self.status_entries_at(Some(path))?.entries {
                if entry.path.ends_with('/') || entry.conflicted {
                    return Err(Error::new(
                        "unsupportedOperation",
                        "Embedded repositories and conflicts cannot be staged here.",
                    ));
                }
                if entry.untracked {
                    self.hash_untracked_patch(&mut untracked, &entry.path)?;
                }
                entries.push(serde_json::to_vec(&entry).expect("status entries serialize"));
            }
        }
        Ok(fingerprint((
            index,
            entries,
            self.tracked_content_hash_at(paths)?,
            untracked.finish(),
        )))
    }

    pub fn terminal_review_stage(&self, path: &str, unstage: bool) -> Result<StageReview> {
        let entry = self
            .status_entries()?
            .entries
            .into_iter()
            .find(|entry| entry.path == path)
            .ok_or_else(stale)?;
        if entry.conflicted
            || path.ends_with('/')
            || (if unstage {
                entry.index_status == "."
            } else {
                !entry.untracked && entry.worktree_status == "."
            })
        {
            return Err(Error::new(
                "unsupportedOperation",
                "This entry is not eligible for that action.",
            ));
        }
        let mut paths = vec![crate::mutate::validate_mutation_path(path)?];
        let include_old = if unstage {
            entry.index_status == "R"
        } else {
            entry.worktree_status == "R" && !matches!(entry.index_status.as_str(), "R" | "C")
        };
        if include_old {
            paths.push(crate::mutate::validate_mutation_path(
                entry.old_path.as_deref().ok_or_else(stale)?,
            )?);
        }
        let fingerprint = self.terminal_stage_fingerprint(&paths, unstage)?;
        let spec = if unstage {
            DiffSpec::Staged
        } else if entry.untracked {
            DiffSpec::Untracked
        } else {
            DiffSpec::Unstaged
        };
        let preview = match self.diff(&spec, path) {
            Ok(preview) => preview,
            Err(error) if error.code == "outputLimit" => FileDiff {
                path: path.into(),
                hunks: vec![],
                binary: false,
                truncated: true,
                message: None,
                hunk_action: None,
            },
            Err(error) => return Err(error),
        };
        if self.terminal_stage_fingerprint(&paths, unstage)? != fingerprint {
            return Err(stale());
        }
        Ok(StageReview {
            paths,
            unstage,
            fingerprint,
            preview,
        })
    }

    pub fn terminal_review_commit(&self) -> Result<CommitReview> {
        self.terminal_review_commit_with_identity(None)
    }

    pub fn terminal_review_commit_with_identity(
        &self,
        identity: Option<CommitIdentity>,
    ) -> Result<CommitReview> {
        crate::mutate::validate_identity(identity.as_ref())?;
        let (head, head_ref) = self.terminal_head()?;
        let index = self.terminal_index(&[])?;
        let files = self.diff_files(&DiffSpec::Staged)?;
        if self.terminal_head()? != (head.clone(), head_ref.clone())
            || self.terminal_index(&[])? != index
        {
            return Err(stale());
        }
        Ok(CommitReview {
            handle: self.session.handle.clone(),
            head_ref,
            head,
            index,
            files,
            identity,
        })
    }
}

impl Service {
    pub fn terminal_stage(&self, handle: &str, review: StageReview) -> Result<()> {
        self.mutate_reviewed(handle, |repo| {
            if repo.terminal_stage_fingerprint(&review.paths, review.unstage)? != review.fingerprint
            {
                return Err(stale());
            }
            if review.unstage {
                repo.unstage(&review.paths)
            } else {
                repo.stage(&review.paths)
            }
        })
    }

    pub fn terminal_stash(&self, handle: &str, review: StashReview) -> Result<()> {
        self.mutate_reviewed(handle, |repo| {
            if repo.terminal_stash_entries()? != review.entries
                || repo.head_commit()? != review.head
            {
                return Err(stale());
            }
            if !review.include_untracked && review.entries.iter().all(|(_, untracked)| *untracked) {
                return Err(Error::new(
                    "nothingToStash",
                    "Only untracked files changed; include them to stash.",
                ));
            }
            repo.stash_action(crate::remote_dto::StashAction::Save {
                message: None,
                include_untracked: review.include_untracked,
            })
            .map(|_| ())
        })
    }

    /// A missing comparison means the commit succeeded but the tree could not be verified.
    pub fn terminal_commit(
        &self,
        handle: &str,
        review: CommitReview,
        message: &str,
    ) -> Result<(CreatedCommit, Option<bool>)> {
        self.mutate_reviewed(handle, |repo| {
            if review.handle != handle
                || repo.terminal_head()? != (review.head, review.head_ref)
                || repo.terminal_index(&[])? != review.index
            {
                return Err(stale());
            }
            let commit = repo.create_commit(message, review.identity.as_ref())?;
            let matches = repo
                .check(&["ls-tree", "-r", "-z", &commit.oid])
                .ok()
                .filter(|output| output.success)
                .map(|output| tree_matches_index(&output.stdout, &review.index));
            Ok((commit, matches))
        })
    }
}

fn tree_matches_index(tree: &[u8], index: &[u8]) -> bool {
    type Fields<'a> = (&'a [u8], &'a [u8], &'a [u8], &'a [u8]);
    fn fields(record: &[u8]) -> Option<Fields<'_>> {
        let tab = record.iter().position(|b| *b == b'\t')?;
        let mut meta = record[..tab].split(|b| *b == b' ');
        Some((meta.next()?, meta.next()?, meta.next()?, &record[tab + 1..]))
    }
    let entries = |bytes: &[u8]| bytes.iter().filter(|&&byte| byte == 0).count();
    entries(tree) == entries(index)
        && tree.split(|b| *b == 0).filter(|r| !r.is_empty()).zip(index.split(|b| *b == 0)).all(|(t, i)| {
            matches!((fields(t), fields(i)), (Some((tm, _, to, tp)), Some((im, io, b"0", ip))) if (tm, to, tp) == (im, io, ip))
        })
}
