//! Account-based discovery. API origins are constructed here, never taken from
//! provider pagination links or frontend URLs. Secrets remain in Rust.
use crate::{
    clone_dto::CloneRequest,
    dto::{Error, RepositoryLocation, Result},
    provider_accounts::{AccountStore, Provider, ProviderAccount},
    provider_pr::{authorized, client, response_json},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use serde_json::Value;
use std::process::Command;

const PAGE_SIZE: usize = 50;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRepository {
    id: String,
    name: String,
    namespace: String,
    clone_url: String,
    private: bool,
    project: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryPage {
    repositories: Vec<ProviderRepository>,
    next_cursor: Option<String>,
}

fn invalid() -> Error {
    Error::new(
        "providerApi",
        "The provider returned an invalid repository list",
    )
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 8192 && !s.chars().any(char::is_control))
        .ok_or_else(invalid)
}

fn get(
    account: &ProviderAccount,
    token: &str,
    url: &str,
) -> Result<(Value, reqwest::header::HeaderMap)> {
    let response = authorized(&client()?, reqwest::Method::GET, url, account, token)
        .send()
        .map_err(|_| {
            Error::new(
                "providerApi",
                "Could not reach the provider. Check your connection and retry.",
            )
        })?;
    let headers = response.headers().clone();
    Ok((response_json(response)?, headers))
}

fn organization_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 100
        || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(Error::new(
            "invalidRequest",
            "Enter an Azure DevOps organization name, not a URL",
        ));
    }
    Ok(())
}

pub fn organizations(accounts: &AccountStore, account_id: &str) -> Result<Vec<String>> {
    let (account, token) = accounts.credential(account_id)?;
    if account.provider != Provider::AzureDevops {
        return Err(Error::new(
            "invalidAccount",
            "Choose an Azure DevOps account",
        ));
    }
    let (profile, _) = get(
        &account,
        &token,
        "https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1",
    )?;
    let mut url = url::Url::parse("https://app.vssps.visualstudio.com/_apis/accounts").unwrap();
    url.query_pairs_mut()
        .append_pair("memberId", text(&profile, "id")?)
        .append_pair("api-version", "7.1");
    let (result, _) = get(&account, &token, url.as_str())?;
    let mut names: Vec<String> = result["value"]
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .map(|item| {
            let name = text(item, "accountName")?;
            organization_name(name)?;
            Ok(name.to_string())
        })
        .collect::<Result<_>>()?;
    names.sort();
    names.dedup();
    Ok(names)
}

fn page_number(cursor: Option<&str>) -> Result<u32> {
    match cursor {
        None => Ok(1),
        Some(value) => value
            .parse::<u32>()
            .ok()
            .filter(|n| (1..=100_000).contains(n))
            .ok_or_else(|| Error::new("invalidRequest", "Invalid repository page")),
    }
}

fn list_url(provider: Provider, organization: Option<&str>, page: u32) -> Result<url::Url> {
    let mut url = match provider {
        Provider::Github => url::Url::parse("https://api.github.com/user/repos").unwrap(),
        Provider::Gitlab => url::Url::parse("https://gitlab.com/api/v4/projects").unwrap(),
        Provider::AzureDevops => {
            let name = organization.ok_or_else(|| {
                Error::new("invalidRequest", "Choose an Azure DevOps organization")
            })?;
            organization_name(name)?;
            let mut url = url::Url::parse("https://dev.azure.com").unwrap();
            url.path_segments_mut()
                .unwrap()
                .extend([name, "_apis", "git", "repositories"]);
            url.query_pairs_mut().append_pair("api-version", "7.1");
            return Ok(url);
        }
        Provider::Bitbucket => {
            return Err(Error::new(
                "unsupportedProvider",
                "Repository browsing supports GitHub, GitLab.com, and Azure DevOps",
            ))
        }
    };
    url.query_pairs_mut()
        .append_pair("per_page", &PAGE_SIZE.to_string())
        .append_pair("page", &page.to_string());
    match provider {
        Provider::Github => {
            url.query_pairs_mut()
                .append_pair("sort", "full_name")
                .append_pair("direction", "asc")
                .append_pair("affiliation", "owner,collaborator,organization_member");
        }
        Provider::Gitlab => {
            url.query_pairs_mut()
                .append_pair("membership", "true")
                .append_pair("order_by", "path")
                .append_pair("sort", "asc");
        }
        _ => unreachable!(),
    }
    Ok(url)
}

