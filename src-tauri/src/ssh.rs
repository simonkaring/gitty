//! Connection test and directory browsing for SSH repository locations.
//!
//! Nothing here opens a session or reads a repository's contents beyond its
//! top-level directory name and the immediate subdirectories the user browses. The
//! point is to tell the user *why* a destination does not work before a tab exists:
//! an untrusted host key, an authentication failure, a sleeping host or a missing Git
//! are all different problems with different fixes, and SSH reports them in one lump
//! of stderr.
use crate::{
    dto::*,
    process::{self, args},
};

/// Runs `ssh` with the same fixed policy as every other repository command, so a
/// successful test means the session will actually be able to run Git.
pub fn test(target: SshTarget) -> Result<SshProbe> {
    validate_ssh_destination(&target.host, target.user.as_deref(), target.port)?;
    if let Some(path) = &target.path {
        validate_ssh_path(path)?;
    }
    // The probe does not run in a repository context, so this path is unused; it
    // still has to be a valid value because the location type requires one.
    let probe = RepositoryLocation::Ssh {
        host: target.host.clone(),
        port: target.port,
        user: target.user.clone(),
        path: "/".into(),
    };
    let output = process::run_for(process::git_probe_command(&probe)?, process::CHECK_TIMEOUT)?;
    if !output.success {
        return Err(failure(&output));
    }
    let git_version = process::text(output.stdout)?.trim().to_string();
    if !git_version.starts_with("git version") {
        return Err(Error::new(
            "gitMissing",
            "The remote shell ran but did not start Git. Install Git on that host and check its PATH.",
        ));
    }
    let name = match &target.path {
        None => None,
        Some(path) => {
            let location = RepositoryLocation::Ssh {
                host: target.host,
                port: target.port,
                user: target.user,
                path: path.clone(),
            };
            let output = process::run_for(
                process::git_command(&location, &args(&["rev-parse", "--show-toplevel"]))?,
                process::CHECK_TIMEOUT,
            )?;
            if !output.success {
                return Err(failure(&output));
            }
            let root = process::text(output.stdout)?
                .trim_end_matches('\n')
                .to_string();
            validate_ssh_path(&root)?;
            Some(root.rsplit('/').next().unwrap_or(&root).to_string())
        }
    };
    Ok(SshProbe { git_version, name })
}

