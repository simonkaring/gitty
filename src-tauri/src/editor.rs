use crate::bridge::{self, ConnectionLimiter, DeadlineReader};
use crate::operation_dto::RebaseStep;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;
use tauri::{AppHandle, Emitter, State};

pub struct EditorRegistry {
    requests: Mutex<HashMap<usize, PendingRequest>>,
    pub port: u16,
    pub token: String,
    pub script_path: PathBuf,
    active_mutations: Mutex<HashMap<String, ActiveMutation>>,
}

struct PendingRequest {
    token: String,
    sender: std::sync::mpsc::Sender<Option<String>>,
}

struct ActiveMutation {
    git_dir: PathBuf,
    common_dir: PathBuf,
    plan: Option<Vec<RebaseStep>>,
}

pub struct ActiveMutationGuard<'a> {
    registry: &'a EditorRegistry,
    token: String,
}

impl ActiveMutationGuard<'_> {
    pub fn token(&self) -> &str {
        &self.token
    }
}

impl<'a> Drop for ActiveMutationGuard<'a> {
    fn drop(&mut self) {
        let mut active = self.registry.active_mutations.lock().unwrap();
        active.remove(&self.token);
        let mut reqs = self.registry.requests.lock().unwrap();
        reqs.retain(|_, request| {
            if request.token != self.token {
                return true;
            }
            let _ = request.sender.send(None);
            false
        });
    }
}

impl EditorRegistry {
    pub fn new(port: u16, token: String, script_path: PathBuf) -> Self {
        Self {
            requests: Mutex::new(HashMap::new()),
            port,
            token,
            script_path,
            active_mutations: Mutex::new(HashMap::new()),
        }
    }

    pub fn cancel_all(&self) {
        let mut reqs = self.requests.lock().unwrap();
        for (_, request) in reqs.drain() {
            let _ = request.sender.send(None);
        }
    }

    /// Removes the helper script. Best effort: the script lives in the shared
    /// temp directory and is only needed while this process can spawn Git.
    pub fn cleanup(&self) {
        let _ = fs::remove_file(&self.script_path);
    }

    pub fn reply(&self, request_id: usize, content: Option<String>) -> Result<(), String> {
        if let Some(request) = self.requests.lock().unwrap().remove(&request_id) {
            let _ = request.sender.send(content);
            Ok(())
        } else {
            Err("Invalid or expired request ID".into())
        }
    }

    pub fn start_mutation(&self, git_dir: &str, common_dir: &str) -> ActiveMutationGuard<'_> {
        self.start_with_plan(git_dir, common_dir, None)
    }

    pub fn start_with_plan(
        &self,
        git_dir: &str,
        common_dir: &str,
        plan: Option<Vec<RebaseStep>>,
    ) -> ActiveMutationGuard<'_> {
        let token = format!("{}:{}", self.token, uuid::Uuid::new_v4());
        self.active_mutations.lock().unwrap().insert(
            token.clone(),
            ActiveMutation {
                git_dir: fs::canonicalize(git_dir).unwrap_or_else(|_| PathBuf::from(git_dir)),
                common_dir: fs::canonicalize(common_dir)
                    .unwrap_or_else(|_| PathBuf::from(common_dir)),
                plan,
            },
        );
        ActiveMutationGuard {
            registry: self,
            token,
        }
    }
}

pub fn init(app: AppHandle) -> std::io::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();

    let token = uuid::Uuid::new_v4().to_string();

    let tmp_dir = std::env::temp_dir();
    bridge::remove_stale_helpers(&tmp_dir, "gitty-editor-", bridge::STALE_HELPER_AGE);
    let script_id = uuid::Uuid::new_v4();
    let script_path = if cfg!(windows) {
        tmp_dir.join(format!("gitty-editor-{script_id}.bat"))
    } else {
        tmp_dir.join(format!("gitty-editor-{script_id}.sh"))
    };

    let current_exe = std::env::current_exe()?;

    let script = if cfg!(windows) {
        format!("@echo off\n\"{}\" editor %*", current_exe.display())
    } else {
        format!(
            "#!/bin/sh\nexec {} editor \"$@\"",
            crate::askpass::shell_quote(&current_exe.to_string_lossy())
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

    let registry = Arc::new(EditorRegistry::new(port, token.clone(), script_path));
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
                    move |req_id, file_name, content| {
                        #[derive(Clone, serde::Serialize)]
                        #[serde(rename_all = "camelCase")]
                        struct EditorPromptPayload {
                            request_id: usize,
                            file_name: String,
                            content: String,
                        }
                        prompt_app
                            .emit(
                                "editor_prompt",
                                EditorPromptPayload {
                                    request_id: req_id,
                                    file_name,
                                    content,
                                },
                            )
                            .map_err(|_| ())
                    },
                    move |req_id| {
                        let _ = expired_app.emit("editor_expired", req_id);
                    },
                );
            },
        );
    });

    Ok(())
}

