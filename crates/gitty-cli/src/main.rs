use gitty_core::{AgentService, Error};
mod tui;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::{self, BufRead, BufReader, Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::Duration,
};

const MAX_LINE: usize = 1024 * 1024;
const MAX_OUTPUT: usize = 4 * 1024 * 1024;
const WORKERS: usize = 4;
const QUEUED_REQUESTS: usize = 8;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    version: u8,
    id: Value,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Serialize)]
struct Response {
    version: u8,
    id: Value,
    result: Option<Value>,
    error: Option<Error>,
}

fn invalid(message: impl Into<String>) -> Error {
    Error::new("invalidRequest", message)
}

fn call(service: &AgentService, method: &str, params: Value) -> Result<Value, Error> {
    match method {
        "capabilities" if params.as_object().is_some_and(serde_json::Map::is_empty) => Ok(json!({
            "protocol": {
                "major": 1,
                "maxConcurrentRequests": WORKERS,
                "maxQueuedRequests": QUEUED_REQUESTS,
                "maxRequestBytes": MAX_LINE,
                "maxResponseBytes": MAX_OUTPUT
            },
            "methods": gitty_core::protocol::supported_methods(
                service.accounts_enabled(),
                service.prompts_enabled(),
            ),
            "locations": if cfg!(windows) {
                vec!["native", "wsl", "ssh"]
            } else {
                vec!["native", "ssh"]
            },
            "noninteractive": !service.prompts_enabled(),
            "promptPolicy": if service.prompts_enabled() { "scopedEvents" } else { "disabled" },
            "accountPolicy": if service.accounts_enabled() { "systemKeychain" } else { "disabled" },
            "cancellation": ["repository_cancel_search", "repository_cancel_clone"],
            "desktopOnly": ["native_dialogs", "window_commands", "url_opening", "path_shell_actions"],
            "schemas": gitty_core::protocol::schemas(
                service.accounts_enabled(),
                service.prompts_enabled(),
            )
        })),
        "capabilities" => Err(Error::new(
            "invalidRequest",
            "capabilities takes an empty params object",
        )),
        _ => service.dispatch(method, params),
    }
}

fn response(id: Value, result: Result<Value, Error>) -> Response {
    match result {
        Ok(result) => Response {
            version: 1,
            id,
            result: Some(result),
            error: None,
        },
        Err(message) => Response {
            version: 1,
            id,
            result: None,
            error: Some(message),
        },
    }
}

fn write_response(writer: &mut impl Write, response: Response) -> io::Result<()> {
    let id = response.id.clone();
    if write_bounded_line(writer, &response, MAX_OUTPUT).is_err() {
        write_bounded_line(
            writer,
            &Response {
                version: 1,
                id,
                result: None,
                error: Some(Error::new("outputTooLarge", "Response exceeds 4 MiB")),
            },
            MAX_OUTPUT,
        )?;
    }
    Ok(())
}

fn write_bounded_line(
    writer: &mut impl Write,
    value: &impl Serialize,
    limit: usize,
) -> io::Result<()> {
    struct Bounded(Vec<u8>, usize);
    impl Write for Bounded {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.0.len().saturating_add(bytes.len()) > self.1 {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "output limit"));
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut bytes = Bounded(Vec::with_capacity(limit.min(8192)), limit);
    serde_json::to_writer(&mut bytes, value).map_err(io::Error::other)?;
    bytes.0.push(b'\n');
    writer.write_all(&bytes.0)?;
    writer.flush()
}

fn read_line(reader: &mut impl BufRead) -> io::Result<Option<Result<Vec<u8>, ()>>> {
    let mut bytes = Vec::new();
    let mut oversized = false;
    let mut read_any = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(if read_any {
                Some(if oversized { Err(()) } else { Ok(bytes) })
            } else {
                None
            });
        }
        read_any = true;
        let count = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        let has_newline = available[count - 1] == b'\n';
        if !oversized {
            if bytes.len() + count > MAX_LINE {
                oversized = true;
                bytes.clear();
            } else {
                bytes.extend_from_slice(&available[..count]);
            }
        }
        reader.consume(count);
        if has_newline {
            return Ok(Some(if oversized {
                Err(())
            } else {
                if bytes.last() == Some(&b'\n') {
                    bytes.pop();
                }
                if bytes.last() == Some(&b'\r') {
                    bytes.pop();
                }
                Ok(bytes)
            }));
        }
    }
}

