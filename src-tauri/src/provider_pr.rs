use crate::{
    dto::{Error, Result},
    provider_accounts::{AccountStore, Provider, ProviderAccount},
    repository::Service,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{io::Read, time::Duration};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPullRequest {
    pub id: String,
    pub title: String,
    pub url: String,
    pub source: String,
    pub target: String,
    pub state: String,
}

/// One page of open pull requests. `truncated` means the provider reported (or the
/// page size implies) further results that this single-page request did not fetch.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPullRequests {
    pub requests: Vec<ProviderPullRequest>,
    pub truncated: bool,
}

/// Page size requested from every provider (`per_page`, `$top`, `pagelen`).
const LIST_PAGE_SIZE: usize = 50;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreatePullRequest {
    pub source: String,
    pub target: String,
    pub title: String,
    pub description: String,
}

#[derive(Debug)]
struct ProviderRepository {
    provider: Provider,
    api: String,
    web: String,
}

/// Host of a provider's SSH endpoint: Azure DevOps clones over `ssh.dev.azure.com`,
/// every other supported provider uses the host it serves its web UI from.
fn ssh_host(provider: Provider) -> &'static str {
    match provider {
        Provider::AzureDevops => "ssh.dev.azure.com",
        _ => provider.host(),
    }
}

fn unsupported_remote(provider: Provider) -> Error {
    Error::new(
        "invalidRemote",
        format!(
            "Only HTTPS or SSH remotes for {} are supported. Host aliases and self-hosted servers are not.",
            provider.host()
        ),
    )
}

/// Canonical repository path (without leading/trailing `/` or a `.git` suffix) of an
/// SSH remote, in the layout the HTTPS form uses. Azure DevOps' SSH layout
/// `v3/{org}/{project}/{repo}` maps to `{org}/{project}/_git/{repo}`.
fn ssh_repository_path(raw: &str, provider: Provider) -> Result<String> {
    let trimmed = raw.trim_matches('/');
    let path = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    if provider != Provider::AzureDevops {
        return Ok(path.to_string());
    }
    match path.split('/').collect::<Vec<_>>().as_slice() {
        ["v3", org, project, repo] => Ok(format!("{org}/{project}/_git/{repo}")),
        _ => Err(Error::new(
            "invalidRemote",
            "Unsupported provider repository URL",
        )),
    }
}

/// Parses `[user@]host:path` (scp-like, no scheme). `None` when the value is not
/// scp-like at all (a local or Windows path, or it has a scheme).
fn scp_like_remote(remote: &str) -> Option<(&str, &str)> {
    if remote.contains("://") {
        return None;
    }
    let (authority, path) = remote.split_once(':')?;
    let host = match authority.split_once('@') {
        Some((user, host)) if !user.is_empty() && !user.contains('@') => host,
        Some(_) => return None,
        None => authority,
    };
    if host.is_empty() || host.contains(['/', '\\', '[', ']', '@']) || authority.contains('/') {
        return None;
    }
    Some((host, path))
}

