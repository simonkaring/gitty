//! File-level staging, unstaging and ordinary commits.
//!
//! Every mutation names its files explicitly: there is no "all changes" form, so
//! an empty request is rejected rather than silently widened. Writes run under the
//! mutation command contract (see `process::Contract`), which keeps Git's locks,
//! hooks, signing and configuration intact, and they are serialized per underlying
//! repository by `Service` so two sessions cannot race for the index lock.
use crate::{
    dto::*,
    process::{self, args, Output, CHECK_TIMEOUT, MUTATION_TIMEOUT},
    repository::{validate_path, Repository},
};
use std::{collections::HashSet, process::Command};

/// Paths and messages are fed to Git on stdin, never as command-line arguments:
/// Windows caps a whole command line at ~32767 UTF-16 units and Unix caps both
/// the total and a single argument, so an argv-shaped request could not honor
/// these limits on every platform. These bounds are policy for one user action.
const MAX_PATHS: usize = 1000;
const MAX_PATHSPEC_BYTES: usize = 1024 * 1024;
const MAX_MESSAGE_BYTES: usize = 64 * 1024;
/// Git output kept in an error message; hook output can be arbitrarily long.
const MAX_REPORTED: usize = 4000;
/// Retry advice for any failure that leaves the outcome genuinely unknown.
const UNVERIFIED: &str =
    "The repository may already have changed. Refresh and check the status before retrying.";

fn validate_message(message: &str) -> Result<()> {
    if message.trim().is_empty() {
        return Err(Error::new(
            "invalidRequest",
            "Enter a commit message; blank messages are rejected.",
        ));
    }
    if message.len() > MAX_MESSAGE_BYTES {
        return Err(Error::new(
            "invalidRequest",
            "Commit messages are limited to 64 KiB.",
        ));
    }
    if message.contains('\0') {
        return Err(Error::new(
            "invalidRequest",
            "Commit messages cannot contain NUL bytes.",
        ));
    }
    Ok(())
}

fn validate_identity(identity: Option<&CommitIdentity>) -> Result<()> {
    let Some(identity) = identity else {
        return Ok(());
    };
    let invalid = |s: &str| s.chars().any(|c| c.is_control() || matches!(c, '<' | '>'));
    if identity.name.trim() != identity.name
        || identity.name.is_empty()
        || identity.name.len() > 120
        || invalid(&identity.name)
        || identity.email.trim() != identity.email
        || identity.email.is_empty()
        || identity.email.len() > 254
        || invalid(&identity.email)
        || identity.email.chars().any(char::is_whitespace)
        || identity.email.split('@').count() != 2
        || identity.email.starts_with('@')
        || identity.email.ends_with('@')
    {
        return Err(Error::new(
            "invalidRequest",
            "Enter a valid commit profile name and email.",
        ));
    }
    Ok(())
}

/// Operations the ordinary staging/commit API must not modify. Mutating underneath them
/// would silently change their meaning (a commit during a merge is a merge
/// commit), so every write is refused while one is in progress.
/// State directories and plain files live in this worktree's Git directory.
const IN_PROGRESS_PATHS: [(&str, &str); 4] = [
    ("rebase-merge", "a rebase"),
    ("rebase-apply", "a rebase or patch application"),
    ("sequencer", "a sequenced cherry-pick or revert"),
    ("BISECT_LOG", "a bisect"),
];
/// Pseudo-refs are resolved through Git: the reftable backend keeps some of them
/// inside the ref store rather than as files in the Git directory.
const IN_PROGRESS_REFS: [(&str, &str); 3] = [
    ("MERGE_HEAD", "a merge"),
    ("CHERRY_PICK_HEAD", "a cherry-pick"),
    ("REVERT_HEAD", "a revert"),
];
const INDEX_LOCK: &str = "index.lock";

/// Repository-relative file paths only: no absolute paths, no escapes, no `.`/`..`
/// components, and no implicit whole-tree pathspec. Literal pathspecs (set by the
/// command contract) keep `*`, `[`, `?`, `:` and a leading `-` as plain characters;
/// paths travel on stdin as NUL-separated pathspecs, so they are never parsed as
/// options, never unquoted, and never bounded by a command line.
pub fn validate_mutation_path(path: &str) -> Result<String> {
    // Directory entries (untracked directories and embedded repositories) arrive
    // from status with a trailing slash; a file can never be named that way.
    let trimmed = path.strip_suffix('/').unwrap_or(path);
    validate_path(trimmed)?;
    if trimmed.len() > 4096 || trimmed.split('/').any(|c| c.is_empty() || c == ".") {
        return Err(Error::new(
            "invalidPath",
            "Expected a repository-relative file path without empty or '.' segments",
        ));
    }
    Ok(trimmed.to_string())
}