struct Job {
    id: Value,
    method: String,
    params: Value,
}

fn run_worker(
    receiver: Arc<Mutex<mpsc::Receiver<Job>>>,
    stopping: Arc<AtomicBool>,
    mut execute: impl FnMut(Job) -> bool,
) {
    loop {
        if stopping.load(Ordering::Acquire) {
            break;
        }
        let job = match receiver.lock().unwrap().recv() {
            Ok(job) => job,
            Err(_) => break,
        };
        if stopping.load(Ordering::Acquire) || !execute(job) {
            break;
        }
    }
}

fn repeat_shutdown_until_workers_finish(
    workers: &[thread::JoinHandle<()>],
    mut shutdown: impl FnMut(),
) {
    while workers.iter().any(|worker| !worker.is_finished()) {
        shutdown();
        if workers.iter().any(|worker| !worker.is_finished()) {
            thread::sleep(Duration::from_millis(25));
        }
    }
}

type InputLine = io::Result<Option<Result<Vec<u8>, ()>>>;

fn serve_lines(
    lines: mpsc::Receiver<InputLine>,
    writer: impl Write + Send + 'static,
    service: Arc<AgentService>,
) -> Result<(), String> {
    let stdout = Arc::new(Mutex::new(writer));
    let stopping = Arc::new(AtomicBool::new(false));
    let (sender, receiver) = mpsc::sync_channel::<Job>(QUEUED_REQUESTS);
    let receiver = Arc::new(Mutex::new(receiver));
    let mut workers = Vec::with_capacity(WORKERS);
    for _ in 0..WORKERS {
        let service = service.clone();
        let receiver = receiver.clone();
        let stdout = stdout.clone();
        let stopping = stopping.clone();
        workers.push(thread::spawn(move || {
            let worker_stopping = stopping.clone();
            run_worker(receiver, stopping, |job| {
                let result = response(job.id, call(&service, &job.method, job.params));
                if let Err(error) = write_response(&mut *stdout.lock().unwrap(), result) {
                    eprintln!("stdio response write failed: {error}");
                    worker_stopping.store(true, Ordering::Release);
                    false
                } else {
                    true
                }
            });
        }));
    }
    let event_stop = Arc::new(AtomicBool::new(false));
    let event_thread = {
        let service = service.clone();
        let stdout = stdout.clone();
        let stop = event_stop.clone();
        let stopping = stopping.clone();
        thread::spawn(move || {
            while !stop.load(Ordering::Acquire) && !stopping.load(Ordering::Acquire) {
                if let Some(event) = service.next_event(Duration::from_millis(100)) {
                    if let Err(error) =
                        write_bounded_line(&mut *stdout.lock().unwrap(), &event, MAX_OUTPUT)
                    {
                        eprintln!("stdio event write failed: {error}");
                        stopping.store(true, Ordering::Release);
                        break;
                    }
                }
            }
        })
    };
    let mut failure = None;
    loop {
        if stopping.load(Ordering::Acquire) {
            failure = Some("stdio output failed".to_string());
            break;
        }
        let incoming = match lines.recv_timeout(Duration::from_millis(50)) {
            Ok(Ok(Some(line))) => Some(line),
            Ok(Ok(None)) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Ok(Err(error)) => {
                failure = Some(error.to_string());
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
        };
        let Some(line) = incoming else { break };
        let result = if line.is_err() {
            Some(response(
                Value::Null,
                Err(Error::new("requestTooLarge", "Request exceeds 1 MiB")),
            ))
        } else {
            match String::from_utf8(line.unwrap()) {
                Err(_) => Some(response(
                    Value::Null,
                    Err(Error::new("invalidUtf8", "Request is not valid UTF-8")),
                )),
                Ok(line) => match serde_json::from_str::<Request>(&line) {
                    Ok(request) => {
                        let id = request.id.clone();
                        if request.version != 1 {
                            Some(response(
                                id,
                                Err(Error::new(
                                    "unsupportedProtocol",
                                    "Unsupported protocol major version",
                                )),
                            ))
                        } else if matches!(
                            request.method.as_str(),
                            "repository_cancel_search"
                                | "repository_cancel_clone"
                                | "repository_prompt_reply"
                        ) {
                            Some(response(
                                id,
                                call(&service, &request.method, request.params),
                            ))
                        } else {
                            match sender.try_send(Job {
                                id,
                                method: request.method,
                                params: request.params,
                            }) {
                                Ok(()) => None,
                                Err(mpsc::TrySendError::Full(_)) => Some(response(
                                    request.id,
                                    Err(Error::new(
                                        "serverBusy",
                                        "The bounded request queue is full; retry this request",
                                    )),
                                )),
                                Err(mpsc::TrySendError::Disconnected(_)) => {
                                    return Err("stdio workers have stopped".into())
                                }
                            }
                        }
                    }
                    Err(error) => Some(response(
                        Value::Null,
                        Err(Error::new("invalidRequest", error.to_string())),
                    )),
                },
            }
        };
        if let Some(result) = result {
            if let Err(error) = write_response(&mut *stdout.lock().unwrap(), result) {
                failure = Some(error.to_string());
                stopping.store(true, Ordering::Release);
                break;
            }
        }
    }
    // EOF and output failure both close admission before service cleanup. Jobs
    // already running retain their normal outcome; queued jobs are discarded.
    stopping.store(true, Ordering::Release);
    event_stop.store(true, Ordering::Release);
    service.shutdown();
    drop(sender);
    // Repeat cancellation while admitted calls finish: a call may register a
    // clone or prompt just after the first cleanup sweep.
    repeat_shutdown_until_workers_finish(&workers, || service.shutdown());
    for worker in workers {
        if worker.join().is_err() && failure.is_none() {
            failure = Some("stdio worker panicked".into());
        }
    }
    let _ = event_thread.join();
    failure.map_or(Ok(()), Err)
}

fn serve(service: Arc<AgentService>) -> Result<(), String> {
    service.enable_activity_events();
    let (lines_tx, lines_rx) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let stdin = io::stdin();
        let mut input = BufReader::new(stdin.lock());
        loop {
            let line = read_line(&mut input);
            let done = !matches!(line, Ok(Some(_)));
            if lines_tx.send(line).is_err() || done {
                break;
            }
        }
    });
    serve_lines(lines_rx, io::stdout(), service)
}

