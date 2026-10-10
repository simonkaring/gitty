use crate::bridge::{self, ConnectionLimiter, DeadlineReader};
use std::collections::HashMap;
use std::io::{BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;
use tauri::{AppHandle, Emitter, State};

pub struct AskpassRegistry {
    requests: Mutex<HashMap<usize, PendingPrompt>>,
    active_tokens: Mutex<std::collections::HashSet<String>>,
    pub port: u16,
    pub token: String,
    pub script_path: std::path::PathBuf,
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

    pub fn registry(&self) -> &AskpassRegistry {
        self.registry
    }
}

impl Drop for AskpassGuard<'_> {
    fn drop(&mut self) {
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
            port,
            token,
            script_path,
        }
    }

    pub fn start_operation(&self) -> AskpassGuard<'_> {
        let token = uuid::Uuid::new_v4().to_string();
        self.active_tokens.lock().unwrap().insert(token.clone());
        AskpassGuard {
            registry: self,
            token,
        }
    }

    pub fn cancel_all(&self) {
        for (_, pending) in self.requests.lock().unwrap().drain() {
            let _ = pending.reply.send(None);
        }
        self.active_tokens.lock().unwrap().clear();
    }

    /// Removes the helper script. Best effort: the script lives in the shared
    /// temp directory and is only needed while this process can spawn Git.
    pub fn cleanup(&self) {
        let _ = std::fs::remove_file(&self.script_path);
    }
}

/// The unauthenticated token line (terminator included) is read before any
/// credential check, so it is kept far below anything legitimate (a UUID).
const MAX_TOKEN_LINE: u64 = 256;
const MAX_PROMPT_LINE: u64 = 4096;
const PROMPT_WAIT: Duration = Duration::from_secs(90);

#[derive(Clone, Copy)]
struct Limits {
    handshake: Duration,
    prompt_wait: Duration,
}

const LIMITS: Limits = Limits {
    handshake: bridge::HANDSHAKE_DEADLINE,
    prompt_wait: PROMPT_WAIT,
};

