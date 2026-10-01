//! Graph mutations use Git's own sequencer, hooks, signing and lock files.
use crate::{
    dto::*,
    operation_dto::*,
    process::{self, args},
    repository::{fingerprint, resolve, Repository, Service},
};
use std::process::Command;

type OperationMetadata = Vec<(&'static str, Option<Vec<u8>>)>;

impl Service {
    pub fn run_operation(
        &self,
        handle: &str,
        request: OperationRequest,
        editor: Option<&crate::editor::EditorRegistry>,
    ) -> Result<OperationResult> {
        self.mutate(handle, |repo| repo.run_operation(request, editor))
    }
    pub fn resolve_conflict(
        &self,
        handle: &str,
        path: &str,
        expected: &str,
        resolution: ConflictResolution,
    ) -> Result<()> {
        self.mutate(handle, |repo| {
            repo.resolve_conflict(path, expected, resolution)
        })
    }
}

impl Repository {
    pub(crate) fn metadata(&self, name: &str) -> Result<Option<Vec<u8>>> {
        // Only backend constants reach this function, never IPC paths.
        let path = format!("{}/{}", self.session.git_dir, name);
        match self.location() {
            RepositoryLocation::Native { .. } => match std::fs::read(path) {
                Ok(v) => Ok(Some(v)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(e.into()),
            },
            RepositoryLocation::Wsl { distribution, .. } => {
                let mut test = Command::new("wsl.exe");
                test.args([
                    "--distribution",
                    distribution,
                    "--exec",
                    "test",
                    "-e",
                    &path,
                ]);
                let output = process::run(test)?;
                if output.code == Some(1) {
                    return Ok(None);
                }
                if !output.success {
                    return Err(self.failed(&output));
                }
                let mut cat = Command::new("wsl.exe");
                cat.args(["--distribution", distribution, "--exec", "cat", "--", &path]);
                let output = process::run(cat)?;
                if !output.success {
                    return Err(self.failed(&output));
                }
                Ok(Some(output.stdout))
            }
        }
    }
    fn optional_ref(&self, name: &str) -> Result<Option<String>> {
        let output = self.check(&["rev-parse", "--verify", "--quiet", name])?;
        match output.code {
            Some(0) => Ok(Some(process::text(output.stdout)?.trim().into())),
            Some(1) => Ok(None),
            _ => Err(self.failed(&output)),
        }
    }
    fn operation_metadata(&self) -> Result<OperationMetadata> {
        let mut metadata = Vec::new();
        for path in [
            "MERGE_HEAD",
            "ORIG_HEAD",
            "MERGE_MSG",
            "MERGE_MODE",
            "MERGE_AUTOSTASH",
            "AUTO_MERGE",
            "rebase-merge/head-name",
            "rebase-merge/orig-head",
            "rebase-merge/autostash",
            "rebase-merge/message",
            "rebase-merge/author-script",
            "rebase-merge/amend",
            "rebase-merge/update-refs",
            "rebase-merge/rewritten-list",
            "rebase-merge/rewritten-pending",
            "rebase-merge/onto",
            "rebase-merge/msgnum",
            "rebase-merge/end",
            "rebase-merge/git-rebase-todo",
            "rebase-merge/done",
            "rebase-merge/interactive",
            "rebase-merge/stopped-sha",
            "rebase-apply/rebasing",
            "rebase-apply/next",
            "rebase-apply/last",
            "sequencer/todo",
            "sequencer/head",
            "sequencer/opts",
            "BISECT_LOG",
        ] {
            metadata.push((path, self.metadata(path)?));
        }
        Ok(metadata)
    }
    pub(crate) fn conflict_context(&self) -> Result<String> {
        Ok(fingerprint((
            self.state()?.fingerprint,
            self.operation_metadata()?,
            self.optional_ref("MERGE_HEAD")?,
            self.optional_ref("CHERRY_PICK_HEAD")?,
            self.optional_ref("REVERT_HEAD")?,
            self.optional_ref("REBASE_HEAD")?,
        )))
    }
    pub fn operation_state(&self) -> Result<OperationState> {
        let entries = self.git_dir_entries()?;
        let metadata = self.operation_metadata()?;
        let value = |path: &str| {
            metadata
                .iter()
                .find(|(p, _)| *p == path)
                .and_then(|(_, v)| v.as_ref())
                .map(|b| String::from_utf8_lossy(b).trim().to_string())
        };
        let merge = self.optional_ref("MERGE_HEAD")?;
        let cherry = self.optional_ref("CHERRY_PICK_HEAD")?;
        let revert = self.optional_ref("REVERT_HEAD")?;
        let rebase = self.optional_ref("REBASE_HEAD")?;
        let kind = if entries.contains("BISECT_LOG") || entries.contains("rebase-apply") {
            OperationKind::Unsupported
        } else if entries.contains("rebase-merge") {
            OperationKind::Rebase
        } else if merge.is_some() {
            OperationKind::Merge
        } else if cherry.is_some() {
            OperationKind::CherryPick
        } else if revert.is_some() {
            OperationKind::Revert
        } else if entries.contains("sequencer") {
            let todo = value("sequencer/todo").unwrap_or_default();
            if todo
                .lines()
                .all(|l| l.starts_with("pick ") || l.trim().is_empty())
                && !todo.is_empty()
            {
                OperationKind::CherryPick
            } else if todo
                .lines()
                .all(|l| l.starts_with("revert ") || l.trim().is_empty())
                && !todo.is_empty()
            {
                OperationKind::Revert
            } else {
                OperationKind::Unsupported
            }
        } else {
            OperationKind::None
        };
        let state = self.state()?;
        let status = if self.session.bare {
            None
        } else {
            Some(self.status()?)
        };
        let conflicts = if self.session.bare {
            vec![]
        } else {
            self.unmerged()?
        };
        let mut working = Vec::new();
        for path in &conflicts {
            // Include raw working bytes even for add/add and modify/delete (where
            // diff --ours alone cannot fingerprint every case).
            // Unsupported editor paths must not prevent observing or aborting an
            // operation. The repository-wide status still fingerprints its diff.
            let snapshot = self.conflict_working_snapshot(path);
            working.push((
                path.clone(),
                snapshot.as_ref().ok().cloned(),
                snapshot.err().map(|e| (e.code, e.message)),
            ));
        }
        let index = self.check_text(&["ls-files", "--stage", "-z"])?;
        let all_refs = self.check_text(&[
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(symref)",
        ])?;
        let incoming = match kind {
            OperationKind::Merge => merge.clone(),
            OperationKind::Rebase => rebase.clone().or_else(|| value("rebase-merge/onto")),
            OperationKind::CherryPick => cherry.clone(),
            OperationKind::Revert => revert.clone(),
            _ => None,
        };
        let label = match kind {
            OperationKind::None => "No operation in progress",
            OperationKind::Merge => "Merge in progress",
            OperationKind::Rebase => "Rebase in progress (ours is the rebased destination; theirs is the replayed commit)",
            OperationKind::CherryPick => "Cherry-pick in progress",
            OperationKind::Revert => "Revert in progress",
            OperationKind::Unsupported => "Unsupported Git operation (bisect, apply-backend rebase, patch application or unknown sequencer); finish or abort in Git",
        }.to_string();
        let supported = !matches!(kind, OperationKind::None | OperationKind::Unsupported);
        let (step, total) = if kind == OperationKind::Rebase {
            (
                value("rebase-merge/msgnum").and_then(|s| s.parse().ok()),
                value("rebase-merge/end").and_then(|s| s.parse().ok()),
            )
        } else if matches!(kind, OperationKind::CherryPick | OperationKind::Revert) {
            if let Some(original) = value("sequencer/head")
                .filter(|s| matches!(s.len(), 40 | 64) && s.bytes().all(|b| b.is_ascii_hexdigit()))
            {
                let done: usize = self
                    .check_text(&["rev-list", "--count", &format!("{original}..HEAD"), "--"])?
                    .parse()
                    .map_err(|_| Error::new("gitParse", "Invalid sequencer progress"))?;
                let remaining = value("sequencer/todo")
                    .map(|t| {
                        t.lines()
                            .filter(|l| l.starts_with("pick ") || l.starts_with("revert "))
                            .count()
                    })
                    .unwrap_or(1);
                (Some(done + 1), Some(done + remaining.max(1)))
            } else {
                (Some(1), Some(1))
            }
        } else {
            (None, None)
        };
        let fingerprint = fingerprint((
            &state.fingerprint,
            status.as_ref().map(|s| &s.fingerprint),
            &index,
            &all_refs,
            &metadata,
            &merge,
            &cherry,
            &revert,
            &rebase,
            &working,
            format!("{kind:?}"),
        ));
        Ok(OperationState {
            kind,
            label,
            current: value("rebase-merge/head-name")
                .or(state.session.head_ref)
                .or(state.session.head),
            incoming,
            step,
            total,
            can_continue: supported && conflicts.is_empty(),
            can_skip: matches!(
                kind,
                OperationKind::Rebase | OperationKind::CherryPick | OperationKind::Revert
            ),
            conflicts,
            fingerprint,
        })
    }
    pub(crate) fn operation_writable(&self) -> Result<()> {
        self.require_worktree()?;
        if self.git_dir_entries()?.contains("index.lock") {
            return Err(Error::new(
                "indexLocked",
                "Another Git process holds index.lock; Gitty never removes it.",
            ));
        }
        Ok(())
    }
    fn valid_name(&self, name: &str, prefix: &str) -> Result<()> {
        if name.is_empty() || name.starts_with('-') || name.len() > 1024 || name.contains('\0') {
            return Err(Error::new("invalidReference", "Invalid branch or tag name"));
        }
        let output = self.check(&["check-ref-format", &format!("refs/{prefix}/{name}")])?;
        if !output.success {
            return Err(Error::new("invalidReference", "Invalid branch or tag name"));
        }
        Ok(())
    }
    /// True when switching HEAD to `oid` touches a tracked path that has local changes.
    fn switch_overlaps_changes(&self, oid: &str) -> Result<bool> {
        let dirty = self.status_entries()?.entries;
        if !dirty.iter().any(|e| !e.untracked) {
            return Ok(false);
        }
        let changed = self.check_text(&[
            "diff",
            "--name-only",
            "-z",
            "--no-renames",
            "HEAD",
            oid,
            "--",
        ])?;
        let changed: std::collections::HashSet<&str> =
            changed.split('\0').filter(|p| !p.is_empty()).collect();
        Ok(dirty.iter().filter(|e| !e.untracked).any(|e| {
            changed.contains(e.path.as_str())
                || e.old_path.as_deref().is_some_and(|p| changed.contains(p))
        }))
    }
    pub(crate) fn protect_untracked(&self, targets: &[String]) -> Result<()> {
        // reset --hard (used internally by rebase) deletes obstructing untracked
        // files, including ignored files that porcelain status does not report.
        // No exclude flags: inspect ignored files too, without reading their data.
        let started = std::time::Instant::now();
        let raw_others = self.check_text(&["ls-files", "--others", "-z"])?;
        if raw_others.is_empty() {
            return Ok(());
        }
        let mut others: Vec<_> = raw_others
            .split('\0')
            .filter(|p| !p.is_empty())
            .map(|p| p.trim_end_matches('/'))
            .collect();
        others.sort_unstable();
        others.dedup();
        let remaining = || {
            process::CHECK_TIMEOUT.checked_sub(started.elapsed())
                .filter(|d| !d.is_zero())
                .ok_or_else(|| Error::new("timeout", "Untracked-file protection exceeded its deadline. Narrow this operation or complete it in Git."))
        };
        for target in targets {
            let output = process::run_for(
                process::git_command(
                    self.location(),
                    &args(&["ls-tree", "-r", "--name-only", "-z", target]),
                )?,
                remaining()?,
            )?;
            if !output.success {
                return Err(self.failed(&output));
            }
            let tree = process::text(output.stdout)?;
            for tracked in tree.split('\0').filter(|p| !p.is_empty()) {
                remaining()?;
                // Avoid a quadratic scan of every tracked/untracked pair, and
                // share a deadline across every tree in a long rebase/replay.
                let mut ancestor = tracked;
                let mut collision = None;
                loop {
                    if let Ok(i) = others.binary_search(&ancestor) {
                        collision = Some(others[i]);
                        break;
                    }
                    match ancestor.rsplit_once('/') {
                        Some((parent, _)) => ancestor = parent,
                        None => break,
                    }
                }
                let prefix = format!("{tracked}/");
                let i = others.partition_point(|path| *path < prefix.as_str());
                collision = collision.or_else(|| {
                    others
                        .get(i)
                        .copied()
                        .filter(|path| path.starts_with(&prefix))
                });
                if let Some(path) = collision {
                    return Err(Error::new("dirtyWorktree", format!("Untracked or ignored path {path:?} could be overwritten by this operation. Move or preserve it in Git first.")));
                }
            }
        }
        Ok(())
    }
    fn validate_rebase_todo_lines<'a>(lines: impl Iterator<Item = &'a str>) -> Result<bool> {
        let mut has_interactive = false;
        for line in lines {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let first_word = line.split_whitespace().next().unwrap_or("");
            match first_word {
                "pick" | "drop" => {}
                "reword" | "squash" | "fixup" => {
                    has_interactive = true;
                }
                _ => {
                    return Err(Error::new(
                        "unsupportedOperation",
                        "This external rebase contains an unsupported directive (such as exec, break, label, reset, merge, update-ref, or unknown/abbreviated commands). Continue it in Git, or abort it here.",
                    ));
                }
            }
        }
        Ok(has_interactive)
    }
    fn run_operation(
        &self,
        request: OperationRequest,
        editor: Option<&crate::editor::EditorRegistry>,
    ) -> Result<OperationResult> {
        self.operation_writable()?;
        let before = self.operation_state()?;
        let state = self.state()?;
        if request.expected_operation != before.fingerprint
            || request.expected_head != state.session.head
            || request.expected_head_ref != state.session.head_ref
        {
            return Err(Error::new(
                "staleOperation",
                "Repository changed since this action was reviewed. Refresh and review it again.",
            ));
        }
        let control = matches!(
            request.action,
            GitAction::Continue | GitAction::Skip | GitAction::Abort
        );
        let aborting = matches!(request.action, GitAction::Abort);
        let is_continue = matches!(request.action, GitAction::Continue);
        let is_interactive_rebase = matches!(request.action, GitAction::InteractiveRebase { .. });
        if !control && before.kind != OperationKind::None {
            return Err(Error::new("operationInProgress", before.label));
        }
        let carry = matches!(
            request.action,
            GitAction::SwitchBranch {
                carry_changes: true,
                ..
            }
        );
        if !control && !carry && !self.status_entries()?.entries.is_empty() {
            return Err(Error::new("dirtyWorktree", "Commit or explicitly stash all staged, unstaged and untracked changes first. Gitty never automatically stashes."));
        }
        let mut input = Vec::new();
        let mut rebase_plan = None;
        let mut a = args(&[
            "-c",
            "core.editor=true",
            "-c",
            "sequence.editor=true",
            "-c",
            "merge.autoStash=false",
            "-c",
            "rebase.autoStash=false",
        ]);
        match request.action {
            GitAction::CreateBranch {
                name,
                start_point,
                checkout,
            } => {
                self.valid_name(&name, "heads")?;
                let oid = resolve(self.location(), &start_point)?;
                if checkout {
                    a.extend(args(&[
                        "switch",
                        "--no-overwrite-ignore",
                        "--no-guess",
                        "-c",
                        &name,
                        &oid,
                    ]));
                } else {
                    a.extend(args(&["branch", "--", &name, &oid]));
                }
            }
            GitAction::SwitchBranch {
                branch,
                carry_changes,
            } => {
                // The UI sends full ref names (refs/heads/x); accept short names too.
                let branch = branch
                    .strip_prefix("refs/heads/")
                    .unwrap_or(&branch)
                    .to_string();
                self.valid_name(&branch, "heads")?;
                let oid = resolve(self.location(), &format!("refs/heads/{branch}"))?;
                a.extend(args(&["switch", "--no-overwrite-ignore", "--no-guess"]));
                // Plain switch carries work Git can keep as-is. Only when the
                // target changes a path that has local changes is a three-way
                // merge needed (it leaves conflicts for the editor); using it
                // otherwise would needlessly unstage unrelated staged changes.
                if carry_changes && self.switch_overlaps_changes(&oid)? {
                    a.push("--merge".into());
                }
                a.extend(args(&["--", &branch]));
            }
            GitAction::Merge {
                source,
                no_fast_forward,
            } => {
                if state.session.head_ref.is_none() {
                    return Err(Error::new(
                        "detachedHead",
                        "Switch to a local branch before merging.",
                    ));
                }
                let oid = resolve(self.location(), &source)?;
                a.extend(args(&[
                    "merge",
                    "--no-edit",
                    "--no-autostash",
                    "--no-overwrite-ignore",
                    if no_fast_forward { "--no-ff" } else { "--ff" },
                    "--",
                    &oid,
                ]));
            }
            GitAction::Rebase { onto } => {
                if state.session.head_ref.is_none() {
                    return Err(Error::new(
                        "detachedHead",
                        "Switch to a local branch before rebasing.",
                    ));
                }
                let oid = resolve(self.location(), &onto)?;
                let merges =
                    self.check_text(&["rev-list", "--merges", &format!("{oid}..HEAD"), "--"])?;
                if !merges.is_empty() {
                    return Err(Error::new("mergeHistory", "This rebase would replay merge commits. Gitty refuses to flatten merge history; use Git with --rebase-merges explicitly."));
                }
                let replay = self.check_text(&["rev-list", &format!("{oid}..HEAD"), "--"])?;
                let mut targets: Vec<String> = replay.lines().map(String::from).collect();
                targets.push(oid.clone());
                self.protect_untracked(&targets)?;
                a.extend(args(&[
                    "rebase",
                    "--merge",
                    "--no-autostash",
                    "--no-update-refs",
                    "--no-rebase-merges",
                    "--no-autosquash",
                    &oid,
                ]));
            }
            GitAction::InteractiveRebase { onto, steps } => {
                if state.session.head_ref.is_none()
                    || !matches!(self.location(), RepositoryLocation::Native { .. })
                {
                    return Err(Error::new(
                        "unsupportedOperation",
                        "Interactive rebase requires a checked-out native branch.",
                    ));
                }
                if editor.is_none() {
                    return Err(Error::new(
                        "unsupportedOperation",
                        "Interactive rebase requires the native editor bridge.",
                    ));
                }
                let oid = resolve(self.location(), &onto)?;
                if self
                    .check(&["merge-base", "--is-ancestor", &oid, "HEAD"])?
                    .code
                    != Some(0)
                {
                    return Err(Error::new(
                        "invalidRequest",
                        "Choose an ancestor of HEAD as the interactive rebase base.",
                    ));
                }
                let replay =
                    self.check_text(&["rev-list", "--reverse", &format!("{oid}..HEAD"), "--"])?;
                let originals: Vec<_> = replay.lines().collect();
                if originals.is_empty() || originals.len() > 100 || steps.len() != originals.len() {
                    return Err(Error::new(
                        "invalidRequest",
                        "Review every commit in a linear range of 1–100 commits.",
                    ));
                }
                let merges =
                    self.check_text(&["rev-list", "--merges", &format!("{oid}..HEAD"), "--"])?;
                if !merges.is_empty() {
                    return Err(Error::new("mergeHistory", "Interactive rebase does not flatten merge commits; use Git with --rebase-merges."));
                }
                let mut seen = std::collections::HashSet::new();
                let mut applied = 0;
                for step in &steps {
                    if !originals.contains(&step.oid.as_str()) || !seen.insert(step.oid.as_str()) {
                        return Err(Error::new(
                            "invalidRequest",
                            "The reviewed rebase commits no longer match the selected range.",
                        ));
                    }
                    if matches!(
                        step.instruction,
                        RebaseInstruction::Squash | RebaseInstruction::Fixup
                    ) && applied == 0
                    {
                        return Err(Error::new(
                            "invalidRequest",
                            "A squash or fixup needs an earlier retained commit.",
                        ));
                    }
                    if step.instruction != RebaseInstruction::Drop {
                        applied += 1;
                    }
                }
                if applied == 0 {
                    return Err(Error::new(
                        "invalidRequest",
                        "Retain at least one commit in the rebase plan.",
                    ));
                }
                let mut targets = originals
                    .iter()
                    .map(|id| id.to_string())
                    .collect::<Vec<_>>();
                targets.push(oid.clone());
                self.protect_untracked(&targets)?;
                rebase_plan = Some(steps);
                a.extend(args(&[
                    "-c",
                    "rebase.abbreviateCommands=false",
                    "rebase",
                    "--interactive",
                    "--merge",
                    "--no-autostash",
                    "--no-update-refs",
                    "--no-rebase-merges",
                    "--no-autosquash",
                    &oid,
                ]));
            }
            GitAction::CherryPick { commits, mainline } => {
                if commits.is_empty() || commits.len() > 100 {
                    return Err(Error::new(
                        "invalidRequest",
                        "Choose between 1 and 100 commits in replay order.",
                    ));
                }
                let mut ids = Vec::new();
                for commit in commits {
                    let oid = resolve(self.location(), &commit)?;
                    let parents =
                        self.check_text(&["rev-list", "--parents", "-n", "1", &oid, "--"])?;
                    let count = parents.split_whitespace().count() - 1;
                    if count <= 1 && mainline.is_some_and(|n| n > 1) {
                        return Err(Error::new("invalidMainline", "A non-merge commit has no mainline parent beyond 1. Split this selection into separate actions."));
                    }
                    if count > 1 && !mainline.is_some_and(|n| n > 0 && n <= count) {
                        return Err(Error::new(
                            "mainlineRequired",
                            "A merge commit requires a valid 1-based mainline parent.",
                        ));
                    }
                    ids.push(oid);
                }
                if mainline == Some(0) {
                    return Err(Error::new(
                        "invalidRequest",
                        "Mainline parent numbers start at 1.",
                    ));
                }
                self.protect_untracked(&ids)?;
                a.extend(args(&["cherry-pick"]));
                if let Some(n) = mainline {
                    a.extend(args(&["--mainline", &n.to_string()]));
                }
                a.push("--".into());
                a.extend(ids);
            }
            GitAction::CreateTag { name, oid, message } => {
                self.valid_name(&name, "tags")?;
                let oid = resolve(self.location(), &oid)?;
                a.push("tag".into());
                if let Some(message) = message {
                    if message.trim().is_empty() || message.contains('\0') || message.len() > 65536
                    {
                        return Err(Error::new(
                            "invalidRequest",
                            "Annotated tags need a nonblank message of at most 64 KiB without NUL.",
                        ));
                    }
                    input = message.into_bytes();
                    a.extend(args(&["--annotate", "--file=-"]));
                } else {
                    // tag.gpgSign otherwise silently changes a lightweight tag to annotated.
                    a.extend(args(&["--no-sign"]));
                }
                a.extend(args(&["--", &name, &oid]));
            }
            action @ (GitAction::Continue | GitAction::Skip | GitAction::Abort) => {
                let command = match before.kind {
                    OperationKind::Merge => "merge",
                    OperationKind::Rebase => "rebase",
                    OperationKind::CherryPick => "cherry-pick",
                    OperationKind::Revert => "revert",
                    _ => return Err(Error::new("unsupportedOperation", before.label)),
                };
                let flag = match action {
                    GitAction::Continue if before.can_continue => "--continue",
                    GitAction::Skip if before.can_skip => "--skip",
                    GitAction::Abort => "--abort",
                    _ => {
                        return Err(Error::new(
                            "unresolvedConflict",
                            "This operation cannot continue or skip in its current state.",
                        ))
                    }
                };
                if before.kind == OperationKind::Rebase && flag != "--continue" {
                    // Git rebase abort/skip resets the entire index/worktree,
                    // unlike merge/cherry-pick's reset --merge. We cannot tell a
                    // staged resolution from unrelated edits after a restart.
                    if self
                        .status_entries()?
                        .entries
                        .iter()
                        .any(|e| !e.conflicted && !e.untracked)
                    {
                        return Err(Error::new("dirtyWorktree", "Rebase abort/skip would discard staged or unstaged changes outside unresolved conflicts. Preserve them and finish this action in Git."));
                    }
                    let target = if flag == "--abort" {
                        let original =
                            self.metadata("rebase-merge/orig-head")?.ok_or_else(|| {
                                Error::new(
                                    "unsupportedOperation",
                                    "Missing rebase abort target; finish in Git.",
                                )
                            })?;
                        resolve(self.location(), process::text(original)?.trim())?
                    } else {
                        resolve(self.location(), "HEAD")?
                    };
                    self.protect_untracked(&[target])?;
                }
                // Validate rebase todo instructions and enforce editor requirements
                if before.kind == OperationKind::Rebase && flag != "--abort" {
                    let mut interactive = false;
                    if let Some(todo) = self.metadata("rebase-merge/git-rebase-todo")? {
                        let text = process::text(todo)?;
                        interactive |= Self::validate_rebase_todo_lines(text.lines())?;
                    }
                    if let Some(done) = self.metadata("rebase-merge/done")? {
                        let text = process::text(done)?;
                        interactive |= Self::validate_rebase_todo_lines(text.lines())?;
                    }
                    if matches!(self.location(), RepositoryLocation::Wsl { .. }) && interactive {
                        return Err(Error::new(
                            "unsupportedOperation",
                            "Interactive rebase continuation is currently not supported for WSL repositories. Finish this action in Git.",
                        ));
                    }
                    if interactive && editor.is_none() {
                        return Err(Error::new(
                            "unsupportedOperation",
                            "Interactive rebase continuation requires the editor bridge.",
                        ));
                    }
                }
                if before.kind != OperationKind::Merge {
                    let mut targets = Vec::new();
                    if flag == "--abort" {
                        if let Some(original) = self.metadata("sequencer/head")? {
                            targets
                                .push(resolve(self.location(), process::text(original)?.trim())?);
                        }
                    } else {
                        let todo_path = if before.kind == OperationKind::Rebase {
                            "rebase-merge/git-rebase-todo"
                        } else {
                            "sequencer/todo"
                        };
                        if let Some(todo) = self.metadata(todo_path)? {
                            for line in process::text(todo)?.lines() {
                                let mut words = line.split_whitespace();
                                match (words.next(), words.next()) {
                                    (Some("pick" | "reword" | "squash" | "fixup"), Some(id)) => {
                                        targets.push(resolve(self.location(), id)?)
                                    }
                                    (Some("revert"), Some(id)) => {
                                        targets.push(resolve(self.location(), &format!("{id}^"))?)
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                    if !targets.is_empty() {
                        self.protect_untracked(&targets)?;
                    }
                }
                a.extend(args(&[command, flag]));
            }
        }
        let mut env = Vec::new();
        let mut _editor_guard = None;
        if (before.kind == OperationKind::Rebase && is_continue) || is_interactive_rebase {
            if let (RepositoryLocation::Native { .. }, Some(editor)) = (self.location(), editor) {
                env.push((
                    "GIT_EDITOR".into(),
                    crate::askpass::shell_quote(&editor.script_path.to_string_lossy()),
                ));
                env.push(("GITTY_EDITOR_PORT".into(), editor.port.to_string()));
                _editor_guard = Some(editor.start_with_plan(
                    &self.session.git_dir,
                    &self.session.common_dir,
                    rebase_plan,
                ));
                env.push((
                    "GITTY_EDITOR_TOKEN".into(),
                    _editor_guard.as_ref().unwrap().token().into(),
                ));
                if is_interactive_rebase {
                    env.push((
                        "GIT_SEQUENCE_EDITOR".into(),
                        crate::askpass::shell_quote(&editor.script_path.to_string_lossy()),
                    ));
                }
            }
        }
        let output = self.write(&a, &env, &input, 65536)?;
        let operation = self.operation_state().map_err(|e| {
            Error::new(
                "mutationUnverified",
                format!(
                    "{} Refresh before retrying; Git may already have changed the repository.",
                    e.message
                ),
            )
        })?;
        let head = self.head_commit().map_err(|e| {
            Error::new(
                "mutationUnverified",
                format!(
                    "{} Git may already have changed the repository. Refresh before retrying.",
                    e.message
                ),
            )
        })?;
        let changed = operation.fingerprint != before.fingerprint || head != state.session.head;
        if !output.success && (operation.conflicts.is_empty() || aborting || !changed) {
            if changed {
                return Err(Error::new("mutationUnverified", format!("Git reported failure but repository state changed. Refresh and review before retrying.\n{}", crate::mutate::report(&output))));
            }
            return Err(self.failed(&output));
        }
        Ok(OperationResult {
            head,
            operation,
            output: if output.stdout.is_empty() && output.stderr.is_empty() && output.success {
                String::new()
            } else {
                crate::mutate::report(&output)
            },
        })
    }
    pub fn remotes(&self) -> Result<Vec<RemoteInfo>> {
        let state = self.state()?;
        let upstream = if let Some(head) = &state.session.head_ref {
            self.check_text(&["for-each-ref", "--format=%(upstream)", head])?
        } else {
            String::new()
        };
        state
            .remotes
            .iter()
            .map(|name| {
                let prefix = format!("refs/remotes/{name}/");
                Ok(RemoteInfo {
                    name: name.clone(),
                    fetch_url: self.check_text(&["remote", "get-url", "--", name])?,
                    push_url: self.check_text(&["remote", "get-url", "--push", "--", name])?,
                    branches: state
                        .refs
                        .iter()
                        .filter_map(|r| r.full_name.strip_prefix(&prefix))
                        .filter(|s| *s != "HEAD")
                        .map(String::from)
                        .collect(),
                    current_upstream: upstream
                        .strip_prefix(&prefix)
                        .map(|s| format!("{name}/{s}")),
                })
            })
            .collect()
    }
}