pub(crate) fn report(output: &Output) -> String {
    // Git writes refusal reasons to stdout as often as stderr, and hooks write
    // wherever they like. Surface both, verbatim apart from a length cap.
    let mut text = String::new();
    for stream in [&output.stderr, &output.stdout] {
        let part = String::from_utf8_lossy(stream);
        let part = part.trim();
        if !part.is_empty() {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(part);
        }
    }
    if text.chars().count() > MAX_REPORTED {
        text = text.chars().take(MAX_REPORTED).collect::<String>() + "\n… output truncated";
    }
    if text.is_empty() {
        text = match output.code {
            Some(code) => format!("Git exited with status {code}"),
            None => "Git was terminated by a signal".into(),
        };
    }
    text
}

/// A write that was abandoned rather than refused may already have finished: a
/// timeout kills the Git process, but Git may have written the index or the
/// commit first, and a hook may already have run. The frontend is told to
/// reconcile instead of retrying blindly. Failures that happen before the process
/// exists cannot have changed anything and keep their own code.
fn unverified(e: Error) -> Error {
    match e.code.as_str() {
        "processStart" | "wslLocationRequired" | "unsupportedPlatform" | "invalidDistribution" => e,
        _ => Error::new("mutationUnverified", format!("{} {UNVERIFIED}", e.message)),
    }
}

