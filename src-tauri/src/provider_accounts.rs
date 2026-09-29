//! Local provider accounts. Credentials live in the OS credential store, never
//! in browser preferences or the metadata file.
use crate::dto::{Error, Result};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    path::PathBuf,
    sync::Mutex,
};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Provider {
    Github,
    Gitlab,
    AzureDevops,
    Bitbucket,
}

impl Provider {
    pub fn host(self) -> &'static str {
        match self {
            Self::Github => "github.com",
            Self::Gitlab => "gitlab.com",
            Self::AzureDevops => "dev.azure.com",
            Self::Bitbucket => "bitbucket.org",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAccount {
    pub id: String,
    pub provider: Provider,
    pub username: String,
}

pub struct AccountStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl AccountStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }

    fn read(&self) -> Result<Vec<ProviderAccount>> {
        match std::fs::File::open(&self.path) {
            Ok(mut file) => {
                let mut bytes = Vec::new();
                std::io::Read::by_ref(&mut file)
                    .take(128 * 1024 + 1)
                    .read_to_end(&mut bytes)?;
                if bytes.len() > 128 * 1024 {
                    return Err(Error::new("accountData", "Account metadata is too large"));
                }
                serde_json::from_slice(&bytes)
                    .map_err(|_| Error::new("accountData", "Invalid account metadata"))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e.into()),
        }
    }

    fn save(&self, accounts: &[ProviderAccount]) -> Result<()> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| Error::new("accountData", "Invalid account storage path"))?;
        std::fs::create_dir_all(parent)?;
        let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
        serde_json::to_writer(&mut tmp, accounts)
            .map_err(|_| Error::new("accountData", "Could not encode account metadata"))?;
        tmp.flush()?;
        tmp.as_file().sync_all()?;
        tmp.persist(&self.path).map_err(|e| Error::from(e.error))?;
        Ok(())
    }

    fn key(id: &str) -> Result<keyring::Entry> {
        keyring::Entry::new("app.gitty.desktop.provider", id).map_err(|_| {
            Error::new(
                "credentialStore",
                "The system credential store is unavailable",
            )
        })
    }

    pub fn list(&self) -> Result<Vec<ProviderAccount>> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| Error::new("worker", "Account lock poisoned"))?;
        self.read()
    }

    pub fn connect_token(
        &self,
        provider: Provider,
        username: String,
        token: String,
    ) -> Result<ProviderAccount> {
        if username.is_empty()
            || username.len() > 254
            || username.chars().any(char::is_control)
            || token.is_empty()
            || token.len() > 8192
            || token.chars().any(char::is_control)
        {
            return Err(Error::new(
                "invalidRequest",
                "Enter a valid username and access token",
            ));
        }
        crate::provider_pr::verify_token(provider, &username, &token)?;
        let _guard = self
            .lock
            .lock()
            .map_err(|_| Error::new("worker", "Account lock poisoned"))?;
        let mut accounts = self.read()?;
        if accounts
            .iter()
            .any(|account| account.provider == provider && account.username == username)
        {
            return Err(Error::new(
                "accountExists",
                "That provider account is already connected",
            ));
        }
        let account = ProviderAccount {
            id: uuid::Uuid::new_v4().to_string(),
            provider,
            username,
        };
        Self::key(&account.id)?.set_password(&token).map_err(|_| {
            Error::new(
                "credentialStore",
                "Could not save the token to the system credential store",
            )
        })?;
        accounts.push(account.clone());
        if let Err(error) = self.save(&accounts) {
            let _ = Self::key(&account.id)?.delete_credential();
            return Err(error);
        }
        Ok(account)
    }

    pub fn disconnect(&self, id: &str) -> Result<()> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| Error::new("worker", "Account lock poisoned"))?;
        let mut accounts = self.read()?;
        if !accounts.iter().any(|account| account.id == id) {
            return Err(Error::new("invalidAccount", "Account not found"));
        }
        match Self::key(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => (),
            Err(_) => {
                return Err(Error::new(
                    "credentialStore",
                    "Could not remove the stored credential",
                ))
            }
        }
        accounts.retain(|account| account.id != id);
        self.save(&accounts)
    }

    pub fn credential(&self, id: &str) -> Result<(ProviderAccount, String)> {
        let account = self
            .list()?
            .into_iter()
            .find(|account| account.id == id)
            .ok_or_else(|| Error::new("invalidAccount", "Account not found"))?;
        let token = Self::key(id)?.get_password().map_err(|_| {
            Error::new(
                "credentialStore",
                "Stored credential is missing; reconnect this account",
            )
        })?;
        Ok((account, token))
    }

    /// Ambiguous accounts are never chosen automatically. A future per-remote
    /// selection can disambiguate them without leaking a token to the wrong user.
    pub fn for_remote(&self, remote_url: &str) -> Result<Option<(ProviderAccount, String)>> {
        let Ok(url) = url::Url::parse(remote_url) else {
            return Ok(None);
        };
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
        {
            return Ok(None);
        }
        let candidates: Vec<_> = self
            .list()?
            .into_iter()
            .filter(|account| url.host_str() == Some(account.provider.host()))
            .collect();
        if candidates.len() == 1 {
            self.credential(&candidates[0].id).map(Some)
        } else {
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_is_token_free_and_unrelated_hosts_never_select_an_account() {
        let dir = tempfile::tempdir().unwrap();
        let store = AccountStore::new(dir.path().join("accounts.json"));
        store
            .save(&[ProviderAccount {
                id: "account-id".into(),
                provider: Provider::Github,
                username: "alice".into(),
            }])
            .unwrap();
        let data = std::fs::read_to_string(&store.path).unwrap();
        assert!(!data.contains("token"));
        assert_eq!(store.list().unwrap()[0].username, "alice");
        for url in [
            "https://github.com.evil.test/a/b",
            "http://github.com/a/b",
            "https://alice@github.com/a/b",
            "https://github.com:444/a/b",
        ] {
            assert!(store.for_remote(url).unwrap().is_none());
        }
    }
}
