use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    process::{Child, Command, Stdio},
    thread,
    time::Duration,
};

fn spawn_serve() -> Child {
    Command::new(env!("CARGO_BIN_EXE_gitty-cli"))
        .args(["serve", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

/// Opens `path` through the stdio protocol and returns the session handle.
fn open(input: &mut impl Write, output: &mut impl BufRead, path: &std::path::Path) -> String {
    let request = serde_json::json!({
        "version":1,
        "id":"open",
        "method":"repository_open",
        "params":{"location":{"kind":"native","path":path}}
    });
    writeln!(input, "{request}").unwrap();
    let mut line = String::new();
    output.read_line(&mut line).unwrap();
    let response: serde_json::Value = serde_json::from_str(&line).unwrap();
    response["result"]["session"]["handle"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn cli_askpass_helper_roundtrips_secret_without_logging_it() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut token = String::new();
        let mut prompt = String::new();
        reader.read_line(&mut token).unwrap();
        reader.read_line(&mut prompt).unwrap();
        assert_eq!(token, "scoped-token\n");
        assert_eq!(prompt, "Password prompt\n");
        stream.write_all(b"1secret-value \n").unwrap();
    });

    let output = Command::new(env!("CARGO_BIN_EXE_gitty-cli"))
        .args(["askpass", "Password prompt"])
        .env("GITTY_ASKPASS_PORT", port.to_string())
        .env("GITTY_ASKPASS_TOKEN", "scoped-token")
        .output()
        .unwrap();
    server.join().unwrap();
    assert!(
        output.status.success(),
        "status={}, stdout={:?}, stderr={}",
        output.status,
        output.stdout,
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"secret-value \n");
    assert!(!String::from_utf8_lossy(&output.stderr).contains("secret-value"));
}

#[test]
fn cli_editor_helper_roundtrips_through_the_spawned_binary() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut len = [0u8; 4];
        stream.read_exact(&mut len).unwrap();
        let mut token = vec![0; u32::from_be_bytes(len) as usize];
        stream.read_exact(&mut token).unwrap();
        assert_eq!(token, b"editor-token");
        stream.read_exact(&mut len).unwrap();
        let mut path = vec![0; u32::from_be_bytes(len) as usize];
        stream.read_exact(&mut path).unwrap();
        assert_eq!(path, b"C:\\repo\\.git\\COMMIT_EDITMSG");
        stream.write_all(b"1").unwrap();
    });
    let output = Command::new(env!("CARGO_BIN_EXE_gitty-cli"))
        .args(["editor", "C:\\repo\\.git\\COMMIT_EDITMSG"])
        .env("GITTY_EDITOR_PORT", port.to_string())
        .env("GITTY_EDITOR_TOKEN", "editor-token")
        .output()
        .unwrap();
    server.join().unwrap();
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
}

#[test]
fn cli_capabilities_condition_account_and_platform_methods() {
    let default = Command::new(env!("CARGO_BIN_EXE_gitty-cli"))
        .args(["capabilities", "--json"])
        .output()
        .unwrap();
    assert!(default.status.success());
    let default: serde_json::Value = serde_json::from_slice(&default.stdout).unwrap();
    let default_methods = default["methods"].as_array().unwrap();
    assert!(!default_methods.iter().any(|m| {
        matches!(
            m.as_str(),
            Some(
                "provider_connect_token"
                    | "provider_oauth_start"
                    | "provider_oauth_poll"
                    | "provider_oauth_cancel"
            )
        )
    }));
    assert!(default_methods.iter().any(|m| m == "ssh_test"));
    assert_eq!(
        default_methods.iter().any(|m| m == "wsl_distributions"),
        cfg!(windows)
    );
    let accounts = tempfile::tempdir().unwrap();
    let enabled = Command::new(env!("CARGO_BIN_EXE_gitty-cli"))
        .args([
            "--accounts-file",
            accounts.path().join("accounts.json").to_str().unwrap(),
            "capabilities",
            "--json",
        ])
        .output()
        .unwrap();
    assert!(enabled.status.success());
    let enabled: serde_json::Value = serde_json::from_slice(&enabled.stdout).unwrap();
    let methods = enabled["methods"].as_array().unwrap();
    for method in [
        "provider_connect_token",
        "provider_oauth_start",
        "provider_oauth_poll",
        "provider_oauth_cancel",
    ] {
        assert!(methods.iter().any(|m| m == method), "{method}");
    }
    assert!(
        enabled["schemas"]["methods"]["provider_connect_token"]["request"]["properties"]["token"]
            .is_object()
    );
}

