use crate::{
    dto::{Error, Result},
    provider_accounts::{AccountStore, Provider, ProviderAccount},
    repository::Service,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{io::Read, time::Duration};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPullRequest {
    pub id: String,
    pub title: String,
    pub url: String,
    pub source: String,
    pub target: String,
    pub state: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreatePullRequest {
    pub source: String,
    pub target: String,
    pub title: String,
    pub description: String,
}

struct ProviderRepository {
    provider: Provider,
    api: String,
    web: String,
}

fn repository_url(remote: &str, provider: Provider) -> Result<ProviderRepository> {
    let url = url::Url::parse(remote)
        .map_err(|_| Error::new("invalidRemote", "Use an HTTPS provider remote"))?;
    if url.scheme() != "https"
        || url.host_str() != Some(provider.host())
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
    let parts: Vec<_> = path.split('/').collect();
    if parts.iter().any(|part| {
        part.is_empty()
            || *part == "."
            || *part == ".."
            || part.contains('%')
            || part.contains('\\')
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
    let web = format!(
        "https://{}{}/",
        provider.host(),
        url.path().trim_end_matches('/')
    );
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

fn authorized(
    client: &reqwest::blocking::Client,
    method: reqwest::Method,
    api: &str,
    account: &ProviderAccount,
    token: &str,
) -> reqwest::blocking::RequestBuilder {
    let request = client.request(method, api);
    match account.provider {
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
    ) -> Result<Vec<ProviderPullRequest>> {
        let (account, token) = accounts.credential(account_id)?;
        let repository = self.provider_remote(handle, remote, &account)?;
        let api = match repository.provider {
            Provider::Github => format!("{}?state=open&per_page=50", repository.api),
            Provider::Gitlab => format!("{}?state=opened&per_page=50", repository.api),
            Provider::AzureDevops => {
                format!("{}&searchCriteria.status=active&$top=50", repository.api)
            }
            Provider::Bitbucket => format!("{}?state=OPEN&pagelen=50", repository.api),
        };
        let client = client()?;
        let result = response_json(
            authorized(&client, reqwest::Method::GET, &api, &account, &token)
                .send()
                .map_err(|_| Error::new("providerApi", "Could not contact provider"))?,
        )?;
        let entries = match repository.provider {
            Provider::AzureDevops | Provider::Bitbucket => &result["values"],
            _ => &result,
        };
        entries
            .as_array()
            .ok_or_else(|| Error::new("providerApi", "Invalid pull request list"))?
            .iter()
            .map(|item| convert(item, &repository))
            .collect()
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
}
