//! Public-client device authorization. Device codes and tokens never cross IPC.
use crate::{
    dto::{Error, Result},
    provider_accounts::{AccountStore, Provider, ProviderAccount},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    io::Read,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAuthorization {
    pub id: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
    pub expires_in: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PollResult {
    pub account: Option<ProviderAccount>,
    pub interval: u64,
}

struct Session {
    id: String,
    provider: Provider,
    device_code: String,
    expires: Instant,
    next_poll: Instant,
    interval: u64,
}

#[derive(Default)]
pub struct OAuth(Mutex<Option<Session>>);

#[derive(Serialize, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<u64>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn config(provider: Provider) -> Result<(&'static str, &'static str, &'static str, &'static str)> {
    let (id, device, token, scope) = match provider {
        Provider::Github => (
            Some("Ov23licwx24t0lMRQL4N"),
            "https://github.com/login/device/code",
            "https://github.com/login/oauth/access_token",
            "repo read:user",
        ),
        Provider::Gitlab => (
            option_env!("GITTY_GITLAB_CLIENT_ID"),
            "https://gitlab.com/oauth/authorize_device",
            "https://gitlab.com/oauth/token",
            "api read_user write_repository",
        ),
        Provider::AzureDevops => (
            Some("e73da836-df04-46ba-8f74-46542a39267c"),
            "https://login.microsoftonline.com/organizations/oauth2/v2.0/devicecode",
            "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
            "499b84ac-1321-427f-aa17-267ca6975798/.default offline_access",
        ),
        Provider::Bitbucket => {
            return Err(Error::new(
                "oauthUnavailable",
                "Bitbucket connections currently require an API token",
            ))
        }
    };
    let id = id.filter(|id| !id.trim().is_empty()).ok_or_else(|| Error::new("oauthUnavailable", "Browser sign-in is not configured in this build. The publisher must supply this provider's app-registration client ID; use an access token meanwhile. Git operations can still sign in through Git Credential Manager."))?;
    Ok((id, device, token, scope))
}

fn client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Gitty/0.1")
        .build()
        .map_err(|_| Error::new("oauth", "Could not start sign-in"))
}

fn json(response: reqwest::blocking::Response) -> Result<Value> {
    let mut bytes = Vec::new();
    response.take(128 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 128 * 1024 {
        return Err(Error::new("oauth", "Sign-in response is too large"));
    }
    serde_json::from_slice(&bytes).map_err(|_| Error::new("oauth", "Invalid sign-in response"))
}

fn post(url: &str, form: &[(&str, &str)]) -> Result<Value> {
    json(
        client()?
            .post(url)
            .header("Accept", "application/json")
            .form(form)
            .send()
            .map_err(|_| {
                Error::new(
                    "oauth",
                    "Could not reach the provider. Check your connection and retry.",
                )
            })?,
    )
}

fn text<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    value[field]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 8192 && !s.chars().any(char::is_control))
        .ok_or_else(|| {
            Error::new(
                "oauth",
                "The provider returned an incomplete sign-in response",
            )
        })
}

fn tokens(value: &Value) -> Result<Tokens> {
    Ok(Tokens {
        access_token: text(value, "access_token")?.into(),
        refresh_token: if value.get("refresh_token").is_some_and(|v| !v.is_null()) {
            Some(text(value, "refresh_token")?.into())
        } else {
            None
        },
        expires_at: value["expires_in"]
            .as_u64()
            .map(|seconds| now().saturating_add(seconds)),
    })
}

fn username(provider: Provider, token: &str) -> Result<String> {
    let (url, field) = match provider {
        Provider::Github => ("https://api.github.com/user", "login"),
        Provider::Gitlab => ("https://gitlab.com/api/v4/user", "username"),
        Provider::AzureDevops => (
            "https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1",
            "emailAddress",
        ),
        Provider::Bitbucket => unreachable!(),
    };
    let response = client()?
        .get(url)
        .bearer_auth(token)
        .send()
        .map_err(|_| Error::new("oauth", "Could not verify the connected account"))?;
    if !response.status().is_success() {
        return Err(Error::new(
            "oauth",
            "Sign-in succeeded but account access was denied. Check provider permissions.",
        ));
    }
    Ok(text(&json(response)?, field)?.into())
}