fn repository_location(repo: Option<String>, file: Option<String>) -> Result<Value, Error> {
    match (repo, file) {
        (Some(path), None) => Ok(json!({"kind":"native","path":path})),
        (None, Some(path)) => {
            let location = read_json_file(&path)?;
            if !location.is_object() {
                return Err(invalid("location file must contain an object"));
            }
            Ok(location)
        }
        _ => Err(invalid(
            "provide exactly one of --repo PATH or --location-file FILE",
        )),
    }
}

fn open_location(service: &AgentService, location: Value) -> Result<String, Error> {
    let state = call(service, "repository_open", json!({"location":location}))?;
    state["session"]["handle"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| invalid("repository_open returned no handle"))
}

/// Opens the target repository, runs `f` with its handle, and closes the session
/// whether or not `f` succeeded.
fn with_handle<T>(
    service: &AgentService,
    repo: Option<String>,
    location_file: Option<String>,
    f: impl FnOnce(&str) -> Result<T, Error>,
) -> Result<T, Error> {
    let handle = open_location(service, repository_location(repo, location_file)?)?;
    let result = f(&handle);
    let _ = call(service, "repository_close", json!({"handle":handle}));
    result
}

type Target = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// Parses `--repo`, `--location-file`, `--method` and `--params-file` (each at most once).
fn parse_target(args: &[String]) -> Result<Target, Error> {
    let (mut repo, mut location_file, mut method, mut params_file) = (None, None, None, None);
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--repo" if repo.is_none() => repo = it.next().cloned(),
            "--location-file" if location_file.is_none() => location_file = it.next().cloned(),
            "--method" if method.is_none() => method = it.next().cloned(),
            "--params-file" if params_file.is_none() => params_file = it.next().cloned(),
            "--json" => {}
            _ => return Err(invalid(format!("unknown or duplicate argument: {arg}"))),
        }
    }
    Ok((repo, location_file, method, params_file))
}

fn print_json(value: &Value) -> Result<(), Error> {
    write_bounded_line(
        &mut io::stdout().lock(),
        value,
        MAX_OUTPUT.saturating_sub(1),
    )
    .map_err(|error| Error::new("outputTooLarge", error.to_string()))
}

