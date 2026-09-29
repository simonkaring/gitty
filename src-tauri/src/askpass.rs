use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Manager;
use tauri::{AppHandle, Emitter, State};

pub struct AskpassRegistry {
    requests: Mutex<HashMap<usize, PendingPrompt>>,
    active_tokens: Mutex<std::collections::HashSet<String>>,
    credentials: Mutex<HashMap<String, ScopedCredential>>,
    pub port: u16,
    pub token: String,
    pub script_path: std::path::PathBuf,
}

struct ScopedCredential {
    host: String,
    username: String,
    password: String,
}

fn credential_prompt<'a>(prompt: &str, credential: &'a ScopedCredential) -> Option<&'a str> {
    let (kind, target) = prompt.split_once(" for '")?;
    let target = target.strip_suffix("':")?;
    let url = url::Url::parse(target).ok()?;
    if url.scheme() != "https"
        || url.host_str() != Some(&credential.host)
        || url.port().is_some()
        || url.password().is_some()
        || (!url.username().is_empty() && url.username() != credential.username)
    {
        return None;
    }
    match kind {
        "Username" => Some(&credential.username),
        "Password" => Some(&credential.password),
        _ => None,
    }
}

struct PendingPrompt {
    token: String,
    reply: std::sync::mpsc::Sender<Option<String>>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AskpassPromptPayload {
    request_id: usize,
    prompt: String,
}

pub struct AskpassGuard<'a> {
    registry: &'a AskpassRegistry,
    token: String,
}

impl AskpassGuard<'_> {
    pub fn token(&self) -> &str {
        &self.token
    }
}

impl Drop for AskpassGuard<'_> {
    fn drop(&mut self) {
        self.registry
            .credentials
            .lock()
            .unwrap()
            .remove(&self.token);
        self.registry
            .active_tokens
            .lock()
            .unwrap()
            .remove(&self.token);
        let mut pending = self.registry.requests.lock().unwrap();
        pending.retain(|_, prompt| {
            if prompt.token != self.token {
                return true;
            }
            let _ = prompt.reply.send(None);
            false
        });
    }
}

impl AskpassRegistry {
    pub fn new(port: u16, token: String, script_path: std::path::PathBuf) -> Self {
        Self {
            requests: Mutex::new(HashMap::new()),
            active_tokens: Mutex::new(std::collections::HashSet::new()),
            credentials: Mutex::new(HashMap::new()),
            port,
            token,
            script_path,
        }
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn start_operation(&self) -> AskpassGuard<'_> {
        let token = uuid::Uuid::new_v4().to_string();
        self.active_tokens.lock().unwrap().insert(token.clone());
        AskpassGuard {
            registry: self,
            token,
        }
    }

    pub fn start_credential_operation(
        &self,
        host: &str,
        username: String,
        password: String,
    ) -> AskpassGuard<'_> {
        let guard = self.start_operation();
        self.credentials.lock().unwrap().insert(
            guard.token.clone(),
            ScopedCredential {
                host: host.into(),
                username,
                password,
            },
        );
        guard
    }

    pub fn cancel_all(&self) {
        for (_, pending) in self.requests.lock().unwrap().drain() {
            let _ = pending.reply.send(None);
        }
        self.active_tokens.lock().unwrap().clear();
        self.credentials.lock().unwrap().clear();
    }
}