#[test]
fn cli_stdio_exits_after_eof_and_closed_output() {
    let mut eof = spawn_serve();
    drop(eof.stdin.take());
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    thread::spawn(move || done_tx.send(eof.wait().unwrap()).unwrap());
    assert!(done_rx
        .recv_timeout(Duration::from_secs(3))
        .unwrap()
        .success());

    let mut broken = spawn_serve();
    let mut stdin = broken.stdin.take().unwrap();
    drop(broken.stdout.take());
    stdin
        .write_all(b"{\"version\":1,\"id\":1,\"method\":\"capabilities\",\"params\":{}}\n")
        .unwrap();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    thread::spawn(move || done_tx.send(broken.wait().unwrap()).unwrap());
    assert!(done_rx.recv_timeout(Duration::from_secs(5)).is_ok());
    drop(stdin);
}

fn search_shutdown_is_prompt(close_output: bool) {
    let repository = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let mut child = spawn_serve();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let handle = open(&mut input, &mut output, &repository);
    let search = serde_json::json!({
        "version":1,
        "id":2,
        "method":"repository_search",
        "params":{"handle":handle,"query":{"text":"a phrase that should not exist in commit history"}}
    });
    let _output = (!close_output).then_some(output);
    writeln!(input, "{search}").unwrap();
    let _input = close_output.then_some(input);
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    thread::spawn(move || done_tx.send(child.wait().unwrap()).unwrap());
    assert!(
        done_rx.recv_timeout(Duration::from_secs(5)).is_ok(),
        "server did not shut down after its output pipe broke or stdin reached EOF"
    );
}

#[test]
fn cli_stdio_closed_output_cancels_search_while_input_stays_open() {
    search_shutdown_is_prompt(true);
}

#[test]
fn cli_stdio_eof_cancels_an_active_search() {
    search_shutdown_is_prompt(false);
}

#[test]
fn cli_stdio_cancels_clones_on_request_and_eof() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let git = |args: &[&str]| {
        let output = Command::new("git")
            .arg("-C")
            .arg(source.path())
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    };
    git(&["init", "--quiet"]);
    git(&["config", "user.name", "CLI test"]);
    git(&["config", "user.email", "cli@example.invalid"]);
    std::fs::write(
        source.path().join("payload.bin"),
        (0..16 * 1024 * 1024)
            .map(|n| ((n * 31 + n / 97) % 251) as u8)
            .collect::<Vec<_>>(),
    )
    .unwrap();
    git(&["add", "payload.bin"]);
    git(&["commit", "--quiet", "-m", "payload"]);

    let mut child = spawn_serve();
    let operation_id = "123e4567-e89b-12d3-a456-426614174000";
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let clone = serde_json::json!({
        "version":1,
        "id":"clone",
        "method":"repository_clone",
        "params":{
            "operationId":operation_id,
            "request":{
                "source":source.path(),
                "parent":{"kind":"native","path":parent.path()},
                "directoryName":"cancelled-clone"
            }
        }
    });
    writeln!(input, "{clone}").unwrap();
    let mut cancelled = false;
    let mut clone_response = None;
    let mut seen = Vec::new();
    while clone_response.is_none() {
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        assert!(!line.is_empty(), "CLI exited before clone finished");
        let value: serde_json::Value = serde_json::from_str(&line).unwrap();
        seen.push(value.clone());
        if value["event"]["kind"] == "repository_clone"
            && value["event"]["data"]["operationId"] == operation_id
            && !cancelled
        {
            let request = serde_json::json!({
                "version":1,
                "id":"cancel",
                "method":"repository_cancel_clone",
                "params":{"operationId":operation_id}
            });
            writeln!(input, "{request}").unwrap();
            cancelled = true;
        }
        if value["id"] == "clone" {
            clone_response = Some(value);
        }
    }
    assert!(
        cancelled,
        "clone progress did not carry its operation id: {seen:?}"
    );
    assert_eq!(clone_response.unwrap()["error"]["code"], "cancelled");

    let eof_operation_id = "223e4567-e89b-12d3-a456-426614174000";
    let eof_clone = serde_json::json!({
        "version":1,
        "id":"eof-clone",
        "method":"repository_clone",
        "params":{
            "operationId":eof_operation_id,
            "request":{
                "source":source.path(),
                "parent":{"kind":"native","path":parent.path()},
                "directoryName":"eof-clone"
            }
        }
    });
    writeln!(input, "{eof_clone}").unwrap();
    let mut started = false;
    while !started {
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        assert!(!line.is_empty(), "CLI exited before EOF clone started");
        let value: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_ne!(
            value["id"], "eof-clone",
            "EOF clone finished before progress"
        );
        started = value["event"]["kind"] == "repository_clone"
            && value["event"]["data"]["operationId"] == eof_operation_id;
    }
    let output_thread = thread::spawn(move || {
        let mut remaining = String::new();
        output.read_to_string(&mut remaining).unwrap();
    });
    drop(input);
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    thread::spawn(move || done_tx.send(child.wait().unwrap()).unwrap());
    assert!(done_rx
        .recv_timeout(Duration::from_secs(20))
        .expect("CLI did not exit after stdin EOF")
        .success());
    output_thread.join().unwrap();
    assert!(!parent.path().join("cancelled-clone").exists());
    assert!(!parent.path().join("eof-clone").exists());
}