/// Serves one helper connection: `token\nprompt\n` in, a status-prefixed answer out.
fn handle_connection<F, E>(
    stream: TcpStream,
    registry: &AskpassRegistry,
    request_id: usize,
    limits: Limits,
    emit_prompt: F,
    emit_expired: E,
) where
    F: FnOnce(usize, String) -> Result<(), ()>,
    E: FnOnce(usize),
{
    let _ = stream.set_write_timeout(Some(bridge::WRITE_TIMEOUT));
    let deadline = Instant::now() + limits.handshake;
    let mut reader = BufReader::new(DeadlineReader::new(&stream, deadline));
    let Ok(received_token) = bridge::read_bounded_line(&mut reader, MAX_TOKEN_LINE) else {
        return;
    };
    let supplied = received_token.trim();
    if !registry.accepts(supplied) {
        return;
    }
    let Ok(prompt) = bridge::read_bounded_line(&mut reader, MAX_PROMPT_LINE) else {
        return;
    };
    let prompt = prompt.trim_end().to_string();

    let (tx, rx) = std::sync::mpsc::channel();
    {
        // Revalidate under the lock: the operation may have ended while reading.
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

    let mut writer = &stream;
    if emit_prompt(request_id, prompt).is_ok() {
        // The child process has a shorter read timeout. A dismissed or lost
        // prompt must not strand a thread.
        let response = rx.recv_timeout(limits.prompt_wait);
        if response.is_err() {
            emit_expired(request_id);
        }
        let _ = writer.write_all(&encode_response(response.ok().flatten()));
    } else {
        let _ = writer.write_all(&encode_response(None));
    }

    registry.requests.lock().unwrap().remove(&request_id);
}

impl AskpassRegistry {
    fn accepts(&self, supplied: &str) -> bool {
        supplied == self.token || self.active_tokens.lock().unwrap().contains(supplied)
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
    bridge::remove_stale_helpers(&tmp_dir, "gitty-askpass-", bridge::STALE_HELPER_AGE);
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

    let registry = Arc::new(AskpassRegistry::new(port, token, script_path));
    app.manage(registry.clone());

    let app_handle = app.clone();

    std::thread::spawn(move || {
        bridge::serve(
            listener,
            ConnectionLimiter::new(bridge::MAX_CONNECTIONS),
            move |stream, request_id| {
                let prompt_app = app_handle.clone();
                let expired_app = app_handle.clone();
                handle_connection(
                    stream,
                    &registry,
                    request_id,
                    LIMITS,
                    move |request_id, prompt| {
                        prompt_app
                            .emit(
                                "git_askpass_prompt",
                                AskpassPromptPayload { request_id, prompt },
                            )
                            .map_err(|_| ())
                    },
                    move |request_id| {
                        let _ = expired_app.emit("git_askpass_expired", request_id);
                    },
                );
            },
        );
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
        encode_response, handle_connection, shell_quote, wsl_env_mapping, AskpassPromptPayload,
        AskpassRegistry, Limits,
    };
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{mpsc, Arc};
    use std::time::{Duration, Instant};

    const TEST_LIMITS: Limits = Limits {
        handshake: Duration::from_millis(300),
        prompt_wait: Duration::from_secs(5),
    };

    /// Runs one `handle_connection` on a real loopback socket. Returns the client
    /// stream, a receiver of emitted prompts and a handle yielding the elapsed time.
    fn serve_once(
        registry: Arc<AskpassRegistry>,
        limits: Limits,
    ) -> (
        TcpStream,
        mpsc::Receiver<(usize, String)>,
        std::thread::JoinHandle<Duration>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (prompts, received) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let started = Instant::now();
            handle_connection(
                stream,
                &registry,
                1,
                limits,
                |id, prompt| prompts.send((id, prompt)).map_err(|_| ()),
                |_| {},
            );
            started.elapsed()
        });
        let client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        (client, received, server)
    }

    fn registry() -> Arc<AskpassRegistry> {
        Arc::new(AskpassRegistry::new(0, "app-token".into(), "helper".into()))
    }

    #[test]
    fn oversize_unauthenticated_token_is_rejected_without_a_prompt() {
        for payload in [
            // Terminated but far beyond a token.
            format!("{}\nPassword:\n", "a".repeat(300)).into_bytes(),
            // Unterminated and unbounded in intent.
            vec![b'a'; 64 * 1024],
        ] {
            let (mut client, prompts, server) = serve_once(registry(), TEST_LIMITS);
            let _ = client.write_all(&payload);
            let mut reply = Vec::new();
            let _ = client.read_to_end(&mut reply);
            assert!(reply.is_empty(), "no response to an unauthenticated peer");
            server.join().unwrap();
            assert!(prompts.try_recv().is_err(), "no prompt event");
        }
    }

    #[test]
    fn oversize_prompt_is_rejected_after_authentication() {
        let registry = registry();
        let (mut client, prompts, server) = serve_once(registry.clone(), TEST_LIMITS);
        let _ = client.write_all(format!("app-token\n{}\n", "p".repeat(5000)).as_bytes());
        let mut reply = Vec::new();
        let _ = client.read_to_end(&mut reply);
        server.join().unwrap();
        assert!(reply.is_empty());
        assert!(prompts.try_recv().is_err());
        assert!(registry.requests.lock().unwrap().is_empty());
    }

    #[test]
    fn idle_connection_is_closed_by_the_handshake_deadline() {
        let (mut client, prompts, server) = serve_once(registry(), TEST_LIMITS);
        let mut reply = Vec::new();
        // Sends nothing; the server must hang up on its own.
        client.read_to_end(&mut reply).unwrap();
        let elapsed = server.join().unwrap();
        assert!(elapsed >= Duration::from_millis(250), "{elapsed:?}");
        assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
        assert!(prompts.try_recv().is_err());
    }

    #[test]
    fn slow_dribbling_client_cannot_outlive_the_absolute_deadline() {
        let (mut client, prompts, server) = serve_once(registry(), TEST_LIMITS);
        let writer = std::thread::spawn(move || {
            // Each byte arrives well inside any per-read timeout, but the line
            // never completes.
            for _ in 0..100 {
                if client.write_all(b"a").is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        let elapsed = server.join().unwrap();
        assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
        assert!(prompts.try_recv().is_err());
        writer.join().unwrap();
    }

    #[test]
    fn valid_app_and_scoped_tokens_still_prompt_and_reply() {
        let registry = registry();
        let scoped = registry.start_operation();
        for token in ["app-token".to_string(), scoped.token().to_string()] {
            let (mut client, prompts, server) = serve_once(registry.clone(), TEST_LIMITS);
            client
                .write_all(format!("{token}\nPassword for example\n").as_bytes())
                .unwrap();
            let (id, prompt) = prompts.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(prompt, "Password for example");
            registry
                .requests
                .lock()
                .unwrap()
                .remove(&id)
                .unwrap()
                .reply
                .send(Some("secret ".into()))
                .unwrap();
            let mut reply = Vec::new();
            client.read_to_end(&mut reply).unwrap();
            assert_eq!(reply, b"1secret ");
            server.join().unwrap();
        }
    }

    #[test]
    fn unknown_token_gets_no_prompt() {
        let (mut client, prompts, server) = serve_once(registry(), TEST_LIMITS);
        client.write_all(b"guess\nPassword:\n").unwrap();
        let mut reply = Vec::new();
        let _ = client.read_to_end(&mut reply);
        server.join().unwrap();
        assert!(reply.is_empty());
        assert!(prompts.try_recv().is_err());
    }

    #[test]
    fn native_askpass_env_carries_a_scoped_token_that_dies_with_the_guard() {
        let registry = AskpassRegistry::new(4521, "app-token".into(), "helper".into());
        let token = {
            let guard = registry.start_operation();
            let (_, env) = crate::remote::network_args(true, Some(&guard));
            let token = env
                .iter()
                .find(|(key, _)| key == "GITTY_ASKPASS_TOKEN")
                .map(|(_, value)| value.clone())
                .expect("interactive native actions pass an askpass token");
            assert_ne!(token, registry.token, "never the app-lifetime token");
            assert_eq!(token, guard.token());
            assert!(registry.active_tokens.lock().unwrap().contains(&token));
            assert!(!env.iter().any(|(_, value)| value == "app-token"));
            token
        };
        assert!(!registry.active_tokens.lock().unwrap().contains(&token));
        assert!(!registry.accepts(&token));
    }

    #[test]
    fn cleanup_removes_the_helper_script_and_tolerates_absence() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("gitty-askpass-test.sh");
        std::fs::write(&script, "#!/bin/sh\n").unwrap();
        let registry = AskpassRegistry::new(1, "t".into(), script.clone());
        registry.cleanup();
        assert!(!script.exists());
        registry.cleanup();
    }

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