fn repository_url(remote: &str, provider: Provider) -> Result<ProviderRepository> {
    // `path` is the canonical repository path; `web_path` the browser path of the
    // remote exactly as the HTTPS form has always derived it.
    let (path, web_path): (String, String) = if remote.contains("://") {
        let url = url::Url::parse(remote).map_err(|_| unsupported_remote(provider))?;
        match url.scheme() {
            "https" => {
                if url.host_str() != Some(provider.host())
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.port().is_some()
                    || url.query().is_some()
                    || url.fragment().is_some()
                {
                    return Err(Error::new(
                        "invalidRemote",
                        "Account and remote hosts do not match",
                    ));
                }
                let path = url
                    .path()
                    .trim_matches('/')
                    .strip_suffix(".git")
                    .unwrap_or_else(|| url.path().trim_matches('/'));
                (
                    path.to_string(),
                    url.path().trim_end_matches('/').to_string(),
                )
            }
            "ssh" => {
                if !url
                    .host_str()
                    .is_some_and(|host| host.eq_ignore_ascii_case(ssh_host(provider)))
                    || url.password().is_some()
                    || url.query().is_some()
                    || url.fragment().is_some()
                {
                    return Err(unsupported_remote(provider));
                }
                if !matches!(url.port(), None | Some(22)) {
                    return Err(Error::new(
                        "invalidRemote",
                        "SSH remotes on a non-default port are not supported for pull requests",
                    ));
                }
                let path = ssh_repository_path(url.path(), provider)?;
                let web_path = format!("/{path}");
                (path, web_path)
            }
            _ => return Err(unsupported_remote(provider)),
        }
    } else {
        let (_, raw_path) = scp_like_remote(remote)
            .filter(|(host, _)| host.eq_ignore_ascii_case(ssh_host(provider)))
            .ok_or_else(|| unsupported_remote(provider))?;
        let path = ssh_repository_path(raw_path, provider)?;
        let web_path = format!("/{path}");
        (path, web_path)
    };
    let path = path.as_str();
    let parts: Vec<_> = path.split('/').collect();
    if parts.iter().any(|part| {
        part.is_empty()
            || *part == "."
            || *part == ".."
            || part.contains(['%', '\\', '?', '#', ':'])
            || part.chars().any(|c| c.is_whitespace() || c.is_control())
    }) {
        return Err(Error::new("invalidRemote", "Unsupported repository path"));
    }
    let api = match provider {
        Provider::Github if parts.len() == 2 => format!(
            "https://api.github.com/repos/{}/{}/pulls",
            parts[0], parts[1]
        ),
        Provider::Gitlab if parts.len() >= 2 => {
            let mut api = url::Url::parse("https://gitlab.com/api/v4/projects/").unwrap();
            api.path_segments_mut().unwrap().pop_if_empty().push(path);
            format!("{api}/merge_requests")
        }
        Provider::AzureDevops if parts.len() == 4 && parts[2] == "_git" => format!(
            "https://dev.azure.com/{}/{}/_apis/git/repositories/{}/pullrequests?api-version=7.1",
            parts[0], parts[1], parts[3]
        ),
        Provider::Bitbucket if parts.len() == 2 => format!(
            "https://api.bitbucket.org/2.0/repositories/{}/{}/pullrequests",
            parts[0], parts[1]
        ),
        _ => {
            return Err(Error::new(
                "invalidRemote",
                "Unsupported provider repository URL",
            ))
        }
    };
    let web = format!("https://{}{}/", provider.host(), web_path);
    Ok(ProviderRepository { provider, api, web })
}

fn client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Gitty/0.1")
        .build()
        .map_err(|_| Error::new("providerApi", "Could not start provider request"))
}

pub(crate) fn verify_token(provider: Provider, username: &str, token: &str) -> Result<()> {
    // Azure DevOps PAT validation requires an organization URL, which is not
    // part of the cloud account identity. Git/PR operations check it on use.
    if provider == Provider::AzureDevops {
        return Ok(());
    }
    let url = match provider {
        Provider::Github => "https://api.github.com/user",
        Provider::Gitlab => "https://gitlab.com/api/v4/user",
        Provider::Bitbucket => "https://api.bitbucket.org/2.0/user",
        Provider::AzureDevops => unreachable!(),
    };
    let account = ProviderAccount {
        id: String::new(),
        provider,
        username: username.into(),
        oauth: false,
    };
    let client = client()?;
    let result = response_json(
        authorized(&client, reqwest::Method::GET, url, &account, token)
            .send()
            .map_err(|_| Error::new("providerApi", "Could not verify the provider token"))?,
    )?;
    let actual = match provider {
        Provider::Github => field(&result, "login"),
        Provider::Gitlab => field(&result, "username"),
        Provider::Bitbucket => field(&result, "account_id"),
        Provider::AzureDevops => unreachable!(),
    };
    if actual.is_empty()
        || (provider != Provider::Bitbucket && !actual.eq_ignore_ascii_case(username))
    {
        return Err(Error::new(
            "invalidAccount",
            "Token does not match the selected account username",
        ));
    }
    Ok(())
}