#[test]
fn cli_process_saturation_returns_server_busy_without_dropping_requests() {
    let repository = tempfile::tempdir().unwrap();
    let git = Command::new("git")
        .arg("-C")
        .arg(repository.path())
        .args(["init", "--quiet"])
        .status()
        .unwrap();
    assert!(git.success());
    for index in 0..3000 {
        std::fs::write(
            repository.path().join(format!("file-{index}.txt")),
            "untracked fixture\n",
        )
        .unwrap();
    }

    let mut child = spawn_serve();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let handle = open(&mut input, &mut output, repository.path());
    let (response_tx, response_rx) = std::sync::mpsc::channel();
    let output_thread = thread::spawn(move || {
        let mut line = String::new();
        while output.read_line(&mut line).unwrap() > 0 {
            if response_tx.send(std::mem::take(&mut line)).is_err() {
                break;
            }
        }
    });
    for id in 0..80 {
        let request = serde_json::json!({
            "version":1,
            "id":id,
            "method":"repository_status",
            "params":{"handle":handle}
        });
        writeln!(input, "{request}").unwrap();
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let responses = (0..80)
        .map(|_| {
            response_rx
                .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                .expect("CLI did not respond to every request before EOF")
        })
        .map(|line| serde_json::from_str::<serde_json::Value>(&line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(responses.len(), 80);
    assert!(
        responses
            .iter()
            .any(|response| response["error"]["code"] == "serverBusy"),
        "bounded process queue never reported saturation"
    );
    drop(input);
    output_thread.join().unwrap();
    assert!(child.wait().unwrap().success());
}

#[test]
fn cli_process_exit_expires_session_handles_and_history_cursors() {
    let repository = tempfile::tempdir().unwrap();
    let git = |args: &[&str]| {
        let output = Command::new("git")
            .arg("-C")
            .arg(repository.path())
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "git {:?} failed", args);
    };
    git(&["init", "--quiet"]);
    git(&["config", "user.name", "CLI test"]);
    git(&["config", "user.email", "cli@example.invalid"]);
    for index in 0..3 {
        std::fs::write(repository.path().join("history.txt"), format!("{index}\n")).unwrap();
        git(&["add", "history.txt"]);
        git(&["commit", "--quiet", "-m", &format!("commit {index}")]);
    }

    let mut first = spawn_serve();
    let mut first_input = first.stdin.take().unwrap();
    let mut first_output = BufReader::new(first.stdout.take().unwrap());
    let handle = open(&mut first_input, &mut first_output, repository.path());
    let mut line = String::new();
    let history = serde_json::json!({
        "version":1,
        "id":2,
        "method":"repository_history",
        "params":{"handle":handle,"limit":1}
    });
    writeln!(first_input, "{history}").unwrap();
    line.clear();
    first_output.read_line(&mut line).unwrap();
    let page: serde_json::Value = serde_json::from_str(&line).unwrap();
    let cursor = page["result"]["cursor"].as_str().unwrap().to_owned();
    drop(first_input);
    assert!(first.wait().unwrap().success());

    let mut second = spawn_serve();
    let mut second_input = second.stdin.take().unwrap();
    let mut second_output = BufReader::new(second.stdout.take().unwrap());
    let stale_handle = serde_json::json!({
        "version":1,
        "id":3,
        "method":"repository_status",
        "params":{"handle":handle}
    });
    writeln!(second_input, "{stale_handle}").unwrap();
    line.clear();
    second_output.read_line(&mut line).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&line).unwrap()["error"]["code"],
        "invalidHandle"
    );
    let new_handle = open(&mut second_input, &mut second_output, repository.path());
    let stale_cursor = serde_json::json!({
        "version":1,
        "id":5,
        "method":"repository_history",
        "params":{"handle":new_handle,"cursor":cursor,"limit":1}
    });
    writeln!(second_input, "{stale_cursor}").unwrap();
    line.clear();
    second_output.read_line(&mut line).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&line).unwrap()["error"]["code"],
        "staleCursor"
    );
    drop(second_input);
    assert!(second.wait().unwrap().success());
}

