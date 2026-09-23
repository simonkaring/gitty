use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Manager;
use tauri::{AppHandle, Emitter, State};

pub struct AskpassRegistry {
    pub requests: Mutex<HashMap<usize, std::sync::mpsc::Sender<Option<String>>>>,
    pub port: u16,
    pub token: String,
    pub script_path: std::path::PathBuf,
}

impl AskpassRegistry {
    pub fn new(port: u16, token: String, script_path: std::path::PathBuf) -> Self {
        Self {
            requests: Mutex::new(HashMap::new()),
            port,
            token,
            script_path,
        }
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

        for stream in listener.incoming() {
            if let Ok(mut stream) = stream {
                let registry = registry.clone();
                let app_handle = app_handle.clone();
                let token = token.clone();
                let request_id = request_counter.fetch_add(1, Ordering::SeqCst);

                std::thread::spawn(move || {
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                    let mut reader = BufReader::new(&stream);
                    let mut received_token = String::new();
                    if reader.read_line(&mut received_token).is_ok() {
                        if received_token.trim() != token {
                            return;
                        }

                        let mut prompt = String::new();
                        if reader.read_line(&mut prompt).is_ok() {
                            let prompt = prompt.trim_end().to_string();

                            let (tx, rx) = std::sync::mpsc::channel();
                            registry.requests.lock().unwrap().insert(request_id, tx);

                            #[derive(Clone, serde::Serialize)]
                            struct AskpassPromptPayload {
                                request_id: usize,
                                prompt: String,
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
        let _ = tx.send(password);
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

#[cfg(test)]
mod tests {
    use super::{encode_response, shell_quote};

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
}