fn run() -> Result<(), Error> {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|arg| arg == "tui") {
        return tui::run(&args[1..]);
    }
    let allow_prompts = if let Some(index) = args.iter().position(|arg| arg == "--allow-prompts") {
        args.remove(index);
        true
    } else {
        false
    };
    let accounts_file = if let Some(index) = args.iter().position(|arg| arg == "--accounts-file") {
        if index + 1 >= args.len() {
            return Err(invalid("--accounts-file requires a path"));
        }
        args.remove(index);
        Some(PathBuf::from(args.remove(index)))
    } else {
        None
    };
    if (allow_prompts || accounts_file.is_some())
        && !matches!(
            args.first().map(String::as_str),
            Some("serve" | "capabilities")
        )
    {
        return Err(invalid(
            "headless policies may only be selected for serve or capabilities",
        ));
    }
    let data = tempfile::tempdir()?;
    let mut service = match accounts_file {
        Some(path) => AgentService::with_system_accounts(data.path().into(), path),
        None => AgentService::new(data.path().into()),
    };
    if allow_prompts {
        service = service
            .with_event_prompts()
            .map_err(|error| Error::new("promptSetup", error.to_string()))?;
    }
    match args.first().map(String::as_str) {
        Some("serve") if args.as_slice() == ["serve", "--stdio"] => {
            serve(Arc::new(service)).map_err(|message| Error::new("protocolIo", message))
        }
        Some("capabilities") if args.len() == 1 || args.as_slice() == ["capabilities", "--json"] => {
            let result = call(&service, "capabilities", json!({}))?;
            println!("{}", serde_json::to_string_pretty(&result).unwrap());
            Ok(())
        }
        Some("doctor") if args.len() == 1 || args.as_slice() == ["doctor", "--json"] => {
            let git = std::process::Command::new("git")
                .arg("--version")
                .output()
                .map(|output| {
                    if output.status.success() {
                        json!({"available":true,"version":String::from_utf8_lossy(&output.stdout).trim()})
                    } else {
                        json!({"available":false,"error":"git --version failed"})
                    }
                })
                .unwrap_or_else(|error| json!({"available":false,"error":error.to_string()}));
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "gittyCliVersion": env!("CARGO_PKG_VERSION"),
                    "platform": std::env::consts::OS,
                    "git": git,
                    "locations": ["native"],
                    "interactivePrompts": false
                }))
                .unwrap()
            );
            Ok(())
        }
        Some("request") => {
            let (repo, location_file, method, params_file) = parse_target(&args[1..])?;
            let method = method.ok_or_else(|| invalid("--method is required"))?;
            let params_path = params_file
                .ok_or_else(|| invalid("--params-file is required (use - for stdin)"))?;
            let mut params = read_json_file(&params_path)?;
            let fields = params
                .as_object()
                .ok_or_else(|| invalid("params must be a JSON object"))?;
            if fields.contains_key("handle") {
                return Err(invalid("handle is assigned by the one-shot request"));
            }
            let allowed = [
                "repository_state", "repository_snapshot", "repository_status",
                "repository_operation_state", "repository_history", "repository_search",
                "repository_cancel_search", "repository_commit", "repository_commit_edit_eligibility",
                "repository_commit_graph_status", "repository_branch_relation",
                "repository_diff_files", "repository_diff", "repository_git_identity",
                "repository_set_git_identity", "repository_stage", "repository_unstage",
                "repository_discard", "repository_stage_hunk", "repository_unstage_hunk",
                "repository_create_commit", "repository_amend_commit", "repository_conflict_file",
                "repository_resolve_conflict", "repository_run_operation",
                "repository_delete_branch", "repository_delete_branches", "repository_worktrees",
                "repository_remotes",
                "repository_sync_info", "repository_remote_action", "repository_stashes",
                "repository_stash_action", "repository_write_commit_graph", "repository_watch",
                "repository_ignore_path", "repository_open_path", "repository_reveal_path",
            ];
            if !allowed.contains(&method.as_str()) {
                return Err(invalid("method is not available for one-shot repository requests"));
            }
            let result = with_handle(&service, repo, location_file, |handle| {
                params["handle"] = json!(handle);
                call(&service, &method, params)
            })?;
            println!("{}", serde_json::to_string_pretty(&result).unwrap());
            Ok(())
        }
        Some("review") => {
            let (repo, location_file, method, params_file) = parse_target(&args[1..])?;
            let review = with_handle(&service, repo, location_file, |handle| {
                let params = read_json_file(
                    params_file
                        .as_deref()
                        .ok_or_else(|| invalid("--params-file is required"))?,
                )?;
                service.review(
                    handle,
                    method
                        .as_deref()
                        .ok_or_else(|| invalid("--method is required"))?,
                    params,
                )
            })?;
            print_json(
                &serde_json::to_value(review)
                    .map_err(|error| Error::new("serialization", error.to_string()))?,
            )
        }
        Some("execute") => {
            if args.len() < 3 || args.len() > 4 || args.get(1).map(String::as_str) != Some("--review-file") {
                return Err(invalid("usage: gitty-cli execute --review-file FILE [--json]"));
            }
            let value = read_json_file(&args[2])?;
            let review = serde_json::from_value(value).map_err(|_| {
                invalid("review file is invalid or uses an unsupported version")
            })?;
            let result = service.execute_review(review)?;
            print_json(&result)
        }
        Some("status" | "history" | "stage" | "unstage" | "commit") => {
            let command = args[0].as_str();
            let mut repo = None;
            let mut location_file = None;
            let mut json_output = false;
            let mut limit = 50usize;
            let mut paths = Vec::new();
            let mut message_file = None;
            let mut it = args.iter().skip(1);
            while let Some(arg) = it.next() {
                match arg.as_str() {
                    "--repo" if repo.is_none() => repo = it.next().cloned(),
                    "--location-file" if location_file.is_none() => {
                        location_file = it.next().cloned()
                    }
                    "--json" if !json_output => json_output = true,
                    "--limit" if command == "history" => {
                        limit = it.next().ok_or_else(|| invalid("--limit requires an integer"))?
                            .parse().map_err(|_| invalid("--limit requires a positive integer"))?;
                    }
                    "--path" if matches!(command, "stage" | "unstage") => {
                        paths.push(it.next().ok_or_else(|| invalid("--path requires a path"))?.clone());
                    }
                    "--message-file" if command == "commit" && message_file.is_none() => {
                        message_file = Some(it.next().ok_or_else(|| invalid("--message-file requires a file"))?.clone());
                    }
                    _ => return Err(invalid(format!("unknown or duplicate argument: {arg}"))),
                }
            }
            if matches!(command, "stage" | "unstage") && paths.is_empty() {
                return Err(invalid("at least one explicit --path is required"));
            }
            if command == "commit" && message_file.is_none() {
                return Err(invalid("--message-file is required"));
            }
            let method = match command {
                "status" => "repository_status",
                "history" => "repository_history",
                "stage" => "repository_stage",
                "unstage" => "repository_unstage",
                "commit" => "repository_create_commit",
                _ => unreachable!(),
            };
            let result = with_handle(&service, repo, location_file, |handle| {
                let params = match command {
                    "status" => json!({"handle":handle}),
                    "history" => json!({"handle":handle,"limit":limit,"query":{}}),
                    "stage" | "unstage" => json!({"handle":handle,"paths":paths.clone()}),
                    "commit" => json!({
                        "handle":handle,
                        "message":read_message_file(message_file.as_deref().unwrap())?
                    }),
                    _ => unreachable!(),
                };
                call(&service, method, params)
            })?;
            if json_output {
                println!("{}", serde_json::to_string_pretty(&result).unwrap());
            } else {
                match command {
                    "status" => {
                        let entries = result["entries"].as_array().ok_or_else(|| invalid("status response has no entries"))?;
                        if entries.is_empty() {
                            println!("Clean");
                        } else {
                            for entry in entries {
                                println!(
                                    "{}{} {}",
                                    entry["indexStatus"].as_str().unwrap_or("?"),
                                    entry["worktreeStatus"].as_str().unwrap_or("?"),
                                    entry["path"].as_str().unwrap_or("?"),
                                );
                            }
                        }
                    }
                    "history" => {
                        for commit in result["commits"].as_array().ok_or_else(|| invalid("history response has no commits"))? {
                            println!(
                                "{} {}",
                                commit["id"].as_str().unwrap_or("?"),
                                commit["subject"].as_str().unwrap_or(""),
                            );
                        }
                    }
                    "stage" => println!("Staged {} path(s).", paths.len()),
                    "unstage" => println!("Unstaged {} path(s).", paths.len()),
                    "commit" => println!("Created commit {}.", result["oid"].as_str().unwrap_or("?")),
                    _ => unreachable!(),
                }
            }
            Ok(())
        }
        _ => Err(invalid("usage: gitty-cli tui [--repo PATH] | capabilities | request --repo PATH --method METHOD --params-file FILE [--json] | status --repo PATH [--json] | history --repo PATH [--limit N] [--json] | stage|unstage --repo PATH --path PATH... | commit --repo PATH --message-file FILE [--json] | serve --stdio")),
    }
}

