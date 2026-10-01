//! App-local Git helper fallback; never modifies the user's Git configuration.
use crate::{
    dto::{RepositoryLocation, Result},
    process,
};
use std::{path::PathBuf, sync::OnceLock};

static BUNDLED: OnceLock<PathBuf> = OnceLock::new();

pub fn init(resource_dir: PathBuf) {
    let name = if cfg!(windows) {
        "git-credential-manager.exe"
    } else {
        "git-credential-manager"
    };
    let packaged = resource_dir.join("gcm").join(name);
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources/gcm")
        .join(name);
    let path = if packaged.is_file() {
        packaged
    } else {
        development
    };
    if path.is_file() {
        let _ = BUNDLED.set(path);
    }
}

fn helper_value(path: &std::path::Path) -> String {
    // Git parses credential.helper as a command. Escape its absolute path, including spaces.
    let path = path.to_string_lossy();
    #[cfg(windows)]
    let path = path.replace('\\', "/");
    path.chars()
        .flat_map(|c| {
            if c.is_ascii_alphanumeric() || "/:._-".contains(c) {
                vec![c]
            } else {
                vec!['\\', c]
            }
        })
        .collect()
}

pub fn configure(args: &mut Vec<String>, location: &RepositoryLocation, url: &str) -> Result<()> {
    if !matches!(location, RepositoryLocation::Native { .. }) || !url.starts_with("https://") {
        return Ok(());
    }
    let Some(path) = BUNDLED.get() else {
        return Ok(());
    };
    let command = process::git_external_mutation_command(
        location,
        &process::args(&[
            "-C",
            match location {
                RepositoryLocation::Native { path } => path,
                _ => unreachable!(),
            },
            "config",
            "--get-urlmatch",
            "credential.helper",
            url,
        ]),
    )?;
    let configured = process::run(command)?;
    if !configured.success && configured.code != Some(1) {
        return Err(crate::dto::Error::new(
            "gitConfig",
            "Could not read Git credential helper configuration",
        ));
    }
    let helpers = String::from_utf8_lossy(&configured.stdout);
    // Existing helpers get first refusal. An explicit empty setting disables our fallback too.
    if !configured.success
        || (!helpers.trim().is_empty()
            && !helpers.lines().any(|helper| {
                matches!(helper.trim(), "manager" | "manager-core")
                    || helper.contains("git-credential-manager")
            }))
    {
        args.extend([
            "-c".into(),
            format!("credential.helper={}", helper_value(path)),
        ]);
        #[cfg(target_os = "linux")]
        {
            let store = process::run(process::git_external_mutation_command(
                location,
                &process::args(&[
                    "-C",
                    match location {
                        RepositoryLocation::Native { path } => path,
                        _ => unreachable!(),
                    },
                    "config",
                    "--get",
                    "credential.credentialStore",
                ]),
            )?)?;
            if !store.success && store.code == Some(1) {
                args.extend(process::args(&[
                    "-c",
                    "credential.credentialStore=secretservice",
                ]));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn helper_paths_escape_git_command_metacharacters() {
        assert_eq!(
            super::helper_value(std::path::Path::new("/Applications/Gitty App/a'b$helper")),
            "/Applications/Gitty\\ App/a\\'b\\$helper"
        );
        #[cfg(windows)]
        assert_eq!(
            super::helper_value(std::path::Path::new(
                "C:\\Program Files\\Gitty\\git-credential-manager.exe"
            )),
            "C:/Program\\ Files/Gitty/git-credential-manager.exe"
        );
    }

    #[cfg(unix)]
    #[test]
    fn git_can_execute_the_escaped_helper_path() {
        use std::{
            io::Write,
            os::unix::fs::PermissionsExt,
            process::{Command, Stdio},
        };
        let dir = tempfile::tempdir().unwrap();
        let helper = dir.path().join("helper with 'quotes' and $signs");
        std::fs::write(
            &helper,
            "#!/bin/sh\nprintf 'username=test-user\\npassword=test-token\\n'\n",
        )
        .unwrap();
        std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut child = Command::new("git")
            .current_dir(dir.path())
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env_remove("GIT_CONFIG_COUNT")
            .args([
                "-c",
                "credential.helper=",
                "-c",
                &format!("credential.helper={}", super::helper_value(&helper)),
                "credential",
                "fill",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"protocol=https\nhost=example.test\n\n")
            .unwrap();
        let result = child.wait_with_output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(String::from_utf8_lossy(&result.stdout).contains("password=test-token"));
    }
}