#[test]
fn independent_cli_processes_contend_across_linked_worktrees() {
    let root = tempfile::tempdir().unwrap();
    let main_repo = root.path().join("main");
    let side_repo = root.path().join("side");
    let hooks = root.path().join("hooks");
    std::fs::create_dir_all(&main_repo).unwrap();
    std::fs::create_dir_all(&hooks).unwrap();
    let git = |cwd: &std::path::Path, args: &[&str]| {
        let output = Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    };
    git(&main_repo, &["init", "--quiet", "-b", "main"]);
    git(&main_repo, &["config", "user.name", "CLI test"]);
    git(&main_repo, &["config", "user.email", "cli@example.invalid"]);
    std::fs::write(main_repo.join("base.txt"), "base\n").unwrap();
    git(&main_repo, &["add", "base.txt"]);
    git(&main_repo, &["commit", "--quiet", "-m", "base"]);
    git(
        &main_repo,
        &[
            "worktree",
            "add",
            "--quiet",
            "-b",
            "side",
            side_repo.to_str().unwrap(),
        ],
    );
    let marker = ".gitty-hook-started";
    let hook = hooks.join("pre-commit");
    std::fs::write(
        &hook,
        format!("#!/bin/sh\nprintf started > '{marker}'\nsleep 3\n"),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    git(
        &main_repo,
        &["config", "core.hooksPath", hooks.to_str().unwrap()],
    );
    std::fs::write(main_repo.join("base.txt"), "committed change\n").unwrap();
    git(&main_repo, &["add", "base.txt"]);
    std::fs::write(side_repo.join("side.txt"), "side change\n").unwrap();

    let mut first = spawn_serve();
    let mut first_input = first.stdin.take().unwrap();
    let mut first_output = BufReader::new(first.stdout.take().unwrap());
    let first_handle = open(&mut first_input, &mut first_output, &main_repo);
    let mut line = String::new();
    let commit = serde_json::json!({
        "version":1,"id":"commit","method":"repository_create_commit",
        "params":{"handle":first_handle,"message":"reviewed commit"}
    });
    writeln!(first_input, "{commit}").unwrap();
    let marker_path = main_repo.join(marker);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !marker_path.exists() && std::time::Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(marker_path.exists(), "commit hook did not start");

    let mut second = spawn_serve();
    let mut second_input = second.stdin.take().unwrap();
    let mut second_output = BufReader::new(second.stdout.take().unwrap());
    let second_handle = open(&mut second_input, &mut second_output, &side_repo);
    let stage = serde_json::json!({
        "version":1,"id":"stage","method":"repository_stage",
        "params":{"handle":second_handle,"paths":["side.txt"]}
    });
    writeln!(second_input, "{stage}").unwrap();
    line.clear();
    second_output.read_line(&mut line).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&line).unwrap()["error"]["code"],
        "repositoryBusy"
    );

    loop {
        line.clear();
        first_output.read_line(&mut line).unwrap();
        let response: serde_json::Value = serde_json::from_str(&line).unwrap();
        if response["id"] == "commit" {
            assert!(response["error"].is_null(), "{response}");
            break;
        }
    }
    drop(first_input);
    drop(second_input);
    assert!(first.wait().unwrap().success());
    assert!(second.wait().unwrap().success());
}

