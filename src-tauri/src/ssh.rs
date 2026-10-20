//! Connection test for SSH repository locations.
//!
//! Nothing here opens a session or reads a repository's contents beyond its
//! top-level directory name. The point is to tell the user *why* a destination does
//! not work before a tab exists: an untrusted host key, an authentication failure, a
//! sleeping host or a missing Git are all different problems with different fixes,
//! and SSH reports them in one lump of stderr.
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
        "connectFailed" => " Check that the host is awake and reachable (for example over Tailscale).",
        "notARepository" => " That path is missing or is not a Git repository.",
        _ => "",
    };
    Error::new(code, format!("{text}{hint}"))
}