fn response_json(response: reqwest::blocking::Response) -> Result<Value> {
    let status = response.status();
    if !status.is_success() {
        return Err(Error::new("providerApi", format!("Provider returned HTTP {status}. Check your account permissions and reconnect if its token expired.")));
    }
    let mut data = Vec::new();
    response.take(2 * 1024 * 1024 + 1).read_to_end(&mut data)?;
    if data.len() > 2 * 1024 * 1024 {
        return Err(Error::new("providerApi", "Provider response is too large"));
    }
    serde_json::from_slice(&data)
        .map_err(|_| Error::new("providerApi", "Invalid provider response"))
}

/// Whether response headers advertise another page: GitHub's `Link: rel="next"` or
/// GitLab's non-empty `x-next-page`. `None` for providers that signal it in the body.
fn next_page_header(provider: Provider, headers: &reqwest::header::HeaderMap) -> Option<bool> {
    let value = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    match provider {
        Provider::Github => Some(
            headers
                .get_all(reqwest::header::LINK)
                .iter()
                .filter_map(|v| v.to_str().ok())
                .any(|link| link.split(',').any(|part| part.contains("rel=\"next\""))),
        ),
        Provider::Gitlab => Some(value("x-next-page").is_some_and(|v| !v.trim().is_empty())),
        Provider::AzureDevops | Provider::Bitbucket => None,
    }
}

/// Extracts the pull requests and the provider-specific truncation flag from a list
/// response body. Envelopes differ: GitHub/GitLab return a top-level array, Azure
/// DevOps `{"value":[…],"count":N}`, Bitbucket `{"values":[…],"next":"…"}`.
/// `next_page` is the header-derived hint from [`next_page_header`]; when absent,
/// GitHub/GitLab fall back to "page is full" (len == page size), and Azure DevOps
/// treats a full page (`count` or length == page size) as possibly truncated.
fn parse_list(
    repository: &ProviderRepository,
    result: &Value,
    next_page: Option<bool>,
) -> Result<ProviderPullRequests> {
    let invalid = || Error::new("providerApi", "Invalid pull request list");
    let provider = repository.provider;
    let entries = match provider {
        Provider::Github | Provider::Gitlab => result,
        Provider::AzureDevops => &result["value"],
        Provider::Bitbucket => &result["values"],
    }
    .as_array()
    .ok_or_else(invalid)?;
    let truncated = match provider {
        Provider::Github | Provider::Gitlab => next_page.unwrap_or(entries.len() >= LIST_PAGE_SIZE),
        Provider::AzureDevops => {
            entries.len() >= LIST_PAGE_SIZE
                || result["count"]
                    .as_u64()
                    .is_some_and(|n| n >= LIST_PAGE_SIZE as u64)
        }
        Provider::Bitbucket => result.get("next").is_some_and(|n| !n.is_null()),
    };
    Ok(ProviderPullRequests {
        requests: entries
            .iter()
            .map(|item| convert(item, repository))
            .collect::<Result<_>>()?,
        truncated,
    })
}

fn authorized(
    client: &reqwest::blocking::Client,
    method: reqwest::Method,
    api: &str,
    account: &ProviderAccount,
    token: &str,
) -> reqwest::blocking::RequestBuilder {
    let request = client.request(method, api);
    match account.provider {
        Provider::AzureDevops if account.oauth => request.bearer_auth(token),
        Provider::AzureDevops => request.basic_auth("", Some(token)),
        Provider::Bitbucket => request.basic_auth(&account.username, Some(token)),
        Provider::Github | Provider::Gitlab => request.bearer_auth(token),
    }
}

