//! File actions on one working-tree path: open it, reveal it, or ignore it.
//!
//! Every path is repository-relative and is confined to the worktree after symlinks
//! are resolved, so a link inside the repository cannot make Gitty touch a file
//! outside it. Launching is deliberately conservative: only regular, non-executable
//! files of a kind that is not itself a program, since "open" hands the file to
//! whatever the operating system associates with it.
use crate::{
    dto::*,
    mutate::validate_mutation_path,
    repository::{Repository, Service},
};
use std::{
    io::Write,
    path::{Path, PathBuf},
    process::Command,
};

/// Extensions the OS treats as programs or launchers. Not a sandbox, only a refusal
/// to start something just because it is in a cloned repository.
const LAUNCHERS: [&str; 24] = [
    "app", "bat", "cmd", "com", "command", "desktop", "dmg", "exe", "jar", "lnk", "msi", "pif",
    "pkg", "ps1", "reg", "scpt", "scr", "sh", "terminal", "vbs", "workflow", "wsf", "action",
    "appimage",
];

fn unsupported_location(repo: &Repository) -> Result<()> {
    if matches!(repo.location(), RepositoryLocation::Wsl { .. }) {
        return Err(Error::new(
            "unsupported",
            "This action is not available for repositories inside WSL.",
        ));
    }
    Ok(())
}

/// The canonical path of `path` inside `root`, or an error if it is missing or, once
/// symlinks are resolved, outside the worktree.
fn resolve_in_worktree(root: &str, path: &str) -> Result<PathBuf> {
    let relative = validate_mutation_path(path)?;
    let root = Path::new(root)
        .canonicalize()
        .map_err(|e| Error::new("io", e.to_string()))?;
    let resolved = root.join(&relative).canonicalize().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            Error::new("notFound", format!("{relative} does not exist on disk."))
        } else {
            Error::new("io", e.to_string())
        }
    })?;
    if !resolved.starts_with(&root) {
        return Err(Error::new(
            "invalidPath",
            format!("{relative} resolves to a location outside the repository."),
        ));
    }
    Ok(resolved)
}

/// Refuses anything that is not a plain document: directories, bundles, programs.
fn check_launchable(path: &Path) -> Result<()> {
    let metadata = std::fs::metadata(path).map_err(|e| Error::new("io", e.to_string()))?;
    let refuse = |why: &str| {
        Err(Error::new("openRefused", format!("Gitty will not open this file: {why}. Open it from your file manager if you are sure.")))
    };
    if !metadata.is_file() {
        return refuse("it is not a regular file");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 != 0 {
            return refuse("it is executable");
        }
    }
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    if extension.is_some_and(|e| LAUNCHERS.contains(&e.as_str())) {
        return refuse("it is a program or launcher");
    }
    Ok(())
}

/// A `.gitignore` line that matches exactly `path` from the repository root: anchored
/// with a leading slash, with every character Git would read as a pattern escaped.
fn ignore_pattern(path: &str) -> Result<String> {
    if path.contains(['\n', '\r']) {
        return Err(Error::new(
            "invalidPath",
            "A file name containing a line break cannot be written to .gitignore.",
        ));
    }
    let mut pattern = String::from("/");
    for c in path.chars() {
        if matches!(c, '\\' | '*' | '?' | '[') {
            pattern.push('\\');
        }
        pattern.push(c);
    }
    // Trailing spaces are dropped by Git unless escaped.
    if pattern.ends_with(' ') {
        pattern.insert(pattern.len() - 1, '\\');
    }
    Ok(pattern)
}

impl Service {
    pub fn open_path(&self, handle: &str, path: &str) -> Result<()> {
        let repo = self.repo(handle)?;
        unsupported_location(&repo)?;
        let resolved = resolve_in_worktree(&repo.session.root, path)?;
        check_launchable(&resolved)?;
        open::that_detached(&resolved).map_err(|e| Error::new("openExternal", e.to_string()))
    }
    pub fn reveal_path(&self, handle: &str, path: &str) -> Result<()> {
        let repo = self.repo(handle)?;
        unsupported_location(&repo)?;
        let resolved = resolve_in_worktree(&repo.session.root, path)?;
        reveal(&resolved)
    }
    pub fn ignore_path(&self, handle: &str, path: &str) -> Result<()> {
        self.mutate(handle, |repo| repo.ignore_path(path))
    }
}