impl Repository {
    /// A read that belongs to a mutation: it runs inside the mutation lock and
    /// must not inherit the read request budget, which a slow hook can exhaust.
    pub(crate) fn check(&self, values: &[&str]) -> Result<Output> {
        self.check_args(&args(values))
    }
    fn check_args(&self, a: &[String]) -> Result<Output> {
        let command = process::git_command(self.location(), a)?;
        process::run_for(command, CHECK_TIMEOUT)
    }
    pub(crate) fn check_text(&self, values: &[&str]) -> Result<String> {
        let o = self.check(values)?;
        if !o.success {
            return Err(Error::new("git", report(&o)));
        }
        Ok(process::text(o.stdout)?.trim_end_matches('\n').to_string())
    }
    /// Entry names directly inside this worktree's Git directory. One listing
    /// answers every in-progress and lock question without a process per name.
    pub(crate) fn git_dir_entries(&self) -> Result<HashSet<String>> {
        match self.location() {
            RepositoryLocation::Native { .. } => {
                let mut names = HashSet::new();
                for entry in std::fs::read_dir(&self.session.git_dir)? {
                    names.insert(entry?.file_name().to_string_lossy().into_owned());
                }
                Ok(names)
            }
            RepositoryLocation::Wsl { distribution, .. } => {
                process::validate_distribution(distribution)?;
                let mut command = Command::new("wsl.exe");
                command.args([
                    "--distribution",
                    distribution,
                    "--exec",
                    "find",
                    &self.session.git_dir,
                    "-mindepth",
                    "1",
                    "-maxdepth",
                    "1",
                    "-print0",
                ]);
                let o = process::run_for(command, CHECK_TIMEOUT)?;
                if !o.success {
                    return Err(Error::new("git", report(&o)));
                }
                Ok(process::text(o.stdout)?
                    .split('\0')
                    .filter(|s| !s.is_empty())
                    .map(|p| p.rsplit('/').next().unwrap_or(p).to_string())
                    .collect())
            }
        }
    }
    /// Resolves the unsupported-operation pseudo-refs in one process, whatever
    /// reference backend the repository uses. `cat-file --batch-check` reports
    /// `<name> missing` instead of failing when a name does not resolve.
    fn operation_refs(&self) -> Result<Option<&'static str>> {
        let names: Vec<&str> = IN_PROGRESS_REFS.iter().map(|(name, _)| *name).collect();
        let input = format!("{}\n", names.join("\n"));
        let command = process::git_command(self.location(), &args(&["cat-file", "--batch-check"]))?;
        let o = process::run_with_input_for(command, input.as_bytes(), CHECK_TIMEOUT, 1024)?;
        if !o.success {
            return Err(Error::new("git", report(&o)));
        }
        let text = process::text(o.stdout)?;
        let lines: Vec<&str> = text.lines().collect();
        if lines.len() != IN_PROGRESS_REFS.len() {
            return Err(Error::new(
                "gitParse",
                "Unexpected reference-state response while checking for operations in progress",
            ));
        }
        Ok(IN_PROGRESS_REFS
            .iter()
            .zip(lines)
            .find(|((name, _), line)| *line != format!("{name} missing"))
            .map(|((_, what), _)| *what))
    }
    /// Refuses to write while Git owns the index or an unsupported operation is
    /// half-finished. Nothing here removes or repairs Git state.
    pub(crate) fn require_writable(&self) -> Result<()> {
        self.require_worktree()?;
        let entries = self.git_dir_entries()?;
        let in_progress = IN_PROGRESS_PATHS
            .iter()
            .find(|(name, _)| entries.contains(*name))
            .map(|(_, what)| *what);
        if let Some(what) = in_progress.or(self.operation_refs()?) {
            return Err(Error::new(
                "operationInProgress",
                format!(
                    "{what} is in progress in this worktree. Use the operation controls or Git to finish or abort it before ordinary staging or committing."
                ),
            ));
        }
        if entries.contains(INDEX_LOCK) {
            return Err(Error::new(
                "indexLocked",
                "Another Git process holds the index lock. Wait for it to finish; Gitty never removes index.lock.",
            ));
        }
        Ok(())
    }
    /// Every unmerged index entry. The query is deliberately repository-wide:
    /// conflicts are rare and few, while a pathspec would put the whole request
    /// back onto a length-limited command line.
    pub(crate) fn unmerged(&self) -> Result<Vec<String>> {
        let o = self.check(&["ls-files", "--unmerged", "-z"])?;
        if !o.success {
            return Err(Error::new("git", report(&o)));
        }
        let mut conflicted: Vec<String> = process::text(o.stdout)?
            .split('\0')
            .filter(|s| !s.is_empty())
            .filter_map(|record| record.split_once('\t').map(|(_, path)| path.to_string()))
            .collect();
        conflicted.sort();
        conflicted.dedup();
        Ok(conflicted)
    }
    /// Conflicts covered by the request: the path itself, or anything inside it
    /// when a directory entry was selected.
    fn conflicted_among(&self, paths: &[String]) -> Result<Vec<String>> {
        let requested: HashSet<&String> = paths.iter().collect();
        Ok(self
            .unmerged()?
            .into_iter()
            .filter(|c| {
                requested.contains(c)
                    || paths.iter().any(|p| {
                        c.len() > p.len() && c.starts_with(p) && c[p.len()..].starts_with('/')
                    })
            })
            .collect())
    }
    /// `None` means an unborn branch — and only that. Exit 1 from `rev-parse` says
    /// no more than "did not resolve": a detached HEAD at a missing object looks
    /// identical. Confirm with `symbolic-ref` so a broken or corrupt HEAD is
    /// reported instead of being silently committed on top of as a root commit.
    pub(crate) fn head_commit(&self) -> Result<Option<String>> {
        let o = self.check(&["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])?;
        if o.success {
            return Ok(Some(
                process::text(o.stdout)?.trim_end_matches('\n').to_string(),
            ));
        }
        if o.code != Some(1) {
            return Err(self.failed(&o));
        }
        let symbolic = self.check(&["symbolic-ref", "--quiet", "HEAD"])?;
        match symbolic.code {
            Some(0) => Ok(None),
            Some(1) => Err(Error::new(
                "unresolvedHead",
                "HEAD does not point at a commit and is not an unborn branch; it may be detached at a missing object. Repair the repository in Git.",
            )),
            _ => Err(self.failed(&symbolic)),
        }
    }
    /// Validates the request and the repository, then returns deduplicated paths.
    fn prepare(&self, paths: &[String], verb: &str) -> Result<Vec<String>> {
        if paths.is_empty() {
            return Err(Error::new(
                "invalidRequest",
                format!(
                    "Select at least one file to {verb}; an empty request never means every file."
                ),
            ));
        }
        if paths.len() > MAX_PATHS {
            return Err(Error::new(
                "tooManyPaths",
                format!("At most {MAX_PATHS} files can be {verb}d in one request; work in smaller batches."),
            ));
        }
        let mut validated = Vec::with_capacity(paths.len());
        let mut seen = HashSet::new();
        let mut bytes = 0;
        for path in paths {
            let path = validate_mutation_path(path)?;
            bytes += path.len() + 1;
            if bytes > MAX_PATHSPEC_BYTES {
                return Err(Error::new(
                    "tooManyPaths",
                    "The selected paths exceed the request size limit; work in smaller batches.",
                ));
            }
            if seen.insert(path.clone()) {
                validated.push(path);
            }
        }
        self.require_writable()?;
        let conflicted = self.conflicted_among(&validated)?;
        if !conflicted.is_empty() {
            return Err(Error::new(
                "unresolvedConflict",
                format!(
                    "{} has unresolved conflicts. Resolve them with the conflict editor or Git first.",
                    conflicted.join(", ")
                ),
            ));
        }
        Ok(validated)
    }
    /// Runs the write itself, with its payload on stdin. Anything that ends without
    /// an exit status leaves the outcome unknown, so it is reported as such instead
    /// of inviting a blind retry.
    pub(crate) fn write(
        &self,
        a: &[String],
        env: &[(String, String)],
        input: &[u8],
        max_input: usize,
    ) -> Result<Output> {
        let mut command = process::git_mutation_command(self.location(), a)?;
        for (k, v) in env {
            command.env(k, v);
        }
        if matches!(self.location(), RepositoryLocation::Wsl { .. })
            && env.iter().any(|(k, _)| k == "GITTY_ASKPASS_TOKEN")
        {
            command.env(
                "WSLENV",
                crate::askpass::wsl_env_mapping(std::env::var("WSLENV").ok().as_deref()),
            );
        }
        process::run_with_input_for(command, input, MUTATION_TIMEOUT, max_input).map_err(unverified)
    }
    fn write_commit(
        &self,
        args: &[String],
        message: &str,
        identity: Option<&CommitIdentity>,
        amend: bool,
    ) -> Result<Output> {
        let mut vars = Vec::new();
        if let Some(identity) = identity {
            if !amend {
                vars.extend([
                    ("GIT_AUTHOR_NAME", identity.name.as_str()),
                    ("GIT_AUTHOR_EMAIL", identity.email.as_str()),
                ]);
            }
            vars.extend([
                ("GIT_COMMITTER_NAME", identity.name.as_str()),
                ("GIT_COMMITTER_EMAIL", identity.email.as_str()),
            ]);
        }
        let command = process::git_commit_command(self.location(), args, &vars)?;
        process::run_with_input_for(
            command,
            message.as_bytes(),
            MUTATION_TIMEOUT,
            MAX_MESSAGE_BYTES,
        )
        .map_err(unverified)
    }
    /// `--pathspec-from-file=-` with **empty** input means every file to Git, which
    /// is exactly what this backend must never do. `prepare` already guarantees a
    /// non-empty list; this is the last checkpoint before the process starts.
    fn pathspec_input(paths: &[String]) -> Result<Vec<u8>> {
        if paths.is_empty() {
            return Err(Error::new(
                "invalidRequest",
                "Refusing to run a write with an empty pathspec, which Git would read as every file.",
            ));
        }
        // Separators only: a trailing NUL would add an empty pathspec element.
        Ok(paths.join("\0").into_bytes())
    }
    pub(crate) fn failed(&self, output: &Output) -> Error {
        let text = report(output);
        if text.contains(INDEX_LOCK) {
            return Error::new(
                "indexLocked",
                format!("{text}\nGitty never removes index.lock; let the other process finish."),
            );
        }
        Error::new("git", text)
    }
    /// Stages the exact paths given, including deletions, so a rename staged as
    /// its old and new path becomes a rename in the index.
    pub(crate) fn stage(&self, paths: &[String]) -> Result<()> {
        let paths = self.prepare(paths, "stage")?;
        let input = Self::pathspec_input(&paths)?;
        let a = args(&[
            "add",
            "--all",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
        ]);
        let output = self.write(&a, &[], &input, MAX_PATHSPEC_BYTES)?;
        if !output.success {
            return Err(self.failed(&output));
        }
        Ok(())
    }
    /// Restores the index entries for the given paths from HEAD (or empties them
    /// on an unborn branch). The working tree is never read or written.
    pub(crate) fn unstage(&self, paths: &[String]) -> Result<()> {
        let paths = self.prepare(paths, "unstage")?;
        let input = Self::pathspec_input(&paths)?;
        let a = args(&[
            "reset",
            "--quiet",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
        ]);
        let output = self.write(&a, &[], &input, MAX_PATHSPEC_BYTES)?;
        if !output.success {
            return Err(self.failed(&output));
        }
        Ok(())
    }
    /// Commits exactly what is staged, with the configured identity, hooks and
    /// signing. No `--no-verify`, `--no-gpg-sign`, `--amend` or `--all`.
    pub(crate) fn create_commit(
        &self,
        message: &str,
        identity: Option<&CommitIdentity>,
    ) -> Result<CreatedCommit> {
        validate_message(message)?;
        validate_identity(identity)?;
        self.require_writable()?;
        let conflicted = self.unmerged()?;
        if !conflicted.is_empty() {
            return Err(Error::new(
                "unresolvedConflict",
                format!(
                    "{} still has unresolved conflicts. Resolve them in Git before committing.",
                    conflicted.join(", ")
                ),
            ));
        }
        let before = self.head_commit()?;
        // An unborn branch has no HEAD tree; compare the index with the empty tree
        // instead. `hash-object` without `-w` computes the ID without writing.
        let base = match &before {
            Some(id) => id.clone(),
            None => self.check_text(&["hash-object", "-t", "tree", "--stdin"])?,
        };
        let staged = self.check(&["diff-index", "--cached", "--quiet", &base, "--"])?;
        match staged.code {
            Some(0) => {
                return Err(Error::new(
                    "nothingStaged",
                    "Nothing is staged. Stage the files you want to commit first; Gitty never commits unstaged changes.",
                ))
            }
            Some(1) => {}
            _ => return Err(self.failed(&staged)),
        }
        // The message goes in on stdin: no command-line length limit, and no
        // argument encoding to round-trip. Git reads it before running any hook,
        // so hooks still see an immediately closed stdin.
        let a = args(&["commit", "--quiet", "--file=-"]);
        let output = self.write_commit(&a, message, identity, false)?;
        // Read HEAD once, after hooks have run, and report what Git actually left.
        // A commit that cannot be confirmed must not be reported as a failure.
        let after = self.head_commit().map_err(unverified)?;
        if !output.success {
            let text = report(&output);
            if after != before {
                return Err(Error::new(
                    "mutationUnverified",
                    format!(
                        "Git reported a failure but HEAD moved to {}. {UNVERIFIED}\n{text}",
                        after.unwrap_or_else(|| "an unresolved state".into())
                    ),
                ));
            }
            return Err(self.failed(&output));
        }
        match after {
            Some(oid) if Some(&oid) != before.as_ref() => Ok(CreatedCommit { oid }),
            Some(oid) => Err(Error::new(
                "mutationUnverified",
                format!("Git reported success but HEAD still points at {oid}. {UNVERIFIED}"),
            )),
            None => Err(Error::new(
                "mutationUnverified",
                format!("Git reported success but HEAD cannot be resolved. {UNVERIFIED}"),
            )),
        }
    }

    /// Replaces the current commit with the supplied message and current index.
    /// The snapshot expectations are checked under Gitty's mutation lock by the
    /// caller immediately before Git runs. This closes races between app sessions,
    /// not the final window before Git acquires its own locks from external tools.
    /// No staged changes are required, so a message-only amend remains possible;
    /// unstaged changes are never included.
    pub(crate) fn amend_commit(
        &self,
        message: &str,
        identity: Option<&CommitIdentity>,
        expected_head: &str,
        expected_head_ref: Option<&str>,
        expected_status_fingerprint: &str,
    ) -> Result<CreatedCommit> {
        validate_message(message)?;
        validate_identity(identity)?;
        self.require_writable()?;
        let conflicted = self.unmerged()?;
        if !conflicted.is_empty() {
            return Err(Error::new(
                "unresolvedConflict",
                format!(
                    "{} still has unresolved conflicts. Resolve them in Git before amending.",
                    conflicted.join(", ")
                ),
            ));
        }
        let status = self.status()?;
        let before = self.head_commit()?.ok_or_else(|| {
            Error::new(
                "unresolvedHead",
                "There is no current commit to amend. Create the initial commit first.",
            )
        })?;
        if before != expected_head
            || status.head.as_deref() != Some(expected_head)
            || status.head_ref.as_deref() != expected_head_ref
            || status.fingerprint != expected_status_fingerprint
        {
            return Err(Error::new(
                "staleOperation",
                "HEAD or the working changes have changed since this amendment was prepared. Refresh and review the last commit before trying again.",
            ));
        }
        let a = args(&["commit", "--quiet", "--amend", "--file=-"]);
        let output = self.write_commit(&a, message, identity, true)?;
        let after = self.head_commit().map_err(unverified)?;
        if !output.success {
            let text = report(&output);
            if after.as_deref() != Some(before.as_str()) {
                return Err(Error::new(
                    "mutationUnverified",
                    format!(
                        "Git reported a failure but HEAD moved to {}. {UNVERIFIED}\n{text}",
                        after.unwrap_or_else(|| "an unresolved state".into())
                    ),
                ));
            }
            return Err(self.failed(&output));
        }
        after.map(|oid| CreatedCommit { oid }).ok_or_else(|| {
            Error::new(
                "mutationUnverified",
                format!("Git reported success but HEAD cannot be resolved. {UNVERIFIED}"),
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mutation_paths_reject_escapes_and_implicit_whole_tree_requests() {
        for rejected in [
            "",
            ".",
            "..",
            "../outside",
            "a/../b",
            "a//b",
            "a/./b",
            "/absolute",
        ] {
            assert_eq!(
                validate_mutation_path(rejected).unwrap_err().code,
                "invalidPath",
                "{rejected:?} must be rejected"
            );
        }
        // Unusual but literal file names stay exactly as the user has them.
        for accepted in [
            "-dash file.txt",
            "star*[a-b]?.txt",
            ":(exclude)literal",
            "工作/файл.txt",
            "trailing space ",
            "a\tb\nc",
        ] {
            assert_eq!(validate_mutation_path(accepted).unwrap(), accepted);
        }
        assert_eq!(validate_mutation_path("nested/").unwrap(), "nested");
    }
    #[test]
    fn pathspec_input_is_never_empty_and_never_gains_an_empty_element() {
        // Git reads an empty `--pathspec-from-file` payload as every file, and a
        // trailing NUL as an empty pathspec element.
        assert_eq!(
            Repository::pathspec_input(&[]).unwrap_err().code,
            "invalidRequest"
        );
        assert_eq!(
            Repository::pathspec_input(&["only".into()]).unwrap(),
            b"only".to_vec()
        );
        let many = Repository::pathspec_input(&[
            "-dash file".into(),
            "工作/文件".into(),
            "star*[a-b]?.txt".into(),
        ])
        .unwrap();
        assert_eq!(many, "-dash file\0工作/文件\0star*[a-b]?.txt".as_bytes());
        assert_ne!(many.last(), Some(&0));
    }
    #[test]
    fn abandoned_writes_ask_for_reconciliation_instead_of_a_blind_retry() {
        let timed_out = unverified(Error::new("timeout", "Command exceeded its deadline"));
        assert_eq!(timed_out.code, "mutationUnverified");
        assert!(timed_out.message.contains("Refresh and check the status"));
        assert_eq!(
            unverified(Error::new("outputLimit", "too much")).code,
            "mutationUnverified"
        );
        // Nothing ran, so nothing can have changed.
        assert_eq!(
            unverified(Error::new("processStart", "git not found")).code,
            "processStart"
        );
    }
    #[test]
    fn reported_output_prefers_git_text_and_is_bounded() {
        let output = |out: &str, err: &str| Output {
            stdout: out.as_bytes().into(),
            stderr: err.as_bytes().into(),
            success: false,
            code: Some(1),
        };
        assert_eq!(
            report(&output("nothing to commit\n", "")),
            "nothing to commit"
        );
        assert_eq!(report(&output("out", "err")), "err\nout");
        assert_eq!(report(&output("", "")), "Git exited with status 1");
        assert!(report(&output("", &"x".repeat(MAX_REPORTED * 2))).ends_with("truncated"));
    }
}