fn field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn convert(value: &Value, repository: &ProviderRepository) -> Result<ProviderPullRequest> {
    let provider = repository.provider;
    let (id, url, source, target) = match provider {
        Provider::Github => (
            value["number"].to_string(),
            field(value, "html_url"),
            field(&value["head"], "ref"),
            field(&value["base"], "ref"),
        ),
        Provider::Gitlab => (
            value["iid"].to_string(),
            field(value, "web_url"),
            field(value, "source_branch"),
            field(value, "target_branch"),
        ),
        Provider::AzureDevops => (
            value["pullRequestId"].to_string(),
            field(&value["_links"]["web"], "href"),
            field(value, "sourceRefName"),
            field(value, "targetRefName"),
        ),
        Provider::Bitbucket => (
            value["id"].to_string(),
            field(&value["links"]["html"], "href"),
            field(&value["source"]["branch"], "name"),
            field(&value["destination"]["branch"], "name"),
        ),
    };
    let url = if provider == Provider::AzureDevops && url.is_empty() && id != "null" {
        format!("{}pullrequest/{id}", repository.web)
    } else {
        url.into()
    };
    if id == "null" || field(value, "title").is_empty() || url.is_empty() {
        return Err(Error::new(
            "providerApi",
            "Incomplete pull request response",
        ));
    }
    Ok(ProviderPullRequest {
        id,
        title: field(value, "title").into(),
        url,
        source: source.into(),
        target: target.into(),
        state: field(
            value,
            if provider == Provider::AzureDevops {
                "status"
            } else {
                "state"
            },
        )
        .into(),
    })
}

fn validate_branch(branch: &str) -> Result<()> {
    if branch.is_empty()
        || branch.len() > 1024
        || branch.starts_with('-')
        || branch.contains("..")
        || branch
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control() || "~^:?*[\\".contains(ch))
    {
        return Err(Error::new("invalidBranch", "Enter a valid branch name"));
    }
    Ok(())
}

impl Service {
    fn provider_remote(
        &self,
        handle: &str,
        remote: &str,
        account: &ProviderAccount,
    ) -> Result<ProviderRepository> {
        let repo = self.repo(handle)?;
        if !repo.sync_info()?.remotes.iter().any(|name| name == remote) {
            return Err(Error::new("invalidRemote", "Choose a configured remote"));
        }
        let url = crate::repository::string(
            repo.location(),
            &["remote", "get-url", "--push", "--", remote],
        )?;
        repository_url(&url, account.provider)
    }

    pub fn provider_pull_requests(
        &self,
        accounts: &AccountStore,
        handle: &str,
        remote: &str,
        account_id: &str,
    ) -> Result<ProviderPullRequests> {
        let (account, token) = accounts.credential(account_id)?;
        let repository = self.provider_remote(handle, remote, &account)?;
        let api = match repository.provider {
            Provider::Github => format!("{}?state=open&per_page={LIST_PAGE_SIZE}", repository.api),
            Provider::Gitlab => {
                format!("{}?state=opened&per_page={LIST_PAGE_SIZE}", repository.api)
            }
            Provider::AzureDevops => {
                format!(
                    "{}&searchCriteria.status=active&$top={LIST_PAGE_SIZE}",
                    repository.api
                )
            }
            Provider::Bitbucket => {
                format!("{}?state=OPEN&pagelen={LIST_PAGE_SIZE}", repository.api)
            }
        };
        let client = client()?;
        let response = authorized(&client, reqwest::Method::GET, &api, &account, &token)
            .send()
            .map_err(|_| Error::new("providerApi", "Could not contact provider"))?;
        let next_page = next_page_header(repository.provider, response.headers());
        parse_list(&repository, &response_json(response)?, next_page)
    }