pub(crate) fn handle_connection<F, E>(
    stream: std::net::TcpStream,
    registry: &Arc<EditorRegistry>,
    request_id: usize,
    emit_prompt: F,
    emit_expired: E,
) where
    F: FnOnce(usize, String, String) -> Result<(), ()>,
    E: FnOnce(usize),
{
    handle_connection_within(
        stream,
        registry,
        request_id,
        bridge::HANDSHAKE_DEADLINE,
        emit_prompt,
        emit_expired,
    );
}

/// `handshake` is the absolute time the client has to send its framed request.
fn handle_connection_within<F, E>(
    mut stream: std::net::TcpStream,
    registry: &Arc<EditorRegistry>,
    request_id: usize,
    handshake: Duration,
    emit_prompt: F,
    emit_expired: E,
) where
    F: FnOnce(usize, String, String) -> Result<(), ()>,
    E: FnOnce(usize),
{
    let _ = stream.set_write_timeout(Some(bridge::WRITE_TIMEOUT));
    let mut len_buf = [0u8; 4];
    let (token_buf, path_buf);
    {
        let mut reader = DeadlineReader::new(&stream, Instant::now() + handshake);
        // Read token length
        if reader.read_exact(&mut len_buf).is_err() {
            return;
        }
        let token_len = u32::from_be_bytes(len_buf) as usize;
        if token_len == 0 || token_len > 128 {
            return;
        }
        let mut buf = vec![0u8; token_len];
        if reader.read_exact(&mut buf).is_err() {
            return;
        }
        token_buf = buf;

        // Read path length
        if reader.read_exact(&mut len_buf).is_err() {
            return;
        }
        let path_len = u32::from_be_bytes(len_buf) as usize;
        if path_len == 0 || path_len > 4096 {
            return;
        }
        let mut buf = vec![0u8; path_len];
        if reader.read_exact(&mut buf).is_err() {
            return;
        }
        path_buf = buf;
    }
    let request_token = match String::from_utf8(token_buf) {
        Ok(token) => token,
        Err(_) => return,
    };
    let raw_path = match String::from_utf8(path_buf) {
        Ok(p) => p,
        Err(_) => {
            let _ = stream.write_all(b"0");
            return;
        }
    };
    // Authenticate against this specific mutation, not another repository's
    // concurrently running rebase.
    let (expected_git_dir, expected_common_dir, plan) = {
        let active = registry.active_mutations.lock().unwrap();
        match active.get(&request_token) {
            Some(m) => (m.git_dir.clone(), m.common_dir.clone(), m.plan.clone()),
            None => {
                let _ = stream.write_all(b"0");
                return;
            }
        }
    };

    // Path validation
    let file_path = Path::new(&raw_path);
    let symlink_meta = match fs::symlink_metadata(file_path) {
        Ok(m) => m,
        Err(_) => {
            let _ = stream.write_all(b"0");
            return;
        }
    };
    if symlink_meta.file_type().is_symlink() || !symlink_meta.is_file() {
        let _ = stream.write_all(b"0");
        return;
    }
    let canonical_path = match fs::canonicalize(file_path) {
        Ok(c) => c,
        Err(_) => {
            let _ = stream.write_all(b"0");
            return;
        }
    };
    if !canonical_path.starts_with(&expected_git_dir)
        && !canonical_path.starts_with(&expected_common_dir)
    {
        let _ = stream.write_all(b"0");
        return;
    }

    let file_name = match canonical_path.file_name().and_then(|n| n.to_str()) {
        Some(name) => name,
        None => {
            let _ = stream.write_all(b"0");
            return;
        }
    };
    let allowed = match file_name {
        "COMMIT_EDITMSG" => {
            canonical_path.parent() == Some(expected_git_dir.as_path())
                || canonical_path.parent() == Some(expected_common_dir.as_path())
        }
        "message" | "final-commit" => {
            canonical_path.parent() == Some(expected_git_dir.join("rebase-merge").as_path())
        }
        "git-rebase-todo" => {
            plan.is_some()
                && canonical_path.parent() == Some(expected_git_dir.join("rebase-merge").as_path())
        }
        _ => false,
    };
    if !allowed {
        let _ = stream.write_all(b"0");
        return;
    }

    let dir = match cap_std::fs::Dir::open_ambient_dir(
        canonical_path.parent().unwrap(),
        cap_std::ambient_authority(),
    ) {
        Ok(dir) => dir,
        Err(_) => {
            let _ = stream.write_all(b"0");
            return;
        }
    };
    let initial = match read_message(&dir, file_name) {
        Ok(snapshot) => snapshot,
        Err(_) => {
            let _ = stream.write_all(b"0");
            return;
        }
    };
    if initial.bytes.len() > 256 * 1024 {
        let _ = stream.write_all(b"0");
        return;
    }

    if initial.bytes.contains(&0) {
        let _ = stream.write_all(b"0");
        return;
    }
    let content_str = match String::from_utf8(initial.bytes.clone()) {
        Ok(s) => s,
        Err(_) => {
            let _ = stream.write_all(b"0");
            return;
        }
    };

    if file_name == "git-rebase-todo" {
        let result = plan
            .as_deref()
            .and_then(|steps| rewrite_todo(&content_str, steps))
            .and_then(|todo| save_message(&dir, file_name, &initial, todo.as_bytes()).ok());
        let _ = stream.write_all(if result.is_some() { b"1" } else { b"0" });
        return;
    }

    let (tx, rx) = std::sync::mpsc::channel();
    {
        let active = registry.active_mutations.lock().unwrap();
        if !active.contains_key(&request_token) {
            let _ = stream.write_all(b"0");
            return;
        }
        registry.requests.lock().unwrap().insert(
            request_id,
            PendingRequest {
                token: request_token,
                sender: tx,
            },
        );
    }

    if emit_prompt(request_id, file_name.to_string(), content_str).is_ok() {
        let response = rx.recv_timeout(Duration::from_secs(90));
        match response {
            Ok(Some(new_content)) => {
                if new_content.len() > 256 * 1024 || new_content.as_bytes().contains(&0) {
                    let _ = stream.write_all(b"0");
                } else {
                    if save_message(&dir, file_name, &initial, new_content.as_bytes()).is_ok() {
                        let _ = stream.write_all(b"1");
                    } else {
                        let _ = stream.write_all(b"0");
                    }
                }
            }
            Ok(None) => {
                // User cancelled
                let _ = stream.write_all(b"0");
            }
            Err(_) => {
                // Expired or disconnected
                emit_expired(request_id);
                let _ = stream.write_all(b"0");
            }
        }
    } else {
        let _ = stream.write_all(b"0");
    }

    registry.requests.lock().unwrap().remove(&request_id);
}

