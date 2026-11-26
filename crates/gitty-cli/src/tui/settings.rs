use super::keys::{KeyConfig, Keymap};
use super::theme;
use gitty_core::dto::CommitIdentity;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{self, Write},
    path::{Path, PathBuf},
};

pub(super) const MAX_PROFILES: usize = 20;

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Profile {
    pub id: usize,
    pub label: String,
    pub name: String,
    pub email: String,
}

impl Profile {
    pub fn identity(&self) -> CommitIdentity {
        CommitIdentity {
            name: self.name.clone(),
            email: self.email.clone(),
        }
    }

    pub fn valid_label(&self) -> bool {
        !self.label.trim().is_empty()
            && self.label.len() <= 80
            && !self.label.chars().any(char::is_control)
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub(super) struct Settings {
    pub keys: KeyConfig,
    theme: String,
    pub recent: Vec<String>,
    pub profiles: Vec<Profile>,
    pub assignments: BTreeMap<String, usize>,
}

impl Settings {
    pub fn theme(&self) -> usize {
        theme::themes()
            .iter()
            .position(|t| t.id == self.theme)
            .unwrap_or(0)
    }

    pub fn set_theme(&mut self, index: usize) {
        self.theme = theme::themes()[index].id.into();
    }

    pub fn profile(&self, root: &str) -> Option<&Profile> {
        let id = self.assignments.get(root)?;
        self.profiles.iter().find(|p| &p.id == id)
    }

    pub fn remember(&mut self, root: &str) -> bool {
        if self.recent.first().is_some_and(|path| path == root) {
            return false;
        }
        self.recent.retain(|path| path != root);
        self.recent.insert(0, root.into());
        self.recent.truncate(20);
        true
    }

    pub fn load(path: &Path) -> io::Result<Self> {
        let mut config: Self = match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => Self::default(),
            Err(e) => return Err(e),
        };
        config
            .profiles
            .retain(|p| p.valid_label() && p.identity().validate().is_ok());
        let mut ids = std::collections::HashSet::new();
        config.profiles.retain(|p| p.id != 0 && ids.insert(p.id));
        config.profiles.truncate(MAX_PROFILES);
        config
            .assignments
            .retain(|_, id| config.profiles.iter().any(|p| p.id == *id));
        config.recent.truncate(20);
        Keymap::new(&config.keys).map_err(io::Error::other)?;
        Ok(config)
    }

    pub fn save(&self, path: Option<&Path>) -> io::Result<()> {
        let path = path.ok_or_else(|| io::Error::other("no configuration directory"))?;
        let dir = path
            .parent()
            .ok_or_else(|| io::Error::other("invalid settings path"))?;
        std::fs::create_dir_all(dir)?;
        let mut file = tempfile::NamedTempFile::new_in(dir)?;
        file.write_all(&serde_json::to_vec_pretty(self)?)?;
        file.persist(path).map_err(|e| e.error)?;
        Ok(())
    }
}

pub(super) fn config_path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .filter(|v| !v.is_empty())
                .map(|home| PathBuf::from(home).join(".config"))
        })
        .or_else(|| {
            std::env::var_os("APPDATA")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        })?;
    Some(base.join("gitty").join("tui.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_settings_round_trip_and_invalid_settings_are_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tui.json");
        for keys in [r#""vim""#, r#"{"stage":"x","commit":"Ctrl-s"}"#] {
            std::fs::write(&path, format!(r#"{{"keys":{keys}}}"#)).unwrap();
            let config = Settings::load(&path).unwrap();
            config.save(Some(&path)).unwrap();
            let loaded = Settings::load(&path).unwrap();
            assert_eq!(
                serde_json::to_value(config.keys).unwrap(),
                serde_json::to_value(loaded.keys).unwrap()
            );
        }
        for text in [
            r#"{"keys":{"stage":"Enter"}}"#,
            r#"{"keys":false}"#,
            "{broken",
        ] {
            std::fs::write(&path, text).unwrap();
            assert!(Settings::load(&path).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
        }
    }

    #[test]
    fn theme_only_config_upgrades_and_profiles_round_trip_by_worktree_root() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tui.json");
        std::fs::write(&path, format!(r#"{{"theme":"{}"}}"#, theme::themes()[5].id)).unwrap();
        let mut config = Settings::load(&path).unwrap();
        assert_eq!(config.theme(), 5);
        for (id, label) in [(1, "Work"), (2, "Personal")] {
            config.profiles.push(Profile {
                id,
                label: label.into(),
                name: label.into(),
                email: format!("{label}@example.invalid"),
            });
            config.assignments.insert(format!("/repo-{id}"), id);
        }
        config.remember("/repo-1");
        config.remember("/repo-2");
        config.set_theme(0);
        config.save(Some(&path)).unwrap();
        let config = Settings::load(&path).unwrap();
        assert_eq!(config.theme(), 0);
        assert_eq!(config.profile("/repo-1").unwrap().label, "Work");
        assert_eq!(config.profile("/repo-2").unwrap().label, "Personal");
        assert!(config.profile("/repo-3").is_none());
        assert_eq!(config.recent, ["/repo-2", "/repo-1"]);
    }
}