pub fn init(app: AppHandle) -> std::io::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();

    // The token authorizes local helper processes to submit a prompt.
    let token = uuid::Uuid::new_v4().to_string();

    // A unique, exclusively created file avoids overwriting another process's
    // askpass script (or following a pre-existing symlink in the temp directory).
    let tmp_dir = std::env::temp_dir();
    let script_id = uuid::Uuid::new_v4();
    let script_path = if cfg!(windows) {
        tmp_dir.join(format!("gitty-askpass-{script_id}.bat"))
    } else {
        tmp_dir.join(format!("gitty-askpass-{script_id}.sh"))
    };

    let current_exe = std::env::current_exe()?;

    let script = if cfg!(windows) {
        format!("@echo off\n\"{}\" askpass %*", current_exe.display())
    } else {
        format!(
            "#!/bin/sh\nexec {} askpass \"$@\"",
            shell_quote(&current_exe.to_string_lossy())
        )
    };
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&script_path)?;
    file.write_all(script.as_bytes())?;
    if !cfg!(windows) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&script_path)?.permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&script_path, perms)?;
        }
    }

    let registry = Arc::new(AskpassRegistry::new(port, token.clone(), script_path));
    app.manage(registry.clone());

    let app_handle = app.clone();

    std::thread::spawn(move || {
        let request_counter = AtomicUsize::new(1);

        for mut stream in listener.incoming().flatten() {
            let registry = registry.clone();
            let app_handle = app_handle.clone();
            let token = token.clone();
            let request_id = request_counter.fetch_add(1, Ordering::SeqCst);

            std::thread::spawn(move || {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut reader = BufReader::new(&stream);
                let mut received_token = String::new();
                if reader.read_line(&mut received_token).is_ok() {
                    let supplied = received_token.trim();
                    if supplied != token
                        && !registry.active_tokens.lock().unwrap().contains(supplied)
                    {
                        return;
                    }

                    let mut prompt = String::new();
                    if reader.read_line(&mut prompt).is_ok() {
                        let prompt = prompt.trim_end().to_string();

                        // Only a prompt for the exact HTTPS host selected for
                        // this operation may receive a stored credential. Git
                        // redirects or other subprocesses must not receive it.
                        if let Some(credential) = registry.credentials.lock().unwrap().get(supplied)
                        {
                            let answer = credential_prompt(&prompt, credential).map(String::from);
                            let _ = stream.write_all(&encode_response(answer));
                            return;
                        }

                        let (tx, rx) = std::sync::mpsc::channel();
                        {
                            let active = registry.active_tokens.lock().unwrap();
                            if supplied != registry.token && !active.contains(supplied) {
                                return;
                            }
                            registry.requests.lock().unwrap().insert(
                                request_id,
                                PendingPrompt {
                                    token: supplied.to_string(),
                                    reply: tx,
                                },
                            );
                        }

                        if app_handle
                            .emit(
                                "git_askpass_prompt",
                                AskpassPromptPayload { request_id, prompt },
                            )
                            .is_ok()
                        {
                            // The child process has a shorter read timeout. A
                            // dismissed or lost prompt must not strand a thread.
                            let response = rx.recv_timeout(Duration::from_secs(90));
                            if response.is_err() {
                                let _ = app_handle.emit("git_askpass_expired", request_id);
                            }
                            let _ = stream.write_all(&encode_response(response.ok().flatten()));
                        }

                        registry.requests.lock().unwrap().remove(&request_id);
                    }
                }
            });
        }
    });

    Ok(())
}

#[tauri::command]
pub fn repository_provide_password(
    registry: State<'_, Arc<AskpassRegistry>>,
    request_id: usize,
    password: Option<String>,
) -> Result<(), String> {
    if let Some(tx) = registry.requests.lock().unwrap().remove(&request_id) {
        let _ = tx.reply.send(password);
        Ok(())
    } else {
        Err("Invalid request ID".into())
    }
}

// A one-byte status prefix distinguishes cancellation from a valid empty answer;
// the remainder is the exact credential, including any trailing whitespace.
fn encode_response(answer: Option<String>) -> Vec<u8> {
    match answer {
        Some(value) => [b"1".as_slice(), value.as_bytes()].concat(),
        None => b"0".to_vec(),
    }
}

pub(crate) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// WSL interoperability runs the Windows app executable on the Windows host,
/// so its existing loopback prompt server remains reachable without WSL2
/// network/localhost forwarding assumptions.
#[cfg(windows)]
pub(crate) fn wsl_executable_path(distribution: &str) -> crate::dto::Result<String> {
    crate::process::validate_distribution(distribution)?;
    let exe = std::env::current_exe()?;
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.args(["--distribution", distribution, "--exec", "wslpath", "-u"])
        .arg(exe);
    let result = crate::process::run_for(cmd, crate::process::CHECK_TIMEOUT)?;
    if !result.success {
        return Err(crate::dto::Error::new("unsupportedOperation", "WSL interop could not translate the Gitty executable path; use a Linux credential helper or SSH agent."));
    }
    let path = crate::process::text(result.stdout)?.trim().to_string();
    if !path.starts_with('/') || path.chars().any(|ch| matches!(ch, '\n' | '\r' | '\0')) {
        return Err(crate::dto::Error::new(
            "unsupportedOperation",
            "WSL returned an invalid Gitty executable path.",
        ));
    }
    Ok(path)
}