fn verification_uri(provider: Provider, uri: &str) -> Result<String> {
    let url = url::Url::parse(uri).map_err(|_| Error::new("oauth", "Invalid sign-in URL"))?;
    let allowed = match provider {
        Provider::Github => url.host_str() == Some("github.com"),
        Provider::Gitlab => url.host_str() == Some("gitlab.com"),
        Provider::AzureDevops => matches!(
            url.host_str(),
            Some("microsoft.com" | "www.microsoft.com" | "login.microsoftonline.com")
        ),
        Provider::Bitbucket => false,
    };
    if !allowed
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err(Error::new(
            "oauth",
            "The provider returned an unexpected sign-in URL",
        ));
    }
    Ok(url.into())
}

impl OAuth {
    pub fn start(&self, provider: Provider) -> Result<DeviceAuthorization> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| Error::new("oauth", "Sign-in lock poisoned"))?;
        let (id, device, _, scope) = config(provider)?;
        let value = post(device, &[("client_id", id), ("scope", scope)])?;
        if value.get("error").is_some() {
            return Err(Error::new("oauth", "The provider rejected sign-in. Check the app registration and device-flow permissions."));
        }
        let interval = value["interval"].as_u64().unwrap_or(5).clamp(1, 60);
        let expires_in = value["expires_in"].as_u64().unwrap_or(300).clamp(1, 1800);
        let uri = value["verification_uri"]
            .as_str()
            .or_else(|| value["verification_url"].as_str())
            .ok_or_else(|| Error::new("oauth", "Missing sign-in URL"))?;
        let authorization = DeviceAuthorization {
            id: uuid::Uuid::new_v4().to_string(),
            user_code: text(&value, "user_code")?.into(),
            verification_uri: verification_uri(provider, uri)?,
            interval,
            expires_in,
        };
        *state = Some(Session {
            id: authorization.id.clone(),
            provider,
            device_code: text(&value, "device_code")?.into(),
            expires: Instant::now() + Duration::from_secs(expires_in),
            next_poll: Instant::now() + Duration::from_secs(interval),
            interval,
        });
        Ok(authorization)
    }

    pub fn cancel(&self, id: &str) -> Result<()> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| Error::new("oauth", "Sign-in lock poisoned"))?;
        if state.as_ref().is_some_and(|s| s.id == id) {
            *state = None;
        }
        Ok(())
    }

    pub fn poll(&self, accounts: &AccountStore, id: &str) -> Result<PollResult> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| Error::new("oauth", "Sign-in lock poisoned"))?;
        let session = state
            .as_mut()
            .filter(|s| s.id == id)
            .ok_or_else(|| Error::new("oauth", "Sign-in was cancelled; start again"))?;
        if Instant::now() >= session.expires {
            *state = None;
            return Err(Error::new("oauth", "Sign-in expired; start again"));
        }
        if Instant::now() < session.next_poll {
            return Ok(PollResult {
                account: None,
                interval: session.interval,
            });
        }
        let provider = session.provider;
        let device_code = session.device_code.clone();
        session.next_poll = Instant::now() + Duration::from_secs(session.interval + 20);
        drop(state);
        let (client_id, _, endpoint, _) = config(provider)?;
        let value = post(
            endpoint,
            &[
                ("client_id", client_id),
                ("device_code", &device_code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ],
        )?;
        let verified = if value.get("error").is_none() {
            let secret = tokens(&value)?;
            Some((username(provider, &secret.access_token)?, secret))
        } else {
            None
        };
        let mut state = self
            .0
            .lock()
            .map_err(|_| Error::new("oauth", "Sign-in lock poisoned"))?;
        // Cancellation during either HTTP request discards the returned credentials.
        let session = state
            .as_mut()
            .filter(|s| s.id == id)
            .ok_or_else(|| Error::new("oauth", "Sign-in was cancelled; start again"))?;
        if Instant::now() >= session.expires {
            *state = None;
            return Err(Error::new("oauth", "Sign-in expired; start again"));
        }
        match value["error"].as_str() {
            Some("authorization_pending") => {}
            Some("slow_down") => session.interval = session.interval.saturating_add(5),
            Some(_) => {
                *state = None;
                return Err(Error::new(
                    "oauth",
                    "Sign-in was denied or expired; start again",
                ));
            }
            None => {
                // Consume the device grant before saving: a completed grant must not be reused.
                *state = None;
                let (username, secret) =
                    verified.ok_or_else(|| Error::new("oauth", "Missing sign-in credentials"))?;
                let account = accounts.connect_oauth(provider, username, &secret)?;
                return Ok(PollResult {
                    account: Some(account),
                    interval: 0,
                });
            }
        }
        session.next_poll = Instant::now() + Duration::from_secs(session.interval);
        Ok(PollResult {
            account: None,
            interval: session.interval,
        })
    }
}

