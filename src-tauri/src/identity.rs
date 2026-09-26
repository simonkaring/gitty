use crate::{
    dto::*,
    mutate::validate_identity,
    process::{self, args},
    repository::{Repository, Service},
};
use std::time::Duration;

fn config_value(repo: &Repository, local: bool, key: &str) -> Result<Option<String>> {
    let mut command = vec!["config", "--null"];
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
    let value = output
        .stdout
        .strip_suffix(&[0])
        .ok_or_else(|| Error::new("gitParse", "Malformed Git config value"))?;
    Ok(Some(process::text(value.to_vec())?))
}

impl Repository {
    pub fn git_identity(&self) -> Result<RepositoryGitIdentity> {
        let local = GitIdentityValues {
            name: config_value(self, true, "user.name")?,
            email: config_value(self, true, "user.email")?,
        };
        let effective = GitIdentityValues {
            name: config_value(self, false, "user.name")?,
            email: config_value(self, false, "user.email")?,
        };
        Ok(RepositoryGitIdentity { local, effective })
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