#[cfg(target_os = "macos")]
fn reveal(path: &Path) -> Result<()> {
    let status = Command::new("open")
        .arg("-R")
        .arg(path)
        .status()
        .map_err(|e| Error::new("openExternal", e.to_string()))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| Error::new("openExternal", "Finder could not reveal the file."))
}
#[cfg(windows)]
fn reveal(path: &Path) -> Result<()> {
    use std::os::windows::process::CommandExt;
    // Explorer parses its own command line, and exits non-zero even on success.
    Command::new("explorer")
        .raw_arg(format!("/select,\"{}\"", path.display()))
        .spawn()
        .map(|_| ())
        .map_err(|e| Error::new("openExternal", e.to_string()))
}
#[cfg(not(any(target_os = "macos", windows)))]
fn reveal(path: &Path) -> Result<()> {
    // ponytail: no portable "select this file" on Linux, so open its folder
    let folder = path.parent().unwrap_or(path);
    open::that_detached(folder).map_err(|e| Error::new("openExternal", e.to_string()))
}

impl Repository {
    /// Appends an anchored, escaped line for one untracked file to the root
    /// `.gitignore`. Append-only, so a concurrent edit is never overwritten, and
    /// opened through a directory handle so a `.gitignore` symlink cannot lead
    /// outside the worktree. Once ignored the file is no longer untracked, so a
    /// repeated request is refused rather than adding a second line.
    pub(crate) fn ignore_path(&self, path: &str) -> Result<()> {
        unsupported_location(self)?;
        let path = validate_mutation_path(path)?;
        let tracked_or_unknown = !self
            .status_entries()?
            .entries
            .iter()
            .any(|e| e.untracked && e.path.strip_suffix('/').unwrap_or(&e.path) == path);
        if tracked_or_unknown {
            return Err(Error::new(
                "invalidRequest",
                format!("{path} is not an untracked file, so ignoring it would have no effect."),
            ));
        }
        let pattern = ignore_pattern(&path)?;
        let dir =
            cap_std::fs::Dir::open_ambient_dir(&self.session.root, cap_std::ambient_authority())?;
        let existing = match dir.read(".gitignore") {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        let mut options = cap_std::fs::OpenOptions::new();
        options.append(true).create(true);
        let mut file = dir.open_with(".gitignore", &options)?;
        let separator = if existing.is_empty() || existing.ends_with(b"\n") {
            ""
        } else {
            "\n"
        };
        file.write_all(format!("{separator}{pattern}\n").as_bytes())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignore_patterns_are_anchored_and_escape_everything_git_would_interpret() {
        assert_eq!(ignore_pattern("a/b.txt").unwrap(), "/a/b.txt");
        assert_eq!(
            ignore_pattern("star*q?[x]\\.txt").unwrap(),
            "/star\\*q\\?\\[x]\\\\.txt"
        );
        assert_eq!(ignore_pattern("#hash").unwrap(), "/#hash");
        assert_eq!(ignore_pattern("!bang").unwrap(), "/!bang");
        assert_eq!(ignore_pattern("trailing ").unwrap(), "/trailing\\ ");
        assert!(ignore_pattern("two\nlines").is_err());
    }

    #[test]
    fn only_plain_documents_are_launchable() {
        let dir = tempfile::tempdir().unwrap();
        for (name, ok) in [
            ("notes.md", true),
            ("photo.PNG", true),
            ("run.sh", false),
            ("setup.EXE", false),
            ("Tool.app", false),
            ("trap.command", false),
        ] {
            let path = dir.path().join(name);
            std::fs::write(&path, "x").unwrap();
            assert_eq!(check_launchable(&path).is_ok(), ok, "{name}");
        }
        assert!(check_launchable(dir.path()).is_err(), "a directory");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.path().join("plain-name");
            std::fs::write(&path, "x").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert!(check_launchable(&path).is_err(), "an executable");
        }
    }

    #[test]
    fn paths_stay_inside_the_worktree_even_through_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("inside.txt"), "x").unwrap();
        std::fs::write(outside.path().join("secret.txt"), "x").unwrap();
        let root_path = root.path().to_str().unwrap();
        assert!(resolve_in_worktree(root_path, "inside.txt").is_ok());
        assert_eq!(
            resolve_in_worktree(root_path, "missing.txt")
                .unwrap_err()
                .code,
            "notFound"
        );
        for rejected in ["../x", "/etc/passwd", "a/../inside.txt"] {
            assert_eq!(
                resolve_in_worktree(root_path, rejected).unwrap_err().code,
                "invalidPath",
                "{rejected}"
            );
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), root.path().join("link")).unwrap();
            std::os::unix::fs::symlink(
                outside.path().join("secret.txt"),
                root.path().join("file-link"),
            )
            .unwrap();
            for escaped in ["link/secret.txt", "file-link"] {
                assert_eq!(
                    resolve_in_worktree(root_path, escaped).unwrap_err().code,
                    "invalidPath",
                    "{escaped}"
                );
            }
        }
    }
}