#[test]
fn cli_child_exits_when_its_parent_process_is_killed() {
    const HELPER: &str = "GITTY_PARENT_DEATH_HELPER";
    if std::env::var_os(HELPER).is_some() {
        parent_death_helper();
        return;
    }

    let repository = tempfile::tempdir().unwrap();
    let init = Command::new("git")
        .arg("-C")
        .arg(repository.path())
        .args(["init", "--quiet"])
        .status()
        .unwrap();
    assert!(init.success());

    let mut helper = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "cli_child_exits_when_its_parent_process_is_killed",
            "--nocapture",
        ])
        .env(HELPER, "1")
        .env(
            "GITTY_PARENT_DEATH_REPO",
            repository.path().to_string_lossy().as_ref(),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    let stdout = helper.stdout.take().unwrap();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let mut output = BufReader::new(stdout);
        let mut line = String::new();
        while output.read_line(&mut line).unwrap_or(0) > 0 {
            if let Some(pid) = line.strip_prefix("GITTY_CHILD_READY ") {
                let _ = ready_tx.send(pid.trim().parse::<u32>());
                return;
            }
            line.clear();
        }
    });
    let child_pid = match ready_rx.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(pid)) => pid,
        Ok(Err(error)) => {
            let _ = helper.kill();
            let _ = helper.wait();
            panic!("helper reported an invalid CLI PID: {error}");
        }
        Err(error) => {
            let _ = helper.kill();
            let _ = helper.wait();
            panic!("helper did not open the repository and report readiness: {error}");
        }
    };
    let Some(cli) = ProcessObserver::open(child_pid) else {
        let _ = helper.kill();
        let _ = helper.wait();
        panic!("could not obtain a wait handle for the owned CLI child");
    };

    helper.kill().expect("failed to terminate helper parent");
    helper.wait().unwrap();
    assert!(
        cli.wait_exited(Duration::from_secs(10)),
        "gitty-cli child {child_pid} survived termination of its parent"
    );
}

fn parent_death_helper() {
    let repository = std::env::var("GITTY_PARENT_DEATH_REPO").unwrap();
    let mut cli = spawn_serve();
    let mut input = cli.stdin.take().unwrap();
    let mut output = BufReader::new(cli.stdout.take().unwrap());
    let request = serde_json::json!({
        "version": 1,
        "id": 1,
        "method": "repository_open",
        "params": {"location": {"kind": "native", "path": repository}}
    });
    writeln!(input, "{request}").unwrap();
    let mut response = String::new();
    output.read_line(&mut response).unwrap();
    let response: serde_json::Value = serde_json::from_str(&response).unwrap();
    assert!(
        response["result"]["session"]["handle"].is_string(),
        "repository session failed to open: {response}"
    );
    println!("GITTY_CHILD_READY {}", cli.id());
    use std::io::Write as _;
    std::io::stdout().flush().unwrap();
    loop {
        thread::park();
    }
}

#[cfg(windows)]
struct ProcessObserver(*mut std::ffi::c_void);

#[cfg(windows)]
impl ProcessObserver {
    fn open(pid: u32) -> Option<Self> {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
        }
        let handle = unsafe { OpenProcess(0x0010_0000, 0, pid) };
        (!handle.is_null()).then_some(Self(handle))
    }

    fn wait_exited(&self, timeout: Duration) -> bool {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn WaitForSingleObject(handle: *mut std::ffi::c_void, millis: u32) -> u32;
        }
        unsafe {
            WaitForSingleObject(self.0, timeout.as_millis().min(u32::MAX as u128) as u32) == 0
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessObserver {
    fn drop(&mut self) {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        }
        unsafe {
            CloseHandle(self.0);
        }
    }
}

#[cfg(unix)]
struct ProcessObserver(i32);

#[cfg(unix)]
impl ProcessObserver {
    fn open(pid: u32) -> Option<Self> {
        Some(Self(pid.try_into().ok()?))
    }

    fn wait_exited(&self, timeout: Duration) -> bool {
        unsafe extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            if unsafe { kill(self.0, 0) } != 0 {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        unsafe { kill(self.0, 0) != 0 }
    }
}
#[test]
fn terminal_cli_refuses_noninteractive_io_without_entering_raw_mode() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_gitty-cli"))
        .arg("tui")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("requires interactive input and output")
    );
}