pub fn access_token(provider: Provider, stored: &str) -> Result<(String, Option<String>)> {
    let secret: Tokens = serde_json::from_str(stored)
        .map_err(|_| Error::new("oauth", "Stored sign-in is invalid; reconnect this account"))?;
    if secret
        .expires_at
        .map_or(true, |expiry| expiry > now().saturating_add(60))
    {
        return Ok((secret.access_token, None));
    }
    let refresh = secret
        .refresh_token
        .as_deref()
        .ok_or_else(|| Error::new("oauth", "Sign-in expired; reconnect this account"))?;
    let (id, _, endpoint, _) = config(provider)?;
    let value = post(
        endpoint,
        &[
            ("client_id", id),
            ("refresh_token", refresh),
            ("grant_type", "refresh_token"),
        ],
    )?;
    let mut updated = tokens(&value).map_err(|_| {
        Error::new(
            "oauth",
            "Sign-in expired or was revoked; reconnect this account",
        )
    })?;
    if updated.refresh_token.is_none() {
        updated.refresh_token = secret.refresh_token;
    }
    let encoded = serde_json::to_string(&updated)
        .map_err(|_| Error::new("oauth", "Could not save refreshed sign-in"))?;
    Ok((updated.access_token, Some(encoded)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sign_in_validates_urls_and_never_exposes_secrets() {
        assert!(verification_uri(Provider::Github, "https://github.com/login/device").is_ok());
        for url in [
            "https://github.com.evil.test",
            "http://github.com",
            "https://user@github.com",
            "https://github.com:444",
        ] {
            assert!(verification_uri(Provider::Github, url).is_err());
        }
        let authorization = DeviceAuthorization {
            id: "opaque".into(),
            user_code: "ABCD".into(),
            verification_uri: "https://github.com/login/device".into(),
            interval: 5,
            expires_in: 900,
        };
        assert!(!serde_json::to_string(&authorization)
            .unwrap()
            .contains("device_code"));
        let secret = tokens(&serde_json::json!({"access_token":"secret"})).unwrap();
        assert_eq!(
            access_token(Provider::Github, &serde_json::to_string(&secret).unwrap())
                .unwrap()
                .0,
            "secret"
        );
        assert!(tokens(&serde_json::json!({"error":"denied"})).is_err());
        let registry = OAuth::default();
        assert!(registry
            .poll(&AccountStore::new(PathBuf::from("unused")), "unknown")
            .is_err());
    }
    #[test]
    fn device_sessions_enforce_polling_expiry_and_cancellation() {
        let registry = OAuth::default();
        let accounts = AccountStore::new(PathBuf::from("unused"));
        *registry.0.lock().unwrap() = Some(Session {
            id: "active".into(),
            provider: Provider::Github,
            device_code: "secret".into(),
            expires: Instant::now() + Duration::from_secs(60),
            next_poll: Instant::now() + Duration::from_secs(5),
            interval: 5,
        });
        let pending = registry.poll(&accounts, "active").unwrap();
        assert!(pending.account.is_none());
        assert_eq!(pending.interval, 5);
        registry.cancel("old-request").unwrap();
        assert!(registry.0.lock().unwrap().is_some());
        registry.0.lock().unwrap().as_mut().unwrap().expires = Instant::now();
        assert!(registry.poll(&accounts, "active").is_err());
        assert!(registry.0.lock().unwrap().is_none());
        assert!(access_token(
            Provider::Github,
            r#"{"access_token":"expired","refresh_token":null,"expires_at":1}"#
        )
        .is_err());
    }
    use std::path::PathBuf;
}
