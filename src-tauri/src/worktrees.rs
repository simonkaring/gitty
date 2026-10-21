use crate::{
    dto::*,
    process,
    repository::{Repository, Service},
};
use serde::{Deserialize, Serialize};

pub(crate) fn same_location(a: &RepositoryLocation, b: &RepositoryLocation) -> bool {
    fn native(path: &str) -> String {
        let canonical = std::fs::canonicalize(path).ok();
        let value = canonical.as_ref().and_then(|p| p.to_str()).unwrap_or(path);
        if cfg!(windows) {
            value
                .trim_start_matches("\\\\?\\")
                .replace('\\', "/")
                .to_lowercase()
        } else {
            value.into()
        }
    }
    match (a, b) {
        (RepositoryLocation::Native { path: a }, RepositoryLocation::Native { path: b }) => {
            native(a) == native(b)
        }
        _ => a == b,
    }
}

fn location_at(origin: &RepositoryLocation, root: &str) -> RepositoryLocation {
    match origin {
        RepositoryLocation::Native { .. } => RepositoryLocation::Native { path: root.into() },
        RepositoryLocation::Wsl { distribution, .. } => RepositoryLocation::Wsl {
            distribution: distribution.clone(),
            path: root.into(),
        },
        RepositoryLocation::Ssh {
            host, port, user, ..
        } => RepositoryLocation::Ssh {
            host: host.clone(),
            port: *port,
            user: user.clone(),
            path: root.into(),
        },
    }
}