/// Only canonical, credential-free cloud HTTPS URLs can receive account tokens.
pub(crate) fn clone_url(source: &str, provider: Provider) -> Result<url::Url> {
    let url = url::Url::parse(source).map_err(|_| invalid())?;
    let path: Vec<_> = url.path().trim_matches('/').split('/').collect();
    let valid_path = match provider {
        Provider::Github => path.len() == 2,
        Provider::Gitlab => path.len() >= 2,
        Provider::AzureDevops => matches!(path.as_slice(), [_, "_git", _] | [_, _, "_git", _]),
        Provider::Bitbucket => false,
    };
    if url.scheme() != "https"
        || url.host_str() != Some(provider.host())
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !valid_path
        || path.iter().any(|s| s.is_empty() || *s == "." || *s == "..")
        || source.chars().any(char::is_control)
    {
        return Err(Error::new(
            "invalidCloneSource",
            "The selected account requires a matching cloud-provider HTTPS repository URL",
        ));
    }
    Ok(url)
}

fn convert(item: &Value, provider: Provider) -> Result<ProviderRepository> {
    let name = text(item, "name")?.to_string();
    let (namespace, source, private, project) = match provider {
        Provider::Github => (
            text(&item["owner"], "login")?.into(),
            text(item, "clone_url")?,
            item["private"].as_bool().ok_or_else(invalid)?,
            None,
        ),
        Provider::Gitlab => (
            text(&item["namespace"], "full_path")?.into(),
            text(item, "http_url_to_repo")?,
            text(item, "visibility")? != "public",
            None,
        ),
        Provider::AzureDevops => {
            let project = text(&item["project"], "name")?.to_string();
            (
                project.clone(),
                text(item, "remoteUrl")?,
                item["project"]["visibility"].as_str() != Some("public"),
                Some(project),
            )
        }
        Provider::Bitbucket => unreachable!(),
    };
    // Some Azure API responses include organization userinfo. Strip it before
    // returning the URL; credentials are supplied separately, never persisted.
    let mut url = url::Url::parse(source).map_err(|_| invalid())?;
    if provider == Provider::AzureDevops && url.password().is_none() {
        url.set_username("").map_err(|_| invalid())?;
    }
    clone_url(url.as_str(), provider)?;
    let id = match &item["id"] {
        Value::String(id) if !id.is_empty() => id.clone(),
        Value::Number(id) => id.to_string(),
        _ => return Err(invalid()),
    };
    Ok(ProviderRepository {
        id,
        name,
        namespace,
        clone_url: url.into(),
        private,
        project,
    })
}

fn parse_page(
    provider: Provider,
    result: &Value,
    headers: &reqwest::header::HeaderMap,
    page: u32,
) -> Result<RepositoryPage> {
    let items = if provider == Provider::AzureDevops {
        &result["value"]
    } else {
        result
    }
    .as_array()
    .ok_or_else(invalid)?;
    let has_next = match provider {
        Provider::Github => headers
            .get_all("link")
            .iter()
            .filter_map(|v| v.to_str().ok())
            .any(|v| v.split(',').any(|part| part.contains("rel=\"next\""))),
        Provider::Gitlab => headers
            .get("x-next-page")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| !v.is_empty()),
        // Azure's repository-list endpoint is unpaged (bounded response capture).
        Provider::AzureDevops => false,
        Provider::Bitbucket => unreachable!(),
    };
    Ok(RepositoryPage {
        repositories: items
            .iter()
            .filter(|item| item["isDisabled"] != true)
            .map(|item| convert(item, provider))
            .collect::<Result<_>>()?,
        next_cursor: has_next.then(|| (page + 1).to_string()),
    })
}

pub fn repositories(
    accounts: &AccountStore,
    account_id: &str,
    organization: Option<&str>,
    cursor: Option<&str>,
) -> Result<RepositoryPage> {
    let page = page_number(cursor)?;
    let (account, token) = accounts.credential(account_id)?;
    let url = list_url(account.provider, organization, page)?;
    let (result, headers) = get(&account, &token, url.as_str())?;
    parse_page(account.provider, &result, &headers, page)
}

pub(crate) struct CloneCredential {
    source: String,
    token: String,
    authorization: String,
}

impl CloneCredential {
    fn new(source: &str, account: &ProviderAccount, token: String) -> Result<Self> {
        let url = clone_url(source, account.provider)?;
        if token.is_empty() || token.len() > 8192 || token.chars().any(char::is_control) {
            return Err(Error::new(
                "credentialStore",
                "Stored credential is invalid; reconnect this account",
            ));
        }
        let authorization = if account.provider == Provider::AzureDevops && account.oauth {
            format!("Bearer {token}")
        } else {
            let username = match account.provider {
                Provider::Gitlab => "oauth2",
                Provider::AzureDevops => "gitty",
                _ => "x-access-token",
            };
            format!("Basic {}", STANDARD.encode(format!("{username}:{token}")))
        };
        Ok(Self {
            source: url.to_string(),
            token,
            authorization,
        })
    }