/// Lists the immediate subdirectories of one remote directory, so the connect form
/// can browse instead of demanding an exact path. One `find` per call: no `test` per
/// entry, and no `python3` dependency for a read-only listing.
pub fn directories(target: SshTarget) -> Result<Vec<DirectoryEntry>> {
    validate_ssh_destination(&target.host, target.user.as_deref(), target.port)?;
    let Some(path) = target.path.as_deref() else {
        return Err(Error::new(
            "invalidPath",
            "A directory to list is required.",
        ));
    };
    validate_ssh_path(path)?;
    let location = RepositoryLocation::Ssh {
        host: target.host,
        port: target.port,
        user: target.user,
        path: path.to_string(),
    };
    let command = process::ssh_exec(
        &location,
        &[],
        &args(&[
            "find",
            path,
            "-mindepth",
            "1",
            "-maxdepth",
            "1",
            "-type",
            "d",
            "-print0",
        ]),
    )?;
    let output = process::run_for(command, process::CHECK_TIMEOUT)?;
    if !output.success {
        return Err(listing_failure(&output));
    }
    let mut entries: Vec<DirectoryEntry> = process::text(output.stdout)?
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .map(|entry| DirectoryEntry {
            name: entry.rsplit('/').next().unwrap_or(entry).to_string(),
            path: entry.to_string(),
        })
        .collect();
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

/// A `find` failure is not a Git failure: an unreadable or missing directory gets
/// its own code, while a dead connection keeps the transport classification.
fn listing_failure(output: &process::Output) -> Error {
    if output.code == Some(255) || output.code.is_none() {
        return failure(output);
    }
    let text = crate::mutate::report(output);
    let lower = text.to_ascii_lowercase();
    let (code, hint) = if lower.contains("no such file or directory") {
        (
            "notFound",
            " Check the path; browsing starts at an absolute directory such as /home/you.",
        )
    } else if lower.contains("permission denied") {
        (
            "permissionDenied",
            " Choose a directory this SSH user can read.",
        )
    } else {
        ("listFailed", "")
    };
    Error::new(code, format!("{text}{hint}"))
}

/// Maps `ssh`'s and Git's most common refusals onto codes the connect form can
/// explain. The message keeps the original text: it names the host, key and user.
fn failure(output: &process::Output) -> Error {
    let text = crate::mutate::report(output);
    let lower = text.to_ascii_lowercase();
    let code = if lower.contains("host key verification failed") {
        "hostKeyUnknown"
    } else if lower.contains("permission denied")
        || lower.contains("no more authentication methods")
        || lower.contains("too many authentication failures")
    {
        "authRequired"
    } else if lower.contains("could not resolve hostname") {
        "hostUnknown"
    } else if lower.contains("connection refused")
        || lower.contains("connection timed out")
        || lower.contains("network is unreachable")
        || lower.contains("operation timed out")
    {
        "connectFailed"
    } else if lower.contains("is not recognized as an internal or external command")
        || lower.contains("is not recognized as the name of a cmdlet")
    {
        // Windows OpenSSH runs commands through cmd.exe or PowerShell: `env`,
        // `sh` and `find` do not exist, and quoting semantics differ.
        "posixShellRequired"
    } else if lower.contains("not a git repository") || lower.contains("cannot change to") {
        "notARepository"
    } else if output.code == Some(127)
        || lower.contains("command not found")
        || lower.contains("git: not found")
    {
        "gitMissing"
    } else if output.code == Some(255) {
        "ssh"
    } else {
        "git"
    };
    let hint = match code {
        "hostKeyUnknown" => {
            " Connect once from a terminal so its host key is trusted; Gitty never accepts a key on your behalf."
        }
        "authRequired" => {
            " Set up key-based authentication (or `~/.ssh/config`) for this host; Gitty cannot answer a password prompt."
        }
        "connectFailed" => {
            " Check that the host is awake, reachable (for example over Tailscale), and running an SSH server on that port."
        }
        "posixShellRequired" => {
            " This host does not provide a POSIX shell, so Gitty cannot run Git or list folders there. Windows OpenSSH is not supported: run an SSH server inside WSL, or use a Linux or macOS host."
        }
        "notARepository" => " That path is missing or is not a Git repository.",
        _ => "",
    };
    Error::new(code, format!("{text}{hint}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failure_for(stderr: &str, code: Option<i32>) -> Error {
        failure(&process::Output {
            stdout: vec![],
            stderr: stderr.as_bytes().to_vec(),
            success: false,
            code,
        })
    }

    #[test]
    fn unreachable_hosts_and_windows_shells_get_actionable_codes() {
        let timeout = failure_for(
            "ssh: connect to host 100.116.112.87 port 22: Operation timed out",
            Some(255),
        );
        assert_eq!(timeout.code, "connectFailed");
        assert!(timeout.message.contains("SSH server on that port"));

        // Windows OpenSSH's cmd.exe cannot run `env`, `sh` or `find`.
        let cmd = failure_for(
            "'env' is not recognized as an internal or external command,\r\noperable program or batch file.",
            Some(1),
        );
        assert_eq!(cmd.code, "posixShellRequired");
        assert!(cmd.message.contains("WSL"));
        assert_eq!(
            failure_for(
                "The term 'env' is not recognized as the name of a cmdlet, function, script file, or operable program.",
                Some(1)
            )
            .code,
            "posixShellRequired"
        );

        assert_eq!(
            failure_for("Host key verification failed.", Some(255)).code,
            "hostKeyUnknown"
        );
        assert_eq!(
            failure_for("git@host: Permission denied (publickey).", Some(255)).code,
            "authRequired"
        );
        assert_eq!(
            failure_for(
                "fatal: not a git repository (or any of the parent directories): .git",
                Some(128)
            )
            .code,
            "notARepository"
        );
        assert_eq!(
            failure_for("sh: 1: git: not found", Some(127)).code,
            "gitMissing"
        );
    }
}