    pub fn provider_create_pull_request(
        &self,
        accounts: &AccountStore,
        handle: &str,
        remote: &str,
        account_id: &str,
        request: CreatePullRequest,
    ) -> Result<ProviderPullRequest> {
        validate_branch(&request.source)?;
        validate_branch(&request.target)?;
        if request.source == request.target
            || request.title.trim().is_empty()
            || request.title.len() > 256
            || request.description.len() > 64 * 1024
        {
            return Err(Error::new(
                "invalidRequest",
                "Choose distinct branches and a title of up to 256 characters",
            ));
        }
        let (account, token) = accounts.credential(account_id)?;
        let repository = self.provider_remote(handle, remote, &account)?;
        let body = match repository.provider {
            Provider::Github => {
                json!({"head": request.source, "base": request.target, "title": request.title, "body": request.description})
            }
            Provider::Gitlab => {
                json!({"source_branch": request.source, "target_branch": request.target, "title": request.title, "description": request.description})
            }
            Provider::AzureDevops => {
                json!({"sourceRefName": format!("refs/heads/{}", request.source), "targetRefName": format!("refs/heads/{}", request.target), "title": request.title, "description": request.description})
            }
            Provider::Bitbucket => {
                json!({"source": {"branch": {"name": request.source}}, "destination": {"branch": {"name": request.target}}, "title": request.title, "description": request.description})
            }
        };
        let client = client()?;
        let result = response_json(
            authorized(
                &client,
                reqwest::Method::POST,
                &repository.api,
                &account,
                &token,
            )
            .json(&body)
            .send()
            .map_err(|_| Error::new("providerApi", "Could not contact provider"))?,
        )?;
        convert(&result, &repository)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_repository_urls_are_exact_and_credentials_are_rejected() {
        assert_eq!(
            repository_url("https://github.com/team/project.git", Provider::Github)
                .unwrap()
                .api,
            "https://api.github.com/repos/team/project/pulls"
        );
        assert!(repository_url(
            "https://github.com.evil.test/team/project",
            Provider::Github
        )
        .is_err());
        assert!(repository_url(
            "https://user:secret@github.com/team/project",
            Provider::Github
        )
        .is_err());
        assert_eq!(
            repository_url("https://gitlab.com/team/sub/project.git", Provider::Gitlab)
                .unwrap()
                .api,
            "https://gitlab.com/api/v4/projects/team%2Fsub%2Fproject/merge_requests"
        );
    }

    #[test]
    fn ssh_remotes_map_to_the_same_repositories_as_https() {
        let github = repository_url("git@github.com:org/repo.git", Provider::Github).unwrap();
        assert_eq!(github.api, "https://api.github.com/repos/org/repo/pulls");
        assert_eq!(github.web, "https://github.com/org/repo/");
        let no_user = repository_url("github.com:org/repo", Provider::Github).unwrap();
        assert_eq!(no_user.api, github.api);
        let gitlab =
            repository_url("ssh://git@gitlab.com/group/sub/repo.git", Provider::Gitlab).unwrap();
        assert_eq!(
            gitlab.api,
            "https://gitlab.com/api/v4/projects/group%2Fsub%2Frepo/merge_requests"
        );
        assert_eq!(gitlab.web, "https://gitlab.com/group/sub/repo/");
        assert_eq!(
            repository_url("ssh://git@gitlab.com:22/group/repo", Provider::Gitlab)
                .unwrap()
                .api,
            "https://gitlab.com/api/v4/projects/group%2Frepo/merge_requests"
        );
        let azure = repository_url(
            "git@ssh.dev.azure.com:v3/org/project/repo",
            Provider::AzureDevops,
        )
        .unwrap();
        assert_eq!(
            azure.api,
            "https://dev.azure.com/org/project/_apis/git/repositories/repo/pullrequests?api-version=7.1"
        );
        assert_eq!(azure.web, "https://dev.azure.com/org/project/_git/repo/");
        assert_eq!(
            repository_url(
                "ssh://git@ssh.dev.azure.com/v3/org/project/repo",
                Provider::AzureDevops
            )
            .unwrap()
            .api,
            azure.api
        );
        assert_eq!(
            repository_url("git@bitbucket.org:team/repo.git", Provider::Bitbucket)
                .unwrap()
                .api,
            "https://api.bitbucket.org/2.0/repositories/team/repo/pullrequests"
        );
        // HTTPS parsing is unchanged: `.git` stays in the browser path.
        assert_eq!(
            repository_url("https://github.com/org/repo.git", Provider::Github)
                .unwrap()
                .web,
            "https://github.com/org/repo.git/"
        );
    }

    #[test]
    fn unsupported_ssh_remotes_are_rejected() {
        let alias = repository_url("git@github-work:org/repo.git", Provider::Github).unwrap_err();
        assert!(alias
            .message
            .contains("Only HTTPS or SSH remotes for github.com are supported"));
        for (remote, provider) in [
            ("git@github.com.evil.test:org/repo", Provider::Github),
            ("git@gitlab.com:org/repo", Provider::Github),
            ("ssh://git@github.com:2222/org/repo", Provider::Github),
            ("ssh://git@github.com:22222/org/repo", Provider::Github),
            ("ssh://git@github-work/org/repo", Provider::Github),
            ("ssh://user:pw@github.com/org/repo", Provider::Github),
            ("ssh://git@github.com/org/repo?x=1", Provider::Github),
            ("git@github.com:org/repo/extra", Provider::Github),
            ("git@github.com:org", Provider::Github),
            ("git@github.com:org/../repo", Provider::Github),
            ("git@github.com:org/re po", Provider::Github),
            ("git@github.com:org/repo#frag", Provider::Github),
            ("git@github.com:ssh://org/repo", Provider::Github),
            ("git@github.com://org/repo", Provider::Github),
            ("ssh://git@github.com:org/repo", Provider::Github),
            ("git://github.com/org/repo", Provider::Github),
            ("http://github.com/org/repo", Provider::Github),
            ("@github.com:org/repo", Provider::Github),
            ("/tmp/github.com:org/repo", Provider::Github),
            ("C:\\repo", Provider::Github),
            // Azure DevOps SSH needs the exact v3/{org}/{project}/{repo} layout.
            (
                "git@ssh.dev.azure.com:org/project/repo",
                Provider::AzureDevops,
            ),
            ("git@ssh.dev.azure.com:v3/org/repo", Provider::AzureDevops),
            (
                "git@dev.azure.com:v3/org/project/repo",
                Provider::AzureDevops,
            ),
            (
                "git@vs-ssh.visualstudio.com:v3/org/project/repo",
                Provider::AzureDevops,
            ),
        ] {
            assert!(
                repository_url(remote, provider).is_err(),
                "{remote} must be rejected"
            );
        }
        let port =
            repository_url("ssh://git@github.com:2222/org/repo", Provider::Github).unwrap_err();
        assert!(port.message.contains("non-default port"));
    }

    #[test]
    fn provider_pull_requests_have_a_browser_url_and_branch_names() {
        let repo = repository_url(
            "https://dev.azure.com/org/project/_git/repo",
            Provider::AzureDevops,
        )
        .unwrap();
        let pr = convert(&json!({"pullRequestId": 42, "title": "Fix bug", "sourceRefName": "refs/heads/fix", "targetRefName": "refs/heads/main", "status": "active"}), &repo).unwrap();
        assert_eq!(
            pr.url,
            "https://dev.azure.com/org/project/_git/repo/pullrequest/42"
        );
        assert_eq!(pr.source, "refs/heads/fix");
        let github = repository_url("https://github.com/org/repo", Provider::Github).unwrap();
        assert_eq!(convert(&json!({"number": 2, "title": "Add feature", "html_url": "https://github.com/org/repo/pull/2", "head": {"ref": "topic"}, "base": {"ref": "main"}}), &github).unwrap().source, "topic");
    }

    fn github_item(n: usize) -> Value {
        json!({"number": n, "title": format!("PR {n}"), "html_url": format!("https://github.com/org/repo/pull/{n}"), "head": {"ref": "topic"}, "base": {"ref": "main"}, "state": "open"})
    }

    #[test]
    fn azure_devops_lists_use_the_value_envelope_and_count_for_truncation() {
        let repo = repository_url(
            "https://dev.azure.com/org/project/_git/repo",
            Provider::AzureDevops,
        )
        .unwrap();
        let item = json!({"pullRequestId": 7, "title": "Fix", "sourceRefName": "refs/heads/x", "targetRefName": "refs/heads/main", "status": "active"});
        let page = parse_list(&repo, &json!({"value": [item.clone()], "count": 1}), None).unwrap();
        assert_eq!(page.requests.len(), 1);
        assert_eq!(page.requests[0].id, "7");
        assert_eq!(page.requests[0].state, "active");
        assert!(!page.truncated);
        // The Bitbucket envelope key is not accepted for Azure DevOps.
        assert!(parse_list(&repo, &json!({"values": [item.clone()]}), None).is_err());
        let full = json!({"value": vec![item.clone(); 50], "count": 50});
        assert!(parse_list(&repo, &full, None).unwrap().truncated);
        let counted = json!({"value": [item], "count": 50});
        assert!(parse_list(&repo, &counted, None).unwrap().truncated);
        assert!(parse_list(&repo, &json!({"value": [], "count": 0}), None)
            .unwrap()
            .requests
            .is_empty());
    }

    #[test]
    fn bitbucket_lists_use_the_values_envelope_and_next_for_truncation() {
        let repo = repository_url("https://bitbucket.org/team/repo", Provider::Bitbucket).unwrap();
        let item = json!({"id": 3, "title": "Topic", "state": "OPEN", "links": {"html": {"href": "https://bitbucket.org/team/repo/pull-requests/3"}}, "source": {"branch": {"name": "topic"}}, "destination": {"branch": {"name": "main"}}});
        let without = json!({"pagelen": 50, "values": [item.clone()], "page": 1, "size": 1});
        let page = parse_list(&repo, &without, None).unwrap();
        assert_eq!(page.requests[0].source, "topic");
        assert_eq!(page.requests[0].target, "main");
        assert!(!page.truncated);
        let with = json!({"pagelen": 50, "values": [item.clone()], "next": "https://api.bitbucket.org/2.0/repositories/team/repo/pullrequests?page=2"});
        assert!(parse_list(&repo, &with, None).unwrap().truncated);
        assert!(parse_list(&repo, &json!({"value": [item]}), None).is_err());
    }

    #[test]
    fn github_and_gitlab_lists_are_arrays_with_header_or_full_page_truncation() {
        let github = repository_url("https://github.com/org/repo", Provider::Github).unwrap();
        let page = |n: usize| Value::Array((1..=n).map(github_item).collect());
        assert!(parse_list(&github, &page(50), None).unwrap().truncated);
        assert!(!parse_list(&github, &page(49), None).unwrap().truncated);
        // Headers are authoritative when present: a full last page is not truncated.
        assert!(
            !parse_list(&github, &page(50), Some(false))
                .unwrap()
                .truncated
        );
        assert!(parse_list(&github, &page(1), Some(true)).unwrap().truncated);
        assert!(parse_list(&github, &json!({"value": []}), None).is_err());

        let gitlab = repository_url("https://gitlab.com/team/project", Provider::Gitlab).unwrap();
        let mr = json!({"iid": 9, "title": "MR", "web_url": "https://gitlab.com/team/project/-/merge_requests/9", "source_branch": "topic", "target_branch": "main", "state": "opened"});
        let list = |n: usize| Value::Array(vec![mr.clone(); n]);
        let parsed = parse_list(&gitlab, &list(2), None).unwrap();
        assert_eq!(parsed.requests[0].id, "9");
        assert!(!parsed.truncated);
        assert!(parse_list(&gitlab, &list(50), None).unwrap().truncated);
        assert!(parse_list(&gitlab, &list(1), Some(true)).unwrap().truncated);
    }

    #[test]
    fn next_page_headers_are_provider_specific() {
        use reqwest::header::{HeaderMap, HeaderValue, LINK};
        let mut github = HeaderMap::new();
        assert_eq!(next_page_header(Provider::Github, &github), Some(false));
        github.insert(
            LINK,
            HeaderValue::from_static("<https://api.github.com/x?page=1>; rel=\"prev\""),
        );
        assert_eq!(next_page_header(Provider::Github, &github), Some(false));
        github.insert(LINK, HeaderValue::from_static("<https://api.github.com/x?page=1>; rel=\"prev\", <https://api.github.com/x?page=3>; rel=\"next\""));
        assert_eq!(next_page_header(Provider::Github, &github), Some(true));
        let mut gitlab = HeaderMap::new();
        gitlab.insert("x-next-page", HeaderValue::from_static(""));
        assert_eq!(next_page_header(Provider::Gitlab, &gitlab), Some(false));
        gitlab.insert("x-next-page", HeaderValue::from_static("2"));
        assert_eq!(next_page_header(Provider::Gitlab, &gitlab), Some(true));
        assert_eq!(next_page_header(Provider::AzureDevops, &gitlab), None);
        assert_eq!(next_page_header(Provider::Bitbucket, &gitlab), None);
    }
}