pub(crate) const WSL_ASKPASS_ENV: [&str; 6] = [
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "SSH_ASKPASS_REQUIRE",
    "DISPLAY",
    "GITTY_ASKPASS_PORT",
    "GITTY_ASKPASS_TOKEN",
];

pub(crate) fn wsl_env_mapping(previous: Option<&str>) -> String {
    let mut parts = previous
        .unwrap_or_default()
        .split(':')
        .filter(|part| !part.is_empty())
        .map(String::from)
        .collect::<Vec<_>>();
    for key in WSL_ASKPASS_ENV {
        parts.retain(|part| part.split('/').next() != Some(key));
        parts.push(key.into());
    }
    parts.join(":")
}

#[cfg(test)]
mod tests {
    use super::{
        encode_response, shell_quote, wsl_env_mapping, AskpassPromptPayload, AskpassRegistry,
    };

    #[test]
    fn prompt_event_uses_command_request_id_name() {
        assert_eq!(
            serde_json::to_value(AskpassPromptPayload {
                request_id: 7,
                prompt: "Username for example".into(),
            })
            .unwrap(),
            serde_json::json!({ "requestId": 7, "prompt": "Username for example" })
        );
    }

    #[test]
    fn scoped_credentials_match_only_the_selected_https_host_and_user() {
        let credential = super::ScopedCredential {
            host: "github.com".into(),
            username: "alice".into(),
            password: "token".into(),
        };
        assert_eq!(
            super::credential_prompt("Username for 'https://github.com':", &credential),
            Some("alice")
        );
        assert_eq!(
            super::credential_prompt("Password for 'https://alice@github.com':", &credential),
            Some("token")
        );
        for prompt in [
            "Password for 'https://github.com.evil.test':",
            "Password for 'http://github.com':",
            "Password for 'https://bob@github.com':",
            "Password for 'https://github.com:1234':",
        ] {
            assert_eq!(super::credential_prompt(prompt, &credential), None);
        }
    }

    #[test]
    fn scoped_credentials_disappear_with_the_git_operation() {
        let registry = AskpassRegistry::new(4521, "app-token".into(), "unused".into());
        let operation_token = {
            let guard = registry.start_credential_operation(
                "github.com",
                "alice".into(),
                "private-token".into(),
            );
            assert_eq!(
                super::credential_prompt(
                    "Password for 'https://alice@github.com':",
                    registry
                        .credentials
                        .lock()
                        .unwrap()
                        .get(guard.token())
                        .unwrap(),
                ),
                Some("private-token"),
            );
            guard.token().to_owned()
        };
        assert!(!registry
            .active_tokens
            .lock()
            .unwrap()
            .contains(&operation_token));
        assert!(!registry
            .credentials
            .lock()
            .unwrap()
            .contains_key(&operation_token));
    }

    #[test]
    fn responses_preserve_whitespace_and_distinguish_cancel() {
        assert_eq!(encode_response(Some("secret \n".into())), b"1secret \n");
        assert_eq!(encode_response(Some(String::new())), b"1");
        assert_eq!(encode_response(None), b"0");
    }

    #[test]
    fn quotes_helper_paths_containing_spaces_or_apostrophes() {
        assert_eq!(
            shell_quote("/some path/app's helper"),
            "'/some path/app'\\''s helper'"
        );
    }

    #[test]
    fn wsl_operation_tokens_expire_and_env_mapping_preserves_existing_entries() {
        let registry = AskpassRegistry::new(12, "app-token".into(), "helper".into());
        let token = {
            let guard = registry.start_operation();
            assert!(registry
                .active_tokens
                .lock()
                .unwrap()
                .contains(guard.token()));
            guard.token().to_string()
        };
        assert!(!registry.active_tokens.lock().unwrap().contains(&token));
        let mapped = wsl_env_mapping(Some("CUSTOM/p:GITTY_ASKPASS_TOKEN/w"));
        assert!(mapped.starts_with("CUSTOM/p:"));
        assert_eq!(mapped.matches("GITTY_ASKPASS_TOKEN").count(), 1);
        assert!(!mapped.contains("GITTY_ASKPASS_TOKEN/w"));
        assert!(mapped.contains("SSH_ASKPASS_REQUIRE"));
    }
}
