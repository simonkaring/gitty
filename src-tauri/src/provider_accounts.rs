//! Local provider accounts. Credentials live in the OS credential store, never
//! in browser preferences or the metadata file.
use crate::dto::{Error, Result};
use serde::{Deserialize, Serialize};
use std::{io::Read, path::PathBuf, sync::Mutex};

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
    #[serde(default)]
    pub oauth: bool,
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
        let bytes = serde_json::to_vec(accounts)
            .map_err(|_| Error::new("accountData", "Could not encode account metadata"))?;
        crate::repository::write_atomic(&self.path, &bytes)
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
        self.connect(provider, username, token, false)
    }

    pub fn connect_oauth(
        &self,
        provider: Provider,
        username: String,
        tokens: &crate::provider_oauth::Tokens,
    ) -> Result<ProviderAccount> {
        if username.is_empty() || username.len() > 254 || username.chars().any(char::is_control) {
            return Err(Error::new(
                "invalidAccount",
                "The provider returned an invalid account name",
            ));
        }
        let secret = serde_json::to_string(tokens)
            .map_err(|_| Error::new("oauth", "Could not encode sign-in credentials"))?;
        self.connect(provider, username, secret, true)
    }

    fn connect(
        &self,
        provider: Provider,
        username: String,
        token: String,
        oauth: bool,
    ) -> Result<ProviderAccount> {
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
            oauth,
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
        // Remove the account before its token: if the metadata write fails, the
        // pair must stay intact. Deleting the token first would leave a listed
        // account that nothing can authenticate, and `connect` refuses to replace
        // an existing provider account, so it could not be reconnected.
        accounts.retain(|account| account.id != id);
        self.save(&accounts)?;
        match Self::key(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(Error::new(
                "credentialStore",
                "The account was disconnected, but its saved token could not be removed from the system credential store.",
            )),
        }
    }

    pub fn credential(&self, id: &str) -> Result<(ProviderAccount, String)> {
        // Only the local reads and writes hold the lock. A token refresh can take
        // as long as the provider's HTTP timeout and must not block calls for
        // other accounts (listing, connecting, another account's request).
        let (account, token) = {
            let _guard = self
                .lock
                .lock()
                .map_err(|_| Error::new("worker", "Account lock poisoned"))?;
            let account = self
                .read()?
                .into_iter()
                .find(|account| account.id == id)
                .ok_or_else(|| Error::new("invalidAccount", "Account not found"))?;
            let token = Self::key(id)?.get_password().map_err(|_| {
                Error::new(
                    "credentialStore",
                    "Stored credential is missing; reconnect this account",
                )
            })?;
            (account, token)
        };
        if !account.oauth {
            return Ok((account, token));
        }
        let (access, updated) = crate::provider_oauth::access_token(account.provider, &token)?;
        if let Some(updated) = updated {
            let _guard = self
                .lock
                .lock()
                .map_err(|_| Error::new("worker", "Account lock poisoned"))?;
            // A disconnect may have run while the refresh was in flight; never
            // write a token back for an account that is no longer listed.
            if self.read()?.iter().any(|account| account.id == id) {
                Self::key(id)?.set_password(&updated).map_err(|_| {
                    Error::new(
                        "credentialStore",
                        "Could not save refreshed sign-in; reconnect this account",
                    )
                })?;
            }
        }
        Ok((account, access))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_is_token_free_and_legacy_accounts_remain_readable() {
        let dir = tempfile::tempdir().unwrap();
        let store = AccountStore::new(dir.path().join("accounts.json"));
        store
            .save(&[ProviderAccount {
                id: "account-id".into(),
                provider: Provider::Github,
                username: "alice".into(),
                oauth: false,
            }])
            .unwrap();
        let data = std::fs::read_to_string(&store.path).unwrap();
        assert!(!data.contains("token"));
        assert_eq!(store.list().unwrap()[0].username, "alice");
        let legacy: ProviderAccount = serde_json::from_value(
            serde_json::json!({"id":"old", "provider":"github", "username":"alice"}),
        )
        .unwrap();
        assert!(!legacy.oauth);
    }
}