fn emit_error(
    error: &Error,
    json_output: bool,
    stdout: &mut impl Write,
    stderr: &mut impl Write,
) -> io::Result<()> {
    if json_output {
        serde_json::to_writer(
            &mut *stdout,
            &json!({ "error": { "code": error.code, "message": error.message } }),
        )?;
        writeln!(stdout)?;
    } else {
        writeln!(stderr, "{}: {}", error.code, error.message)?;
    }
    Ok(())
}

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let mode = args.first().map(String::as_str);
    if mode == Some("editor") {
        std::process::exit(if gitty_core::helper::editor_from_env(&args).is_ok() {
            0
        } else {
            1
        });
    }
    if mode == Some("askpass")
        || (mode != Some("editor")
            && std::env::var_os("GITTY_ASKPASS_PORT").is_some()
            && std::env::var_os("GITTY_ASKPASS_TOKEN").is_some())
    {
        std::process::exit(if gitty_core::helper::askpass_from_env(&args).is_ok() {
            0
        } else {
            1
        });
    }
    let json_output = std::env::args().any(|arg| arg == "--json");
    if let Err(error) = run() {
        let _ = emit_error(
            &error,
            json_output,
            &mut io::stdout().lock(),
            &mut io::stderr().lock(),
        );
        std::process::exit(2);
    }
}