    pub(crate) fn configure(&self, command: &mut Command) {
        // Process-local config, not argv or repository config. Reset configured
        // headers first and scope authorization to this exact repository URL.
        let key = format!("http.{}.extraHeader", self.source);
        let config = [
            ("http.extraHeader", ""),
            (key.as_str(), ""),
            (key.as_str(), self.authorization.as_str()),
        ];
        command.env("GIT_CONFIG_COUNT", config.len().to_string());
        for (i, (key, value)) in config.iter().enumerate() {
            command.env(format!("GIT_CONFIG_KEY_{i}"), key).env(
                format!("GIT_CONFIG_VALUE_{i}"),
                if i == 2 {
                    format!("Authorization: {value}")
                } else {
                    value.to_string()
                },
            );
        }
    }

    pub(crate) fn redact(&self, message: &str) -> String {
        message
            .replace(&self.token, "[redacted]")
            .replace(&self.authorization, "[redacted]")
            .replace(self.authorization.split_once(' ').unwrap().1, "[redacted]")
    }
}

pub(crate) fn clone_credential(
    accounts: &AccountStore,
    request: &CloneRequest,
) -> Result<Option<CloneCredential>> {
    let Some(id) = &request.account_id else {
        return Ok(None);
    };
    if !matches!(request.parent, RepositoryLocation::Native { .. }) {
        return Err(Error::new("unsupportedPlatform", "Connected-account cloning requires a native destination. Use URL cloning with WSL credentials for WSL."));
    }
    let account = accounts
        .list()?
        .into_iter()
        .find(|account| account.id == *id)
        .ok_or_else(|| {
            Error::new(
                "invalidAccount",
                "Account not found; reconnect or choose another account",
            )
        })?;
    clone_url(&request.source, account.provider)?;
    let (account, token) = accounts.credential(id)?;
    CloneCredential::new(&request.source, &account, token).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_provider_repository_lists_and_pagination() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("link", "<https://evil.test>; rel=\"next\"".parse().unwrap());
        let github = parse_page(Provider::Github, &json!([{"id":1,"name":"repo","owner":{"login":"team"},"clone_url":"https://github.com/team/repo.git","private":true}]), &headers, 2).unwrap();
        assert_eq!(github.next_cursor.as_deref(), Some("3"));
        assert_eq!(github.repositories[0].namespace, "team");
        assert!(github.repositories[0].private);
        headers.insert("x-next-page", "2".parse().unwrap());
        let gitlab = parse_page(Provider::Gitlab, &json!([{"id":2,"name":"repo","namespace":{"full_path":"group/sub"},"http_url_to_repo":"https://gitlab.com/group/sub/repo.git","visibility":"private"}]), &headers, 1).unwrap();
        assert_eq!(gitlab.next_cursor.as_deref(), Some("2"));
        assert_eq!(gitlab.repositories[0].namespace, "group/sub");
        let azure = parse_page(Provider::AzureDevops, &json!({"value":[{"id":"uuid","name":"repo","project":{"name":"Project","visibility":"public"},"remoteUrl":"https://org@dev.azure.com/org/Project/_git/repo"}]}), &headers, 1).unwrap();
        assert_eq!(
            azure.repositories[0].clone_url,
            "https://dev.azure.com/org/Project/_git/repo"
        );
        assert_eq!(azure.repositories[0].project.as_deref(), Some("Project"));
        assert!(!azure.repositories[0].private);
        assert!(azure.next_cursor.is_none());
    }

    #[test]
    fn rejects_untrusted_clone_urls_and_invalid_pages() {
        for source in [
            "http://github.com/a/b",
            "https://github.com.evil.test/a/b",
            "https://github.com/a/b?token=x",
            "https://user:pass@github.com/a/b",
            "https://github.com:8443/a/b",
            "git@github.com:a/b",
            "https://gitlab.com/a/b",
            "https://github.com/a",
        ] {
            assert!(clone_url(source, Provider::Github).is_err(), "{source}");
        }
        assert!(clone_url(
            "https://dev.azure.com/org/project/_git/repo",
            Provider::AzureDevops
        )
        .is_ok());
        assert!(page_number(Some("https://evil.test")).is_err());
        assert!(page_number(Some("0")).is_err());
        assert!(list_url(Provider::AzureDevops, Some("../evil"), 1).is_err());
        assert!(parse_page(Provider::Github, &json!({}), &Default::default(), 1).is_err());
    }

    #[test]
    fn clone_request_remains_backward_compatible_and_checks_account_boundaries_before_keyring() {
        let legacy = json!({"source":"https://github.com/team/repo.git","parent":{"kind":"native","path":"/tmp"},"directoryName":"repo"});
        let request: CloneRequest = serde_json::from_value(legacy.clone()).unwrap();
        assert!(request.account_id.is_none());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("accounts.json");
        std::fs::write(
            &path,
            r#"[{"id":"account","provider":"github","username":"alice","oauth":false}]"#,
        )
        .unwrap();
        let accounts = AccountStore::new(path);
        assert!(clone_credential(&accounts, &request).unwrap().is_none());
        let mut selected = legacy;
        selected["accountId"] = json!("account");
        let mut request: CloneRequest = serde_json::from_value(selected.clone()).unwrap();
        request.source = "https://gitlab.com/team/repo.git".into();
        assert_eq!(
            clone_credential(&accounts, &request).err().unwrap().code,
            "invalidCloneSource"
        );
        request.parent = RepositoryLocation::Wsl {
            distribution: "Ubuntu".into(),
            path: "/tmp".into(),
        };
        assert_eq!(
            clone_credential(&accounts, &request).err().unwrap().code,
            "unsupportedPlatform"
        );
        selected["password"] = json!("must-not-cross-ipc");
        assert!(serde_json::from_value::<CloneRequest>(selected).is_err());
    }

    #[test]
    fn clone_credentials_are_scoped_ephemeral_and_redacted() {
        for (provider, oauth, source, scheme) in [
            (
                Provider::Github,
                true,
                "https://github.com/team/repo.git",
                "Basic ",
            ),
            (
                Provider::Gitlab,
                true,
                "https://gitlab.com/team/repo.git",
                "Basic ",
            ),
            (
                Provider::AzureDevops,
                true,
                "https://dev.azure.com/org/project/_git/repo",
                "Bearer ",
            ),
            (
                Provider::AzureDevops,
                false,
                "https://dev.azure.com/org/project/_git/repo",
                "Basic ",
            ),
        ] {
            let account = ProviderAccount {
                id: "id".into(),
                provider,
                username: "user".into(),
                oauth,
            };
            let credential = CloneCredential::new(source, &account, "test-secret".into()).unwrap();
            let mut command = Command::new("git");
            credential.configure(&mut command);
            assert!(command.get_args().next().is_none());
            let env: Vec<_> = command.get_envs().collect();
            assert!(env.iter().any(|(key, value)| *key == "GIT_CONFIG_KEY_2"
                && value.unwrap().to_str().unwrap() == format!("http.{source}.extraHeader")));
            assert!(credential.authorization.starts_with(scheme));
            assert!(!credential
                .redact(&format!("test-secret {}", credential.authorization))
                .contains("test-secret"));
        }
    }

    #[test]
    fn real_git_sends_account_authorization_only_to_the_selected_repository() {
        use std::{
            io::{BufRead, BufReader, Write},
            net::TcpListener,
            thread,
            time::{Duration, Instant},
        };
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        server.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", server.local_addr().unwrap());
        // Production construction refuses HTTP/localhost. The test-only fixture
        // exercises Git's actual header matching against a loopback HTTP server.
        let credential = CloneCredential {
            source: format!("{origin}/selected.git"),
            token: "test-secret".into(),
            authorization: format!("Basic {}", STANDARD.encode("x-access-token:test-secret")),
        };
        let worker = thread::spawn(move || {
            let mut requests = Vec::new();
            let deadline = Instant::now() + Duration::from_secs(10);
            while requests.len() < 2 && Instant::now() < deadline {
                match server.accept() {
                    Ok((mut stream, _)) => {
                        stream
                            .set_read_timeout(Some(Duration::from_secs(3)))
                            .unwrap();
                        let mut reader = BufReader::new(stream.try_clone().unwrap());
                        let mut headers = String::new();
                        loop {
                            let mut line = String::new();
                            if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                                break;
                            }
                            headers.push_str(&line);
                        }
                        requests.push(headers);
                        stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10))
                    }
                    Err(error) => panic!("{error}"),
                }
            }
            requests
        });
        let dir = tempfile::tempdir().unwrap();
        for name in ["selected.git", "unrelated.git"] {
            let location = RepositoryLocation::Native {
                path: dir.path().to_string_lossy().into_owned(),
            };
            let mut command = crate::process::git_external_mutation_command(
                &location,
                &crate::process::args(&[
                    "-c",
                    "http.proxy=",
                    "-c",
                    "protocol.http.allow=always",
                    "-c",
                    "credential.helper=",
                    "-c",
                    "http.followRedirects=false",
                    "ls-remote",
                    &format!("{origin}/{name}"),
                ]),
            )
            .unwrap();
            command
                .current_dir(dir.path())
                .env(
                    "GIT_CONFIG_GLOBAL",
                    if cfg!(windows) { "NUL" } else { "/dev/null" },
                )
                .env("GIT_CONFIG_NOSYSTEM", "1");
            credential.configure(&mut command);
            assert!(!crate::process::run(command).unwrap().success);
        }
        let requests = worker.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].contains(&format!("Authorization: {}", credential.authorization)));
        assert!(!requests[1].to_ascii_lowercase().contains("authorization:"));
    }
}