/// Only transform the exact pick list produced by Git. Never accept executable
/// directives or silently omit a commit missing from the reviewed plan.
fn rewrite_todo(original: &str, steps: &[RebaseStep]) -> Option<String> {
    let mut picks = HashMap::new();
    let mut comments = String::new();
    for line in original.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            comments.push_str(line);
            comments.push('\n');
            continue;
        }
        let mut fields = line.split_whitespace();
        if fields.next()? != "pick" {
            return None;
        }
        let abbreviated = fields.next()?;
        let matching: Vec<_> = steps
            .iter()
            .filter(|step| step.oid.starts_with(abbreviated))
            .collect();
        if matching.len() != 1 || picks.insert(matching[0].oid.clone(), line).is_some() {
            return None;
        }
    }
    if picks.len() != steps.len() {
        return None;
    }
    let mut result = String::new();
    for step in steps {
        let line = picks.get(&step.oid)?;
        let suffix = line.split_once(' ')?.1;
        result.push_str(step.instruction.git());
        result.push(' ');
        result.push_str(suffix);
        result.push('\n');
    }
    result.push_str(&comments);
    Some(result)
}

struct MessageSnapshot {
    bytes: Vec<u8>,
    metadata: cap_std::fs::Metadata,
}

fn read_message(dir: &cap_std::fs::Dir, name: &str) -> std::io::Result<MessageSnapshot> {
    let metadata = dir.symlink_metadata(name)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 256 * 1024 {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    let mut bytes = Vec::new();
    dir.open(name)?
        .take(256 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 256 * 1024 {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    Ok(MessageSnapshot { bytes, metadata })
}

fn save_message(
    dir: &cap_std::fs::Dir,
    name: &str,
    initial: &MessageSnapshot,
    bytes: &[u8],
) -> std::io::Result<()> {
    let current = read_message(dir, name)?;
    if current.bytes != initial.bytes || !same_file(&current.metadata, &initial.metadata) {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    // A pinned parent directory and atomic replacement never follow a symlink
    // introduced after the snapshot. The temporary file is exclusively owned.
    let temporary = format!(".gitty-editor-{}", uuid::Uuid::new_v4());
    let result = (|| {
        let mut opts = cap_std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        let mut file = dir.open_with(&temporary, &opts)?;
        file.write_all(bytes)?;
        file.set_permissions(initial.metadata.permissions())?;
        file.sync_all()?;
        let current = read_message(dir, name)?;
        if current.bytes != initial.bytes || !same_file(&current.metadata, &initial.metadata) {
            return Err(std::io::ErrorKind::InvalidData.into());
        }
        dir.rename(&temporary, dir, name)
    })();
    let _ = dir.remove_file(&temporary);
    result
}

#[cfg(unix)]
fn same_file(a: &cap_std::fs::Metadata, b: &cap_std::fs::Metadata) -> bool {
    use cap_std::fs::MetadataExt;
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
}

#[cfg(not(unix))]
fn same_file(a: &cap_std::fs::Metadata, b: &cap_std::fs::Metadata) -> bool {
    a.len() == b.len() && a.modified().ok() == b.modified().ok()
}

#[tauri::command]
pub fn editor_reply(
    registry: State<'_, Arc<EditorRegistry>>,
    request_id: usize,
    content: Option<String>,
) -> Result<(), String> {
    registry.reply(request_id, content)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::operation_dto::RebaseInstruction;
    use std::net::TcpStream;

    #[test]
    fn sequence_editor_reorders_only_the_exact_git_generated_pick_list() {
        let steps = vec![
            RebaseStep {
                oid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
                instruction: RebaseInstruction::Pick,
            },
            RebaseStep {
                oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
                instruction: RebaseInstruction::Fixup,
            },
        ];
        let original = "pick aaaaaaa first\npick bbbbbbb second\n\n# Git instructions\n";
        assert_eq!(
            rewrite_todo(original, &steps).unwrap(),
            "pick bbbbbbb second\nfixup aaaaaaa first\n\n# Git instructions\n"
        );
        assert!(rewrite_todo("exec dangerous\n", &steps).is_none());
        assert!(rewrite_todo("pick aaaaaaa first\n", &steps).is_none());
        assert!(rewrite_todo("pick aaaaaaa first\npick aaaaaaa duplicate\n", &steps).is_none());
    }

    fn send_request(port: u16, token: &str, path: &str) -> std::io::Result<u8> {
        let mut stream = TcpStream::connect(("127.0.0.1", port))?;
        let token_bytes = token.as_bytes();
        let path_bytes = path.as_bytes();

        let mut msg = Vec::new();
        msg.extend_from_slice(&(token_bytes.len() as u32).to_be_bytes());
        msg.extend_from_slice(token_bytes);
        msg.extend_from_slice(&(path_bytes.len() as u32).to_be_bytes());
        msg.extend_from_slice(path_bytes);

        stream.write_all(&msg)?;
        let mut resp = [0u8; 1];
        stream.read_exact(&mut resp)?;
        Ok(resp[0])
    }

    /// Serves one connection with a short handshake deadline and reports how long
    /// the handler ran and whether it ever asked for a prompt.
    fn serve_with_deadline(
        deadline: Duration,
    ) -> (
        TcpStream,
        std::thread::JoinHandle<(Duration, bool)>,
        Arc<EditorRegistry>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let registry = Arc::new(EditorRegistry::new(port, "t".into(), PathBuf::from("s")));
        let served = registry.clone();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let started = Instant::now();
            let mut prompted = false;
            handle_connection_within(
                stream,
                &served,
                1,
                deadline,
                |_, _, _| {
                    prompted = true;
                    Err(())
                },
                |_| {},
            );
            (started.elapsed(), prompted)
        });
        let client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        (client, server, registry)
    }

    #[test]
    fn idle_editor_connection_is_closed_by_the_handshake_deadline() {
        let (mut client, server, _registry) = serve_with_deadline(Duration::from_millis(300));
        let mut reply = Vec::new();
        client.read_to_end(&mut reply).unwrap();
        let (elapsed, prompted) = server.join().unwrap();
        assert!(elapsed >= Duration::from_millis(250), "{elapsed:?}");
        assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
        assert!(!prompted);
    }

    #[test]
    fn dribbling_editor_connection_cannot_outlive_the_absolute_deadline() {
        let (mut client, server, _registry) = serve_with_deadline(Duration::from_millis(300));
        let writer = std::thread::spawn(move || {
            // Announce a 64-byte token, then send it one byte at a time.
            let _ = client.write_all(&64u32.to_be_bytes());
            for _ in 0..100 {
                if client.write_all(b"a").is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        let (elapsed, prompted) = server.join().unwrap();
        assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
        assert!(!prompted);
        writer.join().unwrap();
    }

    #[test]
    fn cleanup_removes_the_helper_script_and_tolerates_absence() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("gitty-editor-test.sh");
        fs::write(&script, "#!/bin/sh\n").unwrap();
        let registry = EditorRegistry::new(1, "t".into(), script.clone());
        registry.cleanup();
        assert!(!script.exists());
        registry.cleanup();
    }

    #[test]
    fn registry_mutation_guard_clears_active_and_cancels_pending() {
        let registry = EditorRegistry::new(0, "token".into(), PathBuf::from("script"));
        let (tx, rx) = std::sync::mpsc::channel();
        {
            let guard = registry.start_mutation("/tmp/git", "/tmp/common");
            registry.requests.lock().unwrap().insert(
                1,
                PendingRequest {
                    token: guard.token().into(),
                    sender: tx,
                },
            );
            assert_eq!(registry.active_mutations.lock().unwrap().len(), 1);
        }

        assert!(registry.active_mutations.lock().unwrap().is_empty());
        assert_eq!(rx.recv().unwrap(), None);
        assert!(registry.requests.lock().unwrap().is_empty());
    }

    #[test]
    fn concurrent_mutations_only_cancel_their_own_prompts() {
        let registry = EditorRegistry::new(0, "token".into(), PathBuf::from("script"));
        let first = registry.start_mutation("/tmp/one", "/tmp/one");
        let second = registry.start_mutation("/tmp/two", "/tmp/two");
        let (tx1, rx1) = std::sync::mpsc::channel();
        let (tx2, rx2) = std::sync::mpsc::channel();
        registry.requests.lock().unwrap().insert(
            1,
            PendingRequest {
                token: first.token().into(),
                sender: tx1,
            },
        );
        registry.requests.lock().unwrap().insert(
            2,
            PendingRequest {
                token: second.token().into(),
                sender: tx2,
            },
        );
        drop(first);
        assert_eq!(rx1.recv().unwrap(), None);
        assert!(registry.requests.lock().unwrap().contains_key(&2));
        assert_eq!(registry.active_mutations.lock().unwrap().len(), 1);
        drop(second);
        assert_eq!(rx2.recv().unwrap(), None);
    }

    #[test]
    fn editor_bridge_save_cancel_and_security_checks() {
        let temp = tempfile::tempdir().unwrap();
        let git_dir = temp.path().join(".git");
        fs::create_dir_all(&git_dir).unwrap();

        let msg_file = git_dir.join("COMMIT_EDITMSG");
        fs::write(&msg_file, b"original message\n# comment\n").unwrap();

        let outside_file = temp.path().join("outside.txt");
        fs::write(&outside_file, b"outside\n").unwrap();

        let token = "test-secret-token".to_string();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let registry = Arc::new(EditorRegistry::new(
            port,
            token.clone(),
            PathBuf::from("dummy"),
        ));

        // Spawn test server
        let reg_clone = registry.clone();
        let (prompt_tx, prompt_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for (req_id, stream) in (1..).zip(listener.incoming().flatten()) {
                let reg = reg_clone.clone();
                let p_tx = prompt_tx.clone();
                std::thread::spawn(move || {
                    handle_connection(
                        stream,
                        &reg,
                        req_id,
                        |id, name, content| p_tx.send((id, name, content)).map_err(|_| ()),
                        |_| {},
                    );
                });
            }
        });

        // 1. Unsolicited request (no active mutation) returns 0
        let resp = send_request(port, &token, msg_file.to_str().unwrap()).unwrap();
        assert_eq!(resp, b'0');

        // Start active mutation
        let guard = registry.start_mutation(git_dir.to_str().unwrap(), git_dir.to_str().unwrap());
        let token = guard.token().to_string();

        // 2. Token mismatch returns empty / error / no 1
        assert!(!matches!(
            send_request(port, "wrong-token", msg_file.to_str().unwrap()),
            Ok(b'1')
        ));

        // 3. Path outside git_dir returns 0
        let resp = send_request(port, &token, outside_file.to_str().unwrap()).unwrap();
        assert_eq!(resp, b'0');

        // 4. Disallowed filename inside git_dir returns 0
        let config_file = git_dir.join("config");
        fs::write(&config_file, b"[core]\n").unwrap();
        let resp = send_request(port, &token, config_file.to_str().unwrap()).unwrap();
        assert_eq!(resp, b'0');

        // 5. Valid prompt and save with exact whitespace and newline preservation
        let client = std::thread::spawn({
            let path = msg_file.to_str().unwrap().to_string();
            let token = token.clone();
            move || send_request(port, &token, &path).unwrap()
        });

        let (req_id, file_name, content) = prompt_rx.recv().unwrap();
        assert_eq!(file_name, "COMMIT_EDITMSG");
        assert_eq!(content, "original message\n# comment\n");

        let updated_text = "feat: new commit\n\nDetailed explanation.\n";
        registry
            .requests
            .lock()
            .unwrap()
            .remove(&req_id)
            .unwrap()
            .sender
            .send(Some(updated_text.to_string()))
            .unwrap();

        let resp = client.join().unwrap();
        assert_eq!(resp, b'1');
        assert_eq!(fs::read_to_string(&msg_file).unwrap(), updated_text);

        // 6. Valid prompt and cancel (reply None) returns 0 and leaves file untouched
        let client = std::thread::spawn({
            let path = msg_file.to_str().unwrap().to_string();
            let token = token.clone();
            move || send_request(port, &token, &path).unwrap()
        });

        let (req_id, _, _) = prompt_rx.recv().unwrap();
        registry
            .requests
            .lock()
            .unwrap()
            .remove(&req_id)
            .unwrap()
            .sender
            .send(None)
            .unwrap();

        let resp = client.join().unwrap();
        assert_eq!(resp, b'0');
        // File content remains updated_text
        assert_eq!(fs::read_to_string(&msg_file).unwrap(), updated_text);

        // 7. Changed-on-disk refusal: file modified between prompt and reply
        let client = std::thread::spawn({
            let path = msg_file.to_str().unwrap().to_string();
            let token = token.clone();
            move || send_request(port, &token, &path).unwrap()
        });

        let (req_id, _, _) = prompt_rx.recv().unwrap();
        // Concurrently modify file on disk
        fs::write(&msg_file, b"tampered externally").unwrap();

        registry
            .requests
            .lock()
            .unwrap()
            .remove(&req_id)
            .unwrap()
            .sender
            .send(Some("my save".to_string()))
            .unwrap();

        let resp = client.join().unwrap();
        assert_eq!(resp, b'0');
        assert_eq!(
            fs::read_to_string(&msg_file).unwrap(),
            "tampered externally"
        );

        #[cfg(unix)]
        {
            let elsewhere = temp.path().join("external-message");
            fs::write(&elsewhere, b"outside is precious\n").unwrap();
            let client = std::thread::spawn({
                let path = msg_file.to_str().unwrap().to_string();
                let token = token.clone();
                move || send_request(port, &token, &path).unwrap()
            });
            let (req_id, _, _) = prompt_rx.recv().unwrap();
            fs::remove_file(&msg_file).unwrap();
            std::os::unix::fs::symlink(&elsewhere, &msg_file).unwrap();
            registry.reply(req_id, Some("redirected".into())).unwrap();
            assert_eq!(client.join().unwrap(), b'0');
            assert_eq!(fs::read(&elsewhere).unwrap(), b"outside is precious\n");
        }
    }
}
