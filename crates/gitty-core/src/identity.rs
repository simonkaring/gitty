use crate::{
    dto::*,
    mutate::validate_identity,
    process::{self, args},
    repository::{Repository, Service},
};
use std::time::Duration;

struct ConfigEntry {
    value: String,
    scope: Vec<u8>,
    origin: Vec<u8>,
}

fn config_entry(repo: &Repository, local: bool, key: &str) -> Result<Option<ConfigEntry>> {
    let mut command = vec!["config", "--null", "--show-scope", "--show-origin"];
    if local {
        command.extend(["--local", "--no-includes"]);
    }
    command.extend(["--get", key]);
    let output = process::git(&repo.session.location, &args(&command))?;
    if !output.success {
        if output.code == Some(1) && output.stderr.is_empty() {
            return Ok(None);
        }
        return Err(Error::new(
            "git",
            String::from_utf8_lossy(&output.stderr).trim(),
        ));
    }
    let entry = output
        .stdout
        .strip_suffix(&[0])
        .ok_or_else(|| Error::new("gitParse", "Malformed Git config value"))?;
    let mut fields = entry.split(|byte| *byte == 0);
    match (fields.next(), fields.next(), fields.next(), fields.next()) {
        (Some(scope), Some(origin), Some(value), None) => Ok(Some(ConfigEntry {
            scope: scope.to_vec(),
            origin: origin.to_vec(),
            value: process::text(value.to_vec())?,
        })),
        _ => Err(Error::new("gitParse", "Malformed Git config entry")),
    }
}

fn effective_source(entry: &ConfigEntry, local: Option<&ConfigEntry>) -> GitIdentitySource {
    use GitIdentitySource::*;
    match entry.scope.as_slice() {
        b"local" if local.is_some_and(|local| local.origin == entry.origin) => Repository,
        b"local" => RepositoryInclude,
        b"worktree" => Worktree,
        b"global" => Global,
        b"system" => System,
        b"command" => Command,
        _ => Other,
    }
}

impl Repository {
    pub fn git_identity(&self) -> Result<RepositoryGitIdentity> {
        let local_name = config_entry(self, true, "user.name")?;
        let local_email = config_entry(self, true, "user.email")?;
        let name = config_entry(self, false, "user.name")?;
        let email = config_entry(self, false, "user.email")?;
        Ok(RepositoryGitIdentity {
            effective_sources: GitIdentitySources {
                name: name
                    .as_ref()
                    .map(|entry| effective_source(entry, local_name.as_ref())),
                email: email
                    .as_ref()
                    .map(|entry| effective_source(entry, local_email.as_ref())),
            },
            local: GitIdentityValues {
                name: local_name.map(|entry| entry.value),
                email: local_email.map(|entry| entry.value),
            },
            effective: GitIdentityValues {
                name: name.map(|entry| entry.value),
                email: email.map(|entry| entry.value),
            },
        })
    }

    fn set_git_identity(
        &self,
        identity: &CommitIdentity,
        expected_local: &GitIdentityValues,
    ) -> Result<RepositoryGitIdentity> {
        validate_identity(Some(identity))?;
        if &self.git_identity()?.local != expected_local {
            return Err(Error::new(
                "staleOperation",
                "Repository Git identity changed. Refresh it before applying a profile.",
            ));
        }
        for (key, value) in [
            ("user.name", identity.name.as_str()),
            ("user.email", identity.email.as_str()),
        ] {
            let command = process::git_mutation_command(
                &self.session.location,
                &args(&["config", "--local", "--replace-all", "--", key, value]),
            )?;
            let output = process::run_with_input_for(command, &[], Duration::from_secs(30), 0)?;
            if !output.success {
                return Err(Error::new("git", format!("Could not set {key}: {}. Refresh the repository identity before retrying; the other field may have changed.", String::from_utf8_lossy(&output.stderr).trim())));
            }
        }
        self.git_identity()
    }
}

impl Service {
    pub fn set_git_identity(
        &self,
        handle: &str,
        identity: &CommitIdentity,
        expected_local: &GitIdentityValues,
    ) -> Result<RepositoryGitIdentity> {
        self.mutate(handle, |repo| {
            repo.set_git_identity(identity, expected_local)
        })
    }
}