fn read_message_file(path: &str) -> Result<String, Error> {
    const MAX_MESSAGE: u64 = 64 * 1024;
    let file: Box<dyn Read> = if path == "-" {
        Box::new(io::stdin())
    } else {
        Box::new(std::fs::File::open(path)?)
    };
    let mut bytes = Vec::new();
    file.take(MAX_MESSAGE + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_MESSAGE {
        return Err(Error::new("inputLimit", "commit message exceeds 64 KiB"));
    }
    String::from_utf8(bytes)
        .map_err(|_| Error::new("invalidUtf8", "commit message file is not valid UTF-8"))
}

fn read_json_file(path: &str) -> Result<Value, Error> {
    let input: Box<dyn Read> = if path == "-" {
        Box::new(io::stdin())
    } else {
        Box::new(std::fs::File::open(path)?)
    };
    let mut bytes = Vec::new();
    input.take(MAX_LINE as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > MAX_LINE {
        return Err(Error::new("inputLimit", "JSON params exceed 1 MiB"));
    }
    serde_json::from_slice(&bytes).map_err(|error| invalid(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    struct ResponseWriter {
        sender: mpsc::Sender<String>,
        buffer: Vec<u8>,
    }

    impl Write for ResponseWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.buffer.extend_from_slice(bytes);
            while let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
                let line = self.buffer.drain(..=end).collect::<Vec<_>>();
                self.sender
                    .send(String::from_utf8(line).unwrap())
                    .map_err(|_| io::ErrorKind::BrokenPipe)?;
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn stdio_line_limit_discards_only_the_oversized_request() {
        let mut input = Cursor::new(format!("{}\n{{}}\n", "x".repeat(MAX_LINE + 1)));
        assert!(read_line(&mut input).unwrap().unwrap().is_err());
        assert_eq!(read_line(&mut input).unwrap().unwrap().unwrap(), b"{}");
    }

    #[test]
    fn rejects_invalid_utf8_without_lossy_rewriting() {
        let mut input = Cursor::new(vec![0xff, b'\n']);
        let bytes = read_line(&mut input).unwrap().unwrap().unwrap();
        assert!(String::from_utf8(bytes).is_err());
    }

    #[test]
    fn message_files_are_bounded_and_cli_json_errors_are_structured() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("message");
        std::fs::write(&path, vec![b'x'; 64 * 1024 + 1]).unwrap();
        assert_eq!(
            read_message_file(path.to_str().unwrap()).unwrap_err().code,
            "inputLimit"
        );

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        emit_error(
            &Error::new("repositoryBusy", "Another Gitty write is active"),
            true,
            &mut stdout,
            &mut stderr,
        )
        .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&stdout).unwrap(),
            json!({ "error": { "code": "repositoryBusy", "message": "Another Gitty write is active" } })
        );
        assert!(stderr.is_empty());
    }

    #[test]
    fn stdio_output_is_bounded_and_broken_pipes_are_reported() {
        let mut output = Vec::new();
        write_response(
            &mut output,
            response(json!(9), Ok(json!({"payload":"x".repeat(MAX_OUTPUT)}))),
        )
        .unwrap();
        let value: Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(value["error"]["code"], "outputTooLarge");
        assert_eq!(value["id"], 9);

        struct ClosedPipe;
        impl Write for ClosedPipe {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                Err(io::ErrorKind::BrokenPipe.into())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        assert_eq!(
            write_response(&mut ClosedPipe, response(json!(1), Ok(json!(null))))
                .unwrap_err()
                .kind(),
            io::ErrorKind::BrokenPipe
        );
    }

    #[test]
    fn stdio_worker_discards_queued_jobs_after_shutdown() {
        let (jobs_tx, jobs_rx) = mpsc::channel();
        let receiver = Arc::new(Mutex::new(jobs_rx));
        let stopping = Arc::new(AtomicBool::new(false));
        let worker_stopping = stopping.clone();
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            run_worker(receiver, worker_stopping, |job| {
                started_tx.send(job.id).unwrap();
                release_rx.recv().unwrap();
                true
            })
        });
        let job = |id| Job {
            id: json!(id),
            method: "repository_clone".into(),
            params: json!({}),
        };
        jobs_tx.send(job("active")).unwrap();
        assert_eq!(
            started_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            json!("active")
        );
        jobs_tx.send(job("queued")).unwrap();

        // The active callback is held until shutdown closes admission.
        stopping.store(true, Ordering::Release);
        release_tx.send(()).unwrap();
        worker.join().unwrap();
        assert!(
            started_rx.try_recv().is_err(),
            "queued clone started after EOF"
        );
    }

    #[test]
    fn stdio_repeats_shutdown_until_late_registered_work_finishes() {
        let (first_sweep_tx, first_sweep_rx) = mpsc::channel();
        let (registered_tx, registered_rx) = mpsc::channel();
        let (second_sweep_tx, second_sweep_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            first_sweep_rx.recv().unwrap();
            registered_tx.send(()).unwrap();
            second_sweep_rx.recv().unwrap();
        });
        let workers = [worker];
        let mut sweeps = 0;
        repeat_shutdown_until_workers_finish(&workers, || {
            sweeps += 1;
            if sweeps == 1 {
                first_sweep_tx.send(()).unwrap();
                registered_rx.recv().unwrap();
            } else {
                second_sweep_tx.send(()).unwrap();
            }
        });
        assert!(sweeps >= 2);
        workers.into_iter().next().unwrap().join().unwrap();
    }

    #[test]
    fn stdio_dispatch_correlates_response_ids_before_eof() {
        let service = Arc::new(AgentService::new(
            tempfile::tempdir().unwrap().path().into(),
        ));
        let (lines_tx, lines_rx) = mpsc::channel();
        let (responses_tx, responses_rx) = mpsc::channel();
        let writer = ResponseWriter {
            sender: responses_tx,
            buffer: Vec::new(),
        };
        let server = thread::spawn(move || serve_lines(lines_rx, writer, service));
        for id in ["a", "b"] {
            lines_tx
                .send(Ok(Some(Ok(
                    json!({"version":1,"id":id,"method":"capabilities","params":{}})
                        .to_string()
                        .into_bytes(),
                ))))
                .unwrap();
            let response = responses_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            let response: Value = serde_json::from_str(&response).unwrap();
            assert_eq!(response["id"], id);
            assert_eq!(response["result"]["protocol"]["major"], 1);
        }
        lines_tx.send(Ok(None)).unwrap();
        server.join().unwrap().unwrap();
    }
}