fn require_new_destination(location: &RepositoryLocation, path: &str) -> Result<()> {
    let exists = match location {
        RepositoryLocation::Native { .. } => match std::fs::symlink_metadata(path) {
            Ok(_) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.into()),
        },
        RepositoryLocation::Wsl { distribution, .. } => {
            if !cfg!(windows) {
                return Err(Error::new("unsupportedPlatform", "WSL requires Windows"));
            }
            let mut command = std::process::Command::new("wsl.exe");
            command.args([
                "--distribution",
                distribution,
                "--exec",
                "test",
                "-e",
                path,
                "-o",
                "-L",
                path,
            ]);
            let output = process::run_for(command, std::time::Duration::from_secs(30))?;
            match output.code {
                Some(0) => true,
                Some(1) => false,
                _ => return Err(Error::new("io", "Cannot check the WSL destination")),
            }
        }
        RepositoryLocation::Ssh { .. } => {
            let command = process::ssh_exec(
                location,
                &[],
                &[
                    "test".to_string(),
                    "-e".into(),
                    path.into(),
                    "-o".into(),
                    "-L".into(),
                    path.into(),
                ],
            )?;
            let output = process::run_for(command, std::time::Duration::from_secs(30))?;
            match output.code {
                Some(0) => true,
                Some(1) => false,
                _ => {
                    return Err(Error::new(
                        "io",
                        "Cannot check the destination on the remote host",
                    ))
                }
            }
        }
    };
    if exists {
        Err(Error::new(
            "destinationExists",
            "Choose a destination that does not already exist",
        ))
    } else {
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub bare: bool,
    pub main: bool,
    pub locked: Option<String>,
    pub prunable: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorktreeRequest {
    pub action: String,
    pub path: String,
    pub destination: String,
    pub branch: String,
    pub start_point: String,
    pub reason: String,
    pub force: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeReview {
    pub token: String,
    pub preview: String,
}

fn parse(bytes: Vec<u8>) -> Result<Vec<Worktree>> {
    let text = process::text(bytes)?;
    let mut result = Vec::new();
    let mut entry: Option<Worktree> = None;
    for field in text.split('\0') {
        if let Some(path) = field.strip_prefix("worktree ") {
            if let Some(previous) = entry.take() {
                result.push(previous);
            }
            entry = Some(Worktree {
                path: path.into(),
                head: None,
                branch: None,
                bare: false,
                main: result.is_empty(),
                locked: None,
                prunable: None,
            });
        } else if let Some(item) = entry.as_mut() {
            if let Some(value) = field.strip_prefix("HEAD ") {
                item.head = Some(value.into());
            } else if let Some(value) = field.strip_prefix("branch ") {
                item.branch = Some(value.into());
            } else if field == "bare" {
                item.bare = true;
            } else if field == "locked" || field.starts_with("locked ") {
                item.locked = Some(field.strip_prefix("locked ").unwrap_or("").into());
            } else if field == "prunable" || field.starts_with("prunable ") {
                item.prunable = Some(field.strip_prefix("prunable ").unwrap_or("").into());
            }
        }
    }
    if let Some(item) = entry {
        result.push(item);
    }
    if result.is_empty() {
        return Err(Error::new("gitParse", "No worktrees returned by Git"));
    }
    Ok(result)
}

impl Repository {
    pub fn worktrees(&self) -> Result<Vec<Worktree>> {
        let mut list = parse(
            self.check(&["worktree", "list", "--porcelain", "-z", "--expire", "now"])?
                .stdout,
        )?;
        if matches!(self.session.location, RepositoryLocation::Native { .. }) {
            for item in &mut list {
                if let Ok(path) = std::fs::canonicalize(&item.path) {
                    item.path = path
                        .to_str()
                        .ok_or_else(|| {
                            Error::new("unsupportedEncoding", "Worktree path is not UTF-8")
                        })?
                        .into();
                }
            }
        }
        Ok(list)
    }

    pub fn worktree_review(&self, request: &WorktreeRequest) -> Result<WorktreeReview> {
        if !matches!(
            request.action.as_str(),
            "create" | "move" | "remove" | "lock" | "unlock" | "prune"
        ) {
            return Err(Error::new("invalidRequest", "Unknown worktree action"));
        }
        for value in [
            &request.path,
            &request.destination,
            &request.branch,
            &request.start_point,
            &request.reason,
        ] {
            if value.contains('\0') || value.len() > 4096 {
                return Err(Error::new(
                    "invalidRequest",
                    "Worktree fields must be at most 4096 bytes and contain no NUL",
                ));
            }
        }
        if matches!(self.session.location, RepositoryLocation::Ssh { .. })
            && matches!(request.action.as_str(), "move" | "remove")
        {
            return Err(Error::new(
                "unsupportedLocation",
                "Moving or removing a worktree is not available over SSH yet; do it in a terminal on that host.",
            ));
        }
        if matches!(request.action.as_str(), "create" | "move") {
            if matches!(self.session.location, RepositoryLocation::Native { .. })
                && request
                    .destination
                    .to_ascii_lowercase()
                    .starts_with("\\\\wsl")
            {
                return Err(Error::new(
                    "wslLocationRequired",
                    "Use a WSL repository session and an absolute Linux destination",
                ));
            }
            let absolute = match self.session.location {
                RepositoryLocation::Native { .. } => {
                    std::path::Path::new(&request.destination).is_absolute()
                }
                RepositoryLocation::Wsl { .. } | RepositoryLocation::Ssh { .. } => {
                    request.destination.starts_with('/')
                }
            };
            if !absolute {
                return Err(Error::new(
                    "invalidPath",
                    "Destination must be an absolute path",
                ));
            }
            require_new_destination(&self.session.location, &request.destination)?;
        }
        let list = self.worktrees()?;
        let mut evidence = serde_json::to_vec(&(request, &list))
            .map_err(|e| Error::new("invalidRequest", e.to_string()))?;
        let mut preview = String::new();
        if request.action == "create" {
            if request.start_point.is_empty() || request.start_point.starts_with('-') {
                return Err(Error::new(
                    "invalidRequest",
                    "A starting branch or commit is required",
                ));
            }
            let oid = self.check_text(&[
                "rev-parse",
                "--verify",
                "--end-of-options",
                &format!("{}^{{commit}}", request.start_point),
            ])?;
            if !request.branch.is_empty() {
                if !self
                    .check(&["check-ref-format", "--branch", &request.branch])?
                    .success
                {
                    return Err(Error::new(
                        "invalidRequest",
                        "Invalid worktree branch name.",
                    ));
                }
            }
            preview = format!(
                "Create at {} from {} ({oid}){}",
                request.destination,
                request.start_point,
                if request.branch.is_empty() {
                    String::new()
                } else {
                    format!(" on new branch {}", request.branch)
                }
            );
            evidence.extend(oid.as_bytes());
        }
        if request.action == "prune" {
            let output = self.check(&[
                "worktree",
                "prune",
                "--dry-run",
                "--verbose",
                "--expire",
                "now",
            ])?;
            preview = process::text([output.stdout, output.stderr].concat())?;
            evidence.extend(preview.as_bytes());
        } else if request.action != "create" {
            let target = list
                .iter()
                .find(|item| item.path == request.path)
                .ok_or_else(|| {
                    Error::new(
                        "staleOperation",
                        "Worktree no longer exists. Refresh and review again.",
                    )
                })?;
            if target.main || target.bare {
                return Err(Error::new(
                    "invalidRequest",
                    "The main or bare worktree cannot be managed here",
                ));
            }
            if matches!(request.action.as_str(), "move" | "remove") && target.locked.is_some() {
                return Err(Error::new(
                    "worktreeLocked",
                    "Unlock this worktree explicitly first",
                ));
            }
            if matches!(request.action.as_str(), "move" | "remove") {
                let view = self.worktree_view(&target.path);
                let status = view.status()?;
                if request.action == "remove" && !request.force && !status.entries.is_empty() {
                    return Err(Error::new(
                        "dirtyWorktree",
                        "Worktree has changes. Review Force remove to discard them.",
                    ));
                }
                evidence.extend(status.fingerprint.as_bytes());
                preview = format!(
                    "{}\n{} changed paths. Branch {} is retained.",
                    target.path,
                    status.entries.len(),
                    target.branch.as_deref().unwrap_or("(detached)")
                );
                if request.action == "remove" {
                    // Normal removal can delete ignored files too. Hash in a batch.
                    let ignored = view.check(&[
                        "ls-files",
                        "--others",
                        "--ignored",
                        "--exclude-standard",
                        "-z",
                    ])?;
                    let names = process::text(ignored.stdout)?;
                    let names: Vec<&str> =
                        names.split('\0').filter(|name| !name.is_empty()).collect();
                    preview.push_str(&format!(
                        "\n{} ignored paths may also be removed.",
                        names.len()
                    ));
                    if names.iter().any(|name| name.ends_with('/'))
                        || status
                            .entries
                            .iter()
                            .any(|entry| entry.untracked && entry.path.ends_with('/'))
                    {
                        return Err(Error::new("unsupportedOperation", "Nested repository contents cannot be safely reviewed for removal. Manage them outside Gitty first."));
                    }
                    evidence.extend(view.untracked_content_hash(&names)?.to_le_bytes());
                }
            }
        }
        use std::hash::{Hash, Hasher};
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        evidence.hash(&mut hash);
        Ok(WorktreeReview {
            token: format!("{:016x}", hash.finish()),
            preview,
        })
    }
}

impl Service {
    pub fn worktree_execute(
        &self,
        handle: &str,
        request: &WorktreeRequest,
        token: &str,
    ) -> Result<()> {
        self.mutate(handle, |repo| {
            if repo.worktree_review(request)?.token != token {
                return Err(Error::new(
                    "staleOperation",
                    "Worktree changed. Refresh and review again.",
                ));
            }
            if matches!(request.action.as_str(), "move" | "remove") {
                self.require_closed_worktree(repo, &request.path)?;
            }
            let before = repo.worktrees()?;
            if request.action == "prune" {
                // Prune is repository-wide; never invalidate an open session even if its folder went missing.
                for target in &before {
                    if target.prunable.is_some() {
                        self.require_closed_worktree(repo, &target.path)?;
                    }
                }
            }
            let mut command = vec!["worktree".to_string(), request.action.clone()];
            let valid =
                |value: &str| !value.is_empty() && !value.contains('\0') && value.len() <= 4096;
            match request.action.as_str() {
                "create" => {
                    command[1] = "add".into();
                    if !valid(&request.destination) || !valid(&request.start_point) {
                        return Err(Error::new(
                            "invalidRequest",
                            "Destination and starting point are required",
                        ));
                    }
                    if !request.branch.is_empty() {
                        if !repo.check(&["check-ref-format", "--branch", &request.branch])?.success {
                            return Err(Error::new("invalidRequest", "Invalid worktree branch name."));
                        }
                        command.extend(["-b".into(), request.branch.clone()]);
                    }
                    command.extend([
                        "--".into(),
                        request.destination.clone(),
                        request.start_point.clone(),
                    ]);
                }
                "move" => {
                    if !valid(&request.destination) {
                        return Err(Error::new("invalidRequest", "Destination is required"));
                    }
                    command.extend([
                        "--".into(),
                        request.path.clone(),
                        request.destination.clone(),
                    ]);
                }
                "remove" => {
                    if request.force {
                        command.push("--force".into());
                    }
                    command.extend(["--".into(), request.path.clone()]);
                }
                "lock" => {
                    if !request.reason.is_empty() {
                        command.extend(["--reason".into(), request.reason.clone()]);
                    }
                    command.extend(["--".into(), request.path.clone()]);
                }
                "unlock" => command.extend(["--".into(), request.path.clone()]),
                "prune" => command.extend(["--verbose".into(), "--expire".into(), "now".into()]),
                _ => return Err(Error::new("invalidRequest", "Unknown worktree action")),
            }
            let output = repo.write(&command, &[], &[], 0)?;
            if !output.success {
                return Err(Error::new(
                    "git",
                    format!(
                        "{} Refresh and review before retrying.",
                        String::from_utf8_lossy(&output.stderr).trim()
                    ),
                ));
            }
            let after = repo.worktrees()?;
            if request.action == "move" {
                let candidates: Vec<_> = after.iter().filter(|item| !before.iter().any(|old| old.path == item.path)).collect();
                let original = before.iter().find(|item| item.path == request.path);
                let moved = match candidates.as_slice() {
                    [moved] if original.is_some_and(|old| old.branch == moved.branch && old.head == moved.head) => moved,
                    _ => return Err(Error::new("mutationUnverified", "Move completed but its destination could not be verified. Refresh before further action.")),
                };
                self.relocate_recent_worktree(&location_at(&repo.session.location, &request.path), Some(location_at(&repo.session.location, &moved.path)))?;
            } else if matches!(request.action.as_str(), "remove" | "prune") {
                for removed in before.iter().filter(|old| !after.iter().any(|item| item.path == old.path)) {
                    self.relocate_recent_worktree(&location_at(&repo.session.location, &removed.path), None)?;
                }
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{commit, git, init, open};

    fn request(action: &str, path: &str) -> WorktreeRequest {
        WorktreeRequest {
            action: action.into(),
            path: path.into(),
            destination: String::new(),
            branch: String::new(),
            start_point: "HEAD".into(),
            reason: String::new(),
            force: false,
        }
    }
    fn execute(service: &Service, handle: &str, request: &WorktreeRequest) -> Result<()> {
        let review = service.repo(handle)?.worktree_review(request)?;
        service.worktree_execute(handle, request, &review.token)
    }

    #[test]
    fn worktree_lifecycle_preserves_branch_and_updates_recents() {
        let repo = init();
        std::fs::write(repo.path().join("base"), "base").unwrap();
        commit(repo.path(), "initial");
        let data = tempfile::tempdir().unwrap();
        let folders = tempfile::tempdir().unwrap();
        let mut service = Service::new(data.path().into());
        let main = open(&mut service, repo.path());
        let handle = &main.session.handle;
        let target = folders.path().join("topic space");
        let path = target.to_str().unwrap();
        let mut create = request("create", "");
        create.destination = path.into();
        create.branch = "topic".into();
        execute(&service, handle, &create).unwrap();
        let list = service.repo(handle).unwrap().worktrees().unwrap();
        assert_eq!(list.len(), 2);
        assert!(list[0].main);
        let item = list
            .iter()
            .find(|item| item.branch.as_deref() == Some("refs/heads/topic"))
            .unwrap();
        let canonical = item.path.clone();
        assert!(!item.main);
        let linked = open(&mut service, &target);
        let moved = folders.path().join("moved");
        let mut move_request = request("move", &canonical);
        move_request.destination = moved.to_str().unwrap().into();
        assert_eq!(
            execute(&service, handle, &move_request).unwrap_err().code,
            "worktreeOpen"
        );
        service.close(&linked.session.handle).unwrap();
        let mut lock = request("lock", &canonical);
        lock.reason = "external drive\nkeep safe".into();
        execute(&service, handle, &lock).unwrap();
        assert_eq!(
            service.repo(handle).unwrap().worktrees().unwrap()[1]
                .locked
                .as_deref(),
            Some(lock.reason.as_str())
        );
        assert_eq!(
            execute(&service, handle, &move_request).unwrap_err().code,
            "worktreeLocked"
        );
        execute(&service, handle, &request("unlock", &canonical)).unwrap();
        execute(&service, handle, &move_request).unwrap();
        assert!(moved.join("base").exists());
        assert!(!target.exists());
        let new_path = service.repo(handle).unwrap().worktrees().unwrap()[1]
            .path
            .clone();
        assert!(service
            .recent()
            .unwrap()
            .iter()
            .any(|location| same_location(
                location,
                &location_at(&main.session.location, &new_path)
            )));
        execute(&service, handle, &request("remove", &new_path)).unwrap();
        assert!(!moved.exists());
        assert_eq!(
            git(repo.path(), &["rev-parse", "topic"]),
            main.session.head.unwrap()
        );
        assert_eq!(service.repo(handle).unwrap().worktrees().unwrap().len(), 1);
    }

    #[test]
    fn worktree_force_removal_requires_fresh_content_and_explicit_unlock() {
        let repo = init();
        std::fs::write(repo.path().join("base"), "base").unwrap();
        commit(repo.path(), "initial");
        let data = tempfile::tempdir().unwrap();
        let folders = tempfile::tempdir().unwrap();
        let mut service = Service::new(data.path().into());
        let main = open(&mut service, repo.path());
        let handle = &main.session.handle;
        let target = folders.path().join("topic");
        git(
            repo.path(),
            &["worktree", "add", "-b", "topic", target.to_str().unwrap()],
        );
        let path = service.repo(handle).unwrap().worktrees().unwrap()[1]
            .path
            .clone();
        std::fs::write(target.join("base"), "edit one").unwrap();
        assert_eq!(
            execute(&service, handle, &request("remove", &path))
                .unwrap_err()
                .code,
            "dirtyWorktree"
        );
        let mut remove = request("remove", &path);
        remove.force = true;
        let review = service
            .repo(handle)
            .unwrap()
            .worktree_review(&remove)
            .unwrap();
        std::fs::write(target.join("base"), "edit two").unwrap();
        assert_eq!(
            service
                .worktree_execute(handle, &remove, &review.token)
                .unwrap_err()
                .code,
            "staleOperation"
        );
        std::fs::write(target.join("untracked"), "first").unwrap();
        let review = service
            .repo(handle)
            .unwrap()
            .worktree_review(&remove)
            .unwrap();
        std::fs::write(target.join("untracked"), "other").unwrap();
        assert_eq!(
            service
                .worktree_execute(handle, &remove, &review.token)
                .unwrap_err()
                .code,
            "staleOperation"
        );
        std::fs::write(target.join(".gitignore"), "ignored\n").unwrap();
        std::fs::write(target.join("ignored"), "secret one").unwrap();
        let review = service
            .repo(handle)
            .unwrap()
            .worktree_review(&remove)
            .unwrap();
        std::fs::write(target.join("ignored"), "secret two").unwrap();
        assert_eq!(
            service
                .worktree_execute(handle, &remove, &review.token)
                .unwrap_err()
                .code,
            "staleOperation"
        );
        execute(&service, handle, &request("lock", &path)).unwrap();
        assert_eq!(
            execute(&service, handle, &remove).unwrap_err().code,
            "worktreeLocked"
        );
        execute(&service, handle, &request("unlock", &path)).unwrap();
        execute(&service, handle, &remove).unwrap();
        assert!(!target.exists());
        assert!(!git(repo.path(), &["rev-parse", "topic"]).is_empty());
    }

    #[test]
    fn worktree_prune_previews_stale_metadata_and_preserves_locked_registrations() {
        let repo = init();
        std::fs::write(repo.path().join("base"), "base").unwrap();
        commit(repo.path(), "initial");
        let data = tempfile::tempdir().unwrap();
        let folders = tempfile::tempdir().unwrap();
        let mut service = Service::new(data.path().into());
        let main = open(&mut service, repo.path());
        let handle = &main.session.handle;
        let stale = folders.path().join("stale");
        let locked = folders.path().join("locked");
        git(
            repo.path(),
            &["worktree", "add", "-b", "stale", stale.to_str().unwrap()],
        );
        git(
            repo.path(),
            &["worktree", "add", "-b", "locked", locked.to_str().unwrap()],
        );
        git(repo.path(), &["worktree", "lock", locked.to_str().unwrap()]);
        std::fs::remove_dir_all(&stale).unwrap();
        std::fs::remove_dir_all(&locked).unwrap();
        let prune = request("prune", "");
        let review = service
            .repo(handle)
            .unwrap()
            .worktree_review(&prune)
            .unwrap();
        assert!(review.preview.contains("stale"), "{}", review.preview);
        service
            .worktree_execute(handle, &prune, &review.token)
            .unwrap();
        let list = service.repo(handle).unwrap().worktrees().unwrap();
        assert_eq!(list.len(), 2);
        assert!(list.iter().any(|item| item.locked.is_some()));
        assert!(!git(repo.path(), &["rev-parse", "stale"]).is_empty());
    }

    #[test]
    fn worktree_validation_and_nul_parser_preserve_unusual_paths() {
        let parsed = parse(b"worktree /repo\nmain\0HEAD abc\0branch refs/heads/main\0\0worktree /topic\tname\0HEAD def\0detached\0locked reason\nnext\0prunable missing\0\0".to_vec()).unwrap();
        assert_eq!(parsed[0].path, "/repo\nmain");
        assert!(parsed[0].main);
        assert_eq!(parsed[1].locked.as_deref(), Some("reason\nnext"));
        assert!(parsed[1].branch.is_none());
        let repo = init();
        std::fs::write(repo.path().join("base"), "base").unwrap();
        commit(repo.path(), "initial");
        let data = tempfile::tempdir().unwrap();
        let mut service = Service::new(data.path().into());
        let main = open(&mut service, repo.path());
        let mut create = request("create", "");
        let folders = tempfile::tempdir().unwrap();
        create.destination = folders
            .path()
            .join("invalid-branch")
            .to_str()
            .unwrap()
            .into();
        create.branch = "bad..branch".into();
        assert_eq!(
            service
                .repo(&main.session.handle)
                .unwrap()
                .worktree_review(&create)
                .err()
                .unwrap()
                .code,
            "invalidRequest"
        );
        assert!(!std::path::Path::new(&create.destination).exists());
        create.branch.clear();
        create.destination = "relative".into();
        assert_eq!(
            execute(&service, &main.session.handle, &create)
                .unwrap_err()
                .code,
            "invalidPath"
        );
        assert_eq!(
            execute(
                &service,
                &main.session.handle,
                &request("remove", &main.session.root)
            )
            .unwrap_err()
            .code,
            "invalidRequest"
        );
    }

    #[test]
    fn worktree_create_rejects_a_moved_starting_ref_and_an_existing_destination() {
        let repo = init();
        std::fs::write(repo.path().join("base"), "base").unwrap();
        commit(repo.path(), "initial");
        let data = tempfile::tempdir().unwrap();
        let folders = tempfile::tempdir().unwrap();
        let mut service = Service::new(data.path().into());
        let main = open(&mut service, repo.path());
        let handle = &main.session.handle;
        let destination = folders.path().join("new");
        let mut create = request("create", "");
        create.destination = destination.to_str().unwrap().into();
        create.branch = "new".into();
        let review = service
            .repo(handle)
            .unwrap()
            .worktree_review(&create)
            .unwrap();
        std::fs::write(repo.path().join("base"), "next").unwrap();
        commit(repo.path(), "next");
        assert_eq!(
            service
                .worktree_execute(handle, &create, &review.token)
                .unwrap_err()
                .code,
            "staleOperation"
        );
        assert!(!destination.exists());
        std::fs::create_dir(&destination).unwrap();
        assert_eq!(
            execute(&service, handle, &create).unwrap_err().code,
            "destinationExists"
        );
    }

    #[test]
    fn worktree_prune_refuses_a_missing_but_open_target() {
        let repo = init();
        std::fs::write(repo.path().join("base"), "base").unwrap();
        commit(repo.path(), "initial");
        let data = tempfile::tempdir().unwrap();
        let folders = tempfile::tempdir().unwrap();
        let mut service = Service::new(data.path().into());
        let main = open(&mut service, repo.path());
        let handle = &main.session.handle;
        let target = folders.path().join("open");
        git(
            repo.path(),
            &["worktree", "add", "-b", "open", target.to_str().unwrap()],
        );
        let linked = open(&mut service, &target);
        std::fs::remove_dir_all(&target).unwrap();
        assert_eq!(
            execute(&service, handle, &request("prune", ""))
                .unwrap_err()
                .code,
            "worktreeOpen"
        );
        assert_eq!(service.repo(handle).unwrap().worktrees().unwrap().len(), 2);
        service.close(&linked.session.handle).unwrap();
        execute(&service, handle, &request("prune", "")).unwrap();
        assert_eq!(service.repo(handle).unwrap().worktrees().unwrap().len(), 1);
    }
}
