//! Cancellable full repository cloning before a repository session exists.
use crate::{
    clone_dto::{CloneProgress, CloneRequest},
    dto::{Error, RepositoryLocation, Result},
    mutate::report,
    process::{self, Output},
    remote::network_args,
    repository::{lock, Service},
};
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

const CLONE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const MAX_PROGRESS_OUTPUT: usize = 32 * 1024 * 1024;
const MAX_PROGRESS_RECORD: usize = 16 * 1024;
const CLONE_RUNNING: u8 = 0;
const CLONE_CANCELLED: u8 = 1;
const CLONE_PUBLISHING: u8 = 2;
const CLONE_FINISHED: u8 = 3;

pub(crate) struct CloneControl {
    lifecycle: AtomicU8,
    child: Mutex<Option<process::ChildWait>>,
}

impl CloneControl {
    fn new() -> Self {
        Self {
            lifecycle: AtomicU8::new(CLONE_RUNNING),
            child: Mutex::new(None),
        }
    }

    /// Cancellation and publication share one linearization point. Once
    /// publication starts, cancellation is too late and must not claim success.
    fn request_cancel(&self) -> bool {
        match self.lifecycle.compare_exchange(
            CLONE_RUNNING,
            CLONE_CANCELLED,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) | Err(CLONE_CANCELLED) => {
                self.terminate_process();
                true
            }
            Err(_) => false,
        }
    }

    fn terminate_process(&self) {
        if let Ok(child) = self.child.lock() {
            if let Some(child) = child.as_ref() {
                child.kill();
            }
        }
    }

    fn cancelled(&self) -> bool {
        self.lifecycle.load(Ordering::Acquire) == CLONE_CANCELLED
    }

    fn begin_publish(&self) -> bool {
        self.lifecycle
            .compare_exchange(
                CLONE_RUNNING,
                CLONE_PUBLISHING,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    fn finish_without_publish(&self) -> bool {
        self.lifecycle
            .compare_exchange(
                CLONE_RUNNING,
                CLONE_FINISHED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    fn finish_operation(&self) {
        self.lifecycle.store(CLONE_FINISHED, Ordering::Release);
    }
}

impl Service {
    #[cfg(test)]
    pub fn clone_repository(
        &self,
        operation_id: &str,
        request: CloneRequest,
        emit: impl Fn(CloneProgress) + Send + Sync + 'static,
    ) -> Result<RepositoryLocation> {
        self.clone_repository_with_askpass(operation_id, request, emit, None)
    }

    #[cfg(test)]
    pub fn clone_repository_with_askpass(
        &self,
        operation_id: &str,
        request: CloneRequest,
        emit: impl Fn(CloneProgress) + Send + Sync + 'static,
        askpass: Option<&crate::askpass::AskpassRegistry>,
    ) -> Result<RepositoryLocation> {
        self.clone_repository_with_account(operation_id, request, emit, askpass, None)
    }

    pub fn clone_repository_with_account(
        &self,
        operation_id: &str,
        request: CloneRequest,
        emit: impl Fn(CloneProgress) + Send + Sync + 'static,
        askpass: Option<&crate::askpass::AskpassRegistry>,
        credential: Option<crate::provider_repositories::CloneCredential>,
    ) -> Result<RepositoryLocation> {
        if uuid::Uuid::parse_str(operation_id).is_err() {
            return Err(Error::new("invalidRequest", "Invalid clone operation ID"));
        }
        if request.account_id.is_some() != credential.is_some() {
            return Err(Error::new(
                "invalidAccount",
                "The selected clone account has no scoped credential",
            ));
        }
        let control = Arc::new(CloneControl::new());
        {
            let mut operations = lock(&self.clone_operations)?;
            if operations.len() >= 4 {
                return Err(Error::new(
                    "cloneLimit",
                    "At most four repository clones can run at once.",
                ));
            }
            if operations.contains_key(operation_id) {
                return Err(Error::new(
                    "invalidRequest",
                    "A clone operation with this ID already exists.",
                ));
            }
            operations.insert(operation_id.to_string(), control.clone());
        }
        let result = clone_repository(
            request,
            operation_id,
            control,
            Arc::new(emit),
            askpass,
            credential,
        );
        lock(&self.clone_operations)?.remove(operation_id);
        result
    }

    pub fn cancel_clone(&self, operation_id: &str) -> Result<()> {
        let operation = lock(&self.clone_operations)?
            .get(operation_id)
            .cloned()
            .ok_or_else(|| Error::new("invalidCloneOperation", "Clone is no longer running"))?;
        if operation.request_cancel() {
            Ok(())
        } else {
            Err(Error::new(
                "invalidCloneOperation",
                "Clone publication has already started and can no longer be cancelled",
            ))
        }
    }

    pub fn cancel_all_clones(&self) {
        if let Ok(operations) = self.clone_operations.lock() {
            for operation in operations.values() {
                operation.request_cancel();
            }
        }
    }
}

fn validate_request(request: &CloneRequest) -> Result<()> {
    if request.source.trim().is_empty()
        || request.source.len() > 8192
        || request.source.starts_with('-')
        || request.source.chars().any(char::is_control)
    {
        return Err(Error::new(
            "invalidCloneSource",
            "Enter a valid repository URL or path.",
        ));
    }
    if let Ok(url) = url::Url::parse(&request.source) {
        if matches!(url.scheme(), "http" | "https")
            && (!url.username().is_empty() || url.password().is_some())
        {
            return Err(Error::new(
                "invalidCloneSource",
                "Clone URLs cannot contain credentials. Configure a Git credential helper instead.",
            ));
        }
    }
    let name = &request.directory_name;
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.len() > 255
        || name.contains(['/', '\0'])
        || name.chars().any(char::is_control)
        || (cfg!(windows) && (name.contains('\\') || name.contains(':')))
    {
        return Err(Error::new(
            "invalidCloneDestination",
            "Choose a single valid directory name for the cloned repository.",
        ));
    }
    Ok(())
}

fn clone_repository(
    mut request: CloneRequest,
    operation_id: &str,
    control: Arc<CloneControl>,
    emit: Arc<dyn Fn(CloneProgress) + Send + Sync>,
    askpass: Option<&crate::askpass::AskpassRegistry>,
    credential: Option<crate::provider_repositories::CloneCredential>,
) -> Result<RepositoryLocation> {
    validate_request(&request)?;
    if matches!(request.parent, RepositoryLocation::Ssh { .. }) {
        return Err(Error::new(
            "unsupportedLocation",
            "Cloning into an SSH destination is not supported. Clone on that host and open it over SSH.",
        ));
    }
    let temporary_name = format!(".gitty-clone-{operation_id}");
    let (temporary, destination) = match &mut request.parent {
        RepositoryLocation::Native { path } => {
            let parent = std::fs::canonicalize(&*path)?;
            if !parent.is_dir() {
                return Err(Error::new(
                    "invalidCloneDestination",
                    "Clone parent must be a directory.",
                ));
            }
            *path = parent
                .to_str()
                .ok_or_else(|| Error::new("unsupportedEncoding", "Clone destination is not UTF-8"))?
                .into();
            (
                parent.join(&temporary_name).to_string_lossy().into_owned(),
                parent
                    .join(&request.directory_name)
                    .to_string_lossy()
                    .into_owned(),
            )
        }
        RepositoryLocation::Wsl { distribution, path } => {
            process::validate_distribution(distribution)?;
            if !path.starts_with('/') || path.contains('\0') {
                return Err(Error::new(
                    "invalidCloneDestination",
                    "WSL clone parents must be absolute Linux paths.",
                ));
            }
            let parent = path.trim_end_matches('/');
            (
                format!("{parent}/{temporary_name}"),
                format!("{parent}/{}", request.directory_name),
            )
        }
        RepositoryLocation::Ssh { .. } => {
            return Err(Error::new(
                "unsupportedLocation",
                "Cloning into an SSH destination is not supported.",
            ))
        }
    };
    ensure_absent(&request.parent, &destination)?;

    // The scoped token and its pending prompts live until the clone process ends.
    let askpass_guard = match (&request.parent, askpass.filter(|_| credential.is_none())) {
        (RepositoryLocation::Native { .. }, Some(registry)) => Some(
            registry
                .start_operation_with(crate::askpass::AskpassContext::new(&destination, "clone")),
        ),
        _ => None,
    };
    let (mut args, env) = network_args(credential.is_none(), askpass_guard.as_ref());
    if credential.is_some() {
        // Explicit account selection must never fall back to another cached user.
        args.extend(process::args(&[
            "-c",
            "credential.helper=",
            "-c",
            "http.followRedirects=false",
        ]));
    } else {
        crate::credentials::configure(&mut args, &request.parent, &request.source)?;
    }
    args.extend(crate::process::args(&[
        "clone",
        "--progress",
        "--no-recurse-submodules",
        "--no-hardlinks",
        "--",
        &request.source,
        &temporary,
    ]));
    let mut command = process::git_external_mutation_command(&request.parent, &args)?;
    for (key, value) in env {
        command.env(key, value);
    }
    let credential = credential.map(Arc::new);
    if let Some(credential) = &credential {
        credential.configure(&mut command);
    }
    let emit: Arc<dyn Fn(CloneProgress) + Send + Sync> =
        if let Some(credential) = credential.clone() {
            Arc::new(move |mut progress| {
                progress.message = credential.redact(&progress.message);
                emit(progress);
            })
        } else {
            emit
        };
    create_owned_temporary(&request.parent, &temporary)?;
    emit(CloneProgress {
        phase: "starting".into(),
        percent: None,
        message: format!("Cloning into {}", request.directory_name),
    });
    let result = run_clone(command, control.clone(), emit)
        .map(|mut output| {
            if let Some(credential) = &credential {
                output.stderr = credential
                    .redact(&String::from_utf8_lossy(&output.stderr))
                    .into_bytes();
                output.stdout = credential
                    .redact(&String::from_utf8_lossy(&output.stdout))
                    .into_bytes();
            }
            output
        })
        .map_err(|mut error| {
            if let Some(credential) = &credential {
                error.message = credential.redact(&error.message);
            }
            error
        });
    match result {
        Ok(output) if output.success => {
            if let Err(error) =
                publish_completed_clone(&control, &request.parent, &temporary, &destination)
            {
                cleanup_owned(&request.parent, &temporary);
                return Err(error);
            }
            match request.parent {
                RepositoryLocation::Native { .. } => {
                    Ok(RepositoryLocation::Native { path: destination })
                }
                RepositoryLocation::Wsl { distribution, .. } => Ok(RepositoryLocation::Wsl {
                    distribution,
                    path: destination,
                }),
                RepositoryLocation::Ssh { .. } => Err(Error::new(
                    "unsupportedLocation",
                    "Cloning into an SSH destination is not supported.",
                )),
            }
        }
        Ok(output) => {
            let completed = control.finish_without_publish();
            cleanup_owned(&request.parent, &temporary);
            if completed {
                Err(Error::new("git", report(&output)))
            } else {
                Err(cancelled_error())
            }
        }
        Err(error) => {
            let completed = control.finish_without_publish();
            cleanup_owned(&request.parent, &temporary);
            if completed {
                Err(error)
            } else {
                Err(cancelled_error())
            }
        }
    }
}

fn cancelled_error() -> Error {
    Error::new("cancelled", "Repository clone was cancelled")
}

fn publish_completed_clone(
    control: &CloneControl,
    location: &RepositoryLocation,
    temporary: &str,
    destination: &str,
) -> Result<()> {
    if !control.begin_publish() {
        return Err(cancelled_error());
    }
    let result = publish_clone(location, temporary, destination);
    control.finish_operation();
    result
}

fn create_owned_temporary(location: &RepositoryLocation, path: &str) -> Result<()> {
    match location {
        RepositoryLocation::Native { .. } => std::fs::create_dir(path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                Error::new(
                    "destinationExists",
                    "A clone temporary directory already exists; retry with a new operation.",
                )
            } else {
                error.into()
            }
        }),
        RepositoryLocation::Wsl { distribution, .. } => {
            let output = process::run_for(
                wsl_command(distribution, &["mkdir", "--", path])?,
                Duration::from_secs(30),
            )?;
            if output.success {
                Ok(())
            } else {
                Err(Error::new("io", report(&output)))
            }
        }
        RepositoryLocation::Ssh { .. } => Err(Error::new(
            "unsupportedLocation",
            "Cloning into an SSH destination is not supported.",
        )),
    }
}

fn wsl_command(distribution: &str, values: &[&str]) -> Result<Command> {
    process::validate_distribution(distribution)?;
    if !cfg!(windows) {
        return Err(Error::new(
            "unsupportedPlatform",
            "WSL is available only on Windows",
        ));
    }
    let mut command = Command::new("wsl.exe");
    command.args(["--distribution", distribution, "--exec"]);
    command.args(values);
    Ok(command)
}

fn ensure_absent(location: &RepositoryLocation, path: &str) -> Result<()> {
    let exists = match location {
        RepositoryLocation::Native { .. } => Path::new(path).exists(),
        RepositoryLocation::Wsl { distribution, .. } => {
            let output = process::run_for(
                wsl_command(distribution, &["test", "-e", path])?,
                Duration::from_secs(30),
            )?;
            match output.code {
                Some(0) => true,
                Some(1) => false,
                _ => return Err(Error::new("io", report(&output))),
            }
        }
        RepositoryLocation::Ssh { .. } => {
            return Err(Error::new(
                "unsupportedLocation",
                "Cloning into an SSH destination is not supported.",
            ))
        }
    };
    if exists {
        Err(Error::new(
            "destinationExists",
            "The clone destination already exists. Gitty never overwrites it.",
        ))
    } else {
        Ok(())
    }
}

fn cleanup_owned(location: &RepositoryLocation, path: &str) {
    match location {
        RepositoryLocation::Native { .. } => {
            let candidate = PathBuf::from(path);
            let _ = if candidate.is_dir() {
                std::fs::remove_dir_all(candidate)
            } else {
                std::fs::remove_file(candidate)
            };
        }
        RepositoryLocation::Wsl { distribution, .. } => {
            if let Ok(command) = wsl_command(distribution, &["rm", "-rf", "--", path]) {
                let _ = process::run_for(command, Duration::from_secs(30));
            }
        }
        // SSH cloning is refused before this point; nothing was created remotely.
        RepositoryLocation::Ssh { .. } => {}
    }
}

fn publish_clone(location: &RepositoryLocation, temporary: &str, destination: &str) -> Result<()> {
    ensure_absent(location, destination)?;
    match location {
        RepositoryLocation::Native { .. } => {
            rename_noreplace(Path::new(temporary), Path::new(destination))
        }
        RepositoryLocation::Wsl { distribution, .. } => {
            let output = process::run_for(
                wsl_command(
                    distribution,
                    &["mv", "-T", "--no-clobber", "--", temporary, destination],
                )?,
                Duration::from_secs(30),
            )?;
            if !output.success {
                return Err(Error::new("io", report(&output)));
            }
            // GNU mv -n succeeds when it skips an existing destination. The
            // source disappearing is therefore the authoritative success check.
            let source_still_exists = process::run_for(
                wsl_command(distribution, &["test", "-e", temporary])?,
                Duration::from_secs(30),
            )?;
            if source_still_exists.success {
                return Err(Error::new(
                    "destinationExists",
                    "The clone destination appeared before completion. It was not overwritten.",
                ));
            }
            Ok(())
        }
        RepositoryLocation::Ssh { .. } => Err(Error::new(
            "unsupportedLocation",
            "Cloning into an SSH destination is not supported.",
        )),
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn rename_noreplace(from: &Path, to: &Path) -> Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let c_from = CString::new(from.as_os_str().as_bytes())
        .map_err(|_| Error::new("invalidCloneDestination", "Clone path contains NUL"))?;
    let c_to = CString::new(to.as_os_str().as_bytes())
        .map_err(|_| Error::new("invalidCloneDestination", "Clone path contains NUL"))?;
    if unsafe { libc::renamex_np(c_from.as_ptr(), c_to.as_ptr(), libc::RENAME_EXCL) } == 0 {
        Ok(())
    } else {
        noreplace_failed(std::io::Error::last_os_error(), from, to)
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn rename_noreplace(from: &Path, to: &Path) -> Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let c_from = CString::new(from.as_os_str().as_bytes())
        .map_err(|_| Error::new("invalidCloneDestination", "Clone path contains NUL"))?;
    let c_to = CString::new(to.as_os_str().as_bytes())
        .map_err(|_| Error::new("invalidCloneDestination", "Clone path contains NUL"))?;
    if unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            c_from.as_ptr(),
            libc::AT_FDCWD,
            c_to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    } == 0
    {
        Ok(())
    } else {
        noreplace_failed(std::io::Error::last_os_error(), from, to)
    }
}

/// What to do when the no-replace rename failed. A destination that appeared is
/// refused. A filesystem that cannot do a no-replace rename at all (some network
/// and FUSE mounts answer EINVAL, ENOTSUP or ENOSYS) must not cost the user the
/// finished clone, so it gets a plain rename after an absence check.
/// shortcut: that path is not atomic, a directory created in the gap is replaced
/// if empty; only filesystems that cannot refuse atomically take it. Revisit if a
/// clone is ever reported to replace a directory the user created, or when adding
/// another non-atomic fallback.
#[cfg(unix)]
fn noreplace_failed(error: std::io::Error, from: &Path, to: &Path) -> Result<()> {
    if error.kind() == std::io::ErrorKind::AlreadyExists {
        return Err(destination_appeared());
    }
    if !noreplace_unsupported(&error) {
        return Err(error.into());
    }
    if to.symlink_metadata().is_ok() {
        return Err(destination_appeared());
    }
    std::fs::rename(from, to).map_err(Into::into)
}

#[cfg(unix)]
fn noreplace_unsupported(error: &std::io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(code) if code == libc::EINVAL
            || code == libc::ENOTSUP
            || code == libc::EOPNOTSUPP
            || code == libc::ENOSYS
    )
}

#[cfg(unix)]
fn destination_appeared() -> Error {
    Error::new(
        "destinationExists",
        "The clone destination appeared before completion. It was not overwritten.",
    )
}

#[cfg(windows)]
fn rename_noreplace(from: &Path, to: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileW;
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileW(from.as_ptr(), to.as_ptr()) } != 0 {
        Ok(())
    } else {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            Err(Error::new(
                "destinationExists",
                "The clone destination appeared before completion. It was not overwritten.",
            ))
        } else {
            Err(error.into())
        }
    }
}

fn progress_record(bytes: &[u8]) -> Option<CloneProgress> {
    let message = String::from_utf8_lossy(bytes).trim().to_string();
    if message.is_empty() {
        return None;
    }
    let percent = message.find('%').and_then(|end| {
        // `trim_end_matches` keeps the cut on a character boundary, even when a
        // multi-byte character (a server's non-English text) precedes the digits.
        let start = message[..end]
            .trim_end_matches(|c: char| c.is_ascii_digit())
            .len();
        message[start..end]
            .parse::<u8>()
            .ok()
            .filter(|value| *value <= 100)
    });
    let phase = message
        .split_once(':')
        .map(|(phase, _)| phase.trim().to_lowercase())
        .filter(|phase| !phase.is_empty())
        .unwrap_or_else(|| "receiving".into());
    Some(CloneProgress {
        phase,
        percent,
        message,
    })
}

fn capture_progress(
    mut reader: impl Read,
    overflow: Arc<AtomicBool>,
    emit: Arc<dyn Fn(CloneProgress) + Send + Sync>,
) -> std::io::Result<Vec<u8>> {
    let mut captured = Vec::new();
    let mut record = Vec::new();
    let mut buffer = [0; 8192];
    let mut pending = None;
    let mut last_emit = Instant::now()
        .checked_sub(Duration::from_millis(50))
        .unwrap_or_else(Instant::now);
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        if captured.len() + count > MAX_PROGRESS_OUTPUT {
            overflow.store(true, Ordering::Release);
        } else {
            captured.extend_from_slice(&buffer[..count]);
        }
        for byte in &buffer[..count] {
            if matches!(*byte, b'\r' | b'\n') {
                if let Some(progress) = progress_record(&record) {
                    pending = Some(progress);
                    if last_emit.elapsed() >= Duration::from_millis(50) {
                        emit(pending.take().unwrap());
                        last_emit = Instant::now();
                    }
                }
                record.clear();
            } else if record.len() < MAX_PROGRESS_RECORD {
                record.push(*byte);
            } else {
                overflow.store(true, Ordering::Release);
            }
        }
    }
    if let Some(progress) = progress_record(&record) {
        pending = Some(progress);
    }
    if let Some(progress) = pending {
        emit(progress);
    }
    Ok(captured)
}

fn run_clone(
    mut command: Command,
    control: Arc<CloneControl>,
    emit: Arc<dyn Fn(CloneProgress) + Send + Sync>,
) -> Result<Output> {
    let mut slot = lock(&control.child)?;
    if control.cancelled() {
        return Err(cancelled_error());
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|error| Error::new("processStart", error.to_string()))?;
    let overflow = Arc::new(AtomicBool::new(false));
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let (sender, receiver) = mpsc::channel();
    *slot = Some(process::ChildWait::new(child, sender.clone())?);
    drop(slot);
    let stdout_overflow = overflow.clone();
    let stderr_overflow = overflow.clone();
    let out_sender = sender.clone();
    let out = thread::spawn(move || {
        let result = process::capture(stdout, stdout_overflow);
        let _ = out_sender.send(process::ProcessEvent::Captured);
        result
    });
    let err = thread::spawn(move || {
        let result = capture_progress(stderr, stderr_overflow, emit);
        let _ = sender.send(process::ProcessEvent::Captured);
        result
    });
    let start = Instant::now();
    let mut exited = None;
    let mut captured = 0;
    let result = loop {
        let failure = if control.cancelled() {
            Some(cancelled_error())
        } else if overflow.load(Ordering::Acquire) {
            Some(Error::new(
                "outputLimit",
                "Clone output exceeded its bounded capture limit",
            ))
        } else if start.elapsed() > CLONE_TIMEOUT {
            Some(Error::new(
                "timeout",
                "Repository clone exceeded its 30 minute deadline",
            ))
        } else {
            None
        };
        if let Some(error) = failure {
            break Err(error);
        }
        if captured == 2 {
            if let Some(status) = exited.take() {
                break status;
            }
        }
        match receiver.recv_timeout(process::WAIT_CHECK_INTERVAL) {
            Ok(process::ProcessEvent::Exited(status)) => exited = Some(status.map_err(Error::from)),
            Ok(process::ProcessEvent::Captured) => captured += 1,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                break Err(Error::new("process", "Clone waiter ended unexpectedly"))
            }
        }
    };
    let mut child = lock(&control.child)?.take().unwrap();
    if result.is_err() {
        child.kill();
    }
    child.reap();
    if let Err(error) = result {
        let deadline = Instant::now() + process::READER_SHUTDOWN_TIMEOUT;
        while captured < 2 {
            match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(process::ProcessEvent::Captured) => captured += 1,
                Ok(process::ProcessEvent::Exited(_)) => {}
                Err(_) => break,
            }
        }
        for reader in [out, err] {
            if reader.is_finished() {
                let _ = reader.join();
            }
        }
        return Err(error);
    }
    let stdout = out
        .join()
        .map_err(|_| Error::new("process", "Clone stdout reader failed"))??;
    let stderr = err
        .join()
        .map_err(|_| Error::new("process", "Clone progress reader failed"))??;
    let status = result?;
    Ok(Output {
        stdout,
        stderr,
        success: status.success(),
        code: status.code(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(path: &Path, values: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(path)
            .args(values)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
            )
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{values:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().into()
    }

    #[test]
    fn parses_bounded_progress_records() {
        let progress = progress_record(b"Receiving objects: 42% (4/10)").unwrap();
        assert_eq!(progress.phase, "receiving objects");
        assert_eq!(progress.percent, Some(42));
        assert!(progress_record(b"\r").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_filesystem_without_noreplace_rename_still_publishes_the_clone() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("from");
        let to = dir.path().join("to");
        let make_source = || {
            let _ = std::fs::remove_dir_all(&from);
            std::fs::create_dir(&from).unwrap();
            std::fs::write(from.join("file"), "x").unwrap();
        };
        let os = |code| std::io::Error::from_raw_os_error(code);
        for code in [libc::EINVAL, libc::ENOTSUP, libc::ENOSYS] {
            make_source();
            noreplace_failed(os(code), &from, &to).unwrap();
            assert!(to.join("file").is_file() && !from.exists(), "{code}");
            std::fs::remove_dir_all(&to).unwrap();
        }
        // A destination that exists is never replaced, whichever way it is found.
        make_source();
        std::fs::create_dir(&to).unwrap();
        for error in [
            std::io::Error::from(std::io::ErrorKind::AlreadyExists),
            os(libc::EINVAL),
        ] {
            assert_eq!(
                noreplace_failed(error, &from, &to).unwrap_err().code,
                "destinationExists"
            );
            assert!(from.join("file").is_file());
        }
        // Any other failure is reported, not retried.
        assert_eq!(
            noreplace_failed(os(libc::EACCES), &from, &to)
                .unwrap_err()
                .code,
            "io"
        );
        assert!(from.join("file").is_file());
    }

    #[test]
    fn progress_with_multibyte_text_before_the_percentage_does_not_panic() {
        for (text, percent) in [
            ("remote: 进度：50% done", Some(50)),
            ("remote: 進捗：% done", None),
            ("remote: \u{fffd}7% done", Some(7)),
            ("remote: 完了：100%", Some(100)),
            ("remote: ：101%", None),
        ] {
            assert_eq!(
                progress_record(text.as_bytes()).unwrap().percent,
                percent,
                "{text}"
            );
        }
    }

    #[test]
    fn clones_local_repository_then_returns_an_openable_destination() {
        let source = tempfile::tempdir().unwrap();
        git(source.path(), &["init", "-b", "main"]);
        git(source.path(), &["config", "user.name", "Test"]);
        git(source.path(), &["config", "user.email", "test@example.com"]);
        std::fs::write(source.path().join("file"), "content\n").unwrap();
        git(source.path(), &["add", "file"]);
        git(source.path(), &["commit", "-m", "root"]);
        let submodule = tempfile::tempdir().unwrap();
        git(submodule.path(), &["init", "-b", "main"]);
        git(submodule.path(), &["config", "user.name", "Test"]);
        git(
            submodule.path(),
            &["config", "user.email", "test@example.com"],
        );
        std::fs::write(submodule.path().join("submodule-file"), "nested\n").unwrap();
        git(submodule.path(), &["add", "submodule-file"]);
        git(submodule.path(), &["commit", "-m", "nested"]);
        git(
            source.path(),
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                submodule.path().to_str().unwrap(),
                "nested",
            ],
        );
        git(source.path(), &["commit", "-am", "add submodule"]);
        let remote_parent = tempfile::tempdir().unwrap();
        let remote = remote_parent.path().join("remote.git");
        git(
            source.path(),
            &["clone", "--bare", ".", remote.to_str().unwrap()],
        );
        let parent = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let service = Service::new(data.path().into());
        let operation_id = uuid::Uuid::new_v4().to_string();
        let progress = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = progress.clone();
        let location = service
            .clone_repository(
                &operation_id,
                CloneRequest {
                    source: remote.to_str().unwrap().into(),
                    parent: RepositoryLocation::Native {
                        path: parent.path().to_str().unwrap().into(),
                    },
                    directory_name: "cloned repo".into(),
                    account_id: None,
                },
                move |event| captured.lock().unwrap().push(event),
            )
            .unwrap();
        let destination = parent.path().join("cloned repo");
        assert_eq!(
            std::fs::read_to_string(destination.join("file")).unwrap(),
            "content\n"
        );
        assert!(
            !destination.join("nested/submodule-file").exists(),
            "clone must not recurse into submodules"
        );
        assert!(!parent
            .path()
            .join(format!(".gitty-clone-{operation_id}"))
            .exists());
        assert!(!progress.lock().unwrap().is_empty());
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let oid = git(&remote, &["rev-parse", "HEAD"]);
            let object = format!("objects/{}/{}", &oid[..2], &oid[2..]);
            let source_object = std::fs::metadata(remote.join(&object)).unwrap();
            let cloned_object = std::fs::metadata(destination.join(".git").join(&object)).unwrap();
            assert_ne!(
                (source_object.dev(), source_object.ino()),
                (cloned_object.dev(), cloned_object.ino()),
                "local clones must copy object files instead of hardlinking them"
            );
        }
        let opened = service.open(location).unwrap();
        assert_eq!(
            opened.session.root,
            std::fs::canonicalize(destination)
                .unwrap()
                .to_str()
                .unwrap()
        );
    }

    #[test]
    fn clone_never_overwrites_destination_and_cleans_owned_temporary_directory() {
        let parent = tempfile::tempdir().unwrap();
        let destination = parent.path().join("existing");
        std::fs::create_dir(&destination).unwrap();
        std::fs::write(destination.join("precious"), "keep").unwrap();
        let data = tempfile::tempdir().unwrap();
        let service = Service::new(data.path().into());
        let request = |name: &str| CloneRequest {
            source: parent.path().join("missing").to_string_lossy().into_owned(),
            parent: RepositoryLocation::Native {
                path: parent.path().to_str().unwrap().into(),
            },
            directory_name: name.into(),
            account_id: None,
        };
        let first_id = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            service
                .clone_repository(&first_id, request("existing"), |_| {})
                .unwrap_err()
                .code,
            "destinationExists"
        );
        assert_eq!(
            std::fs::read_to_string(destination.join("precious")).unwrap(),
            "keep"
        );

        let second_id = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            service
                .clone_repository(&second_id, request("failed"), |_| {})
                .unwrap_err()
                .code,
            "git"
        );
        assert!(!parent.path().join("failed").exists());
        assert!(!parent
            .path()
            .join(format!(".gitty-clone-{second_id}"))
            .exists());
    }

    #[test]
    fn clone_rejects_credentials_and_unsafe_destination_names_before_starting() {
        let parent = RepositoryLocation::Native {
            path: "/tmp".into(),
        };
        for (source, directory_name) in [
            ("https://user:secret@example.com/repo.git", "repo"),
            ("https://example.com/repo.git", "../repo"),
            ("-dangerous", "repo"),
        ] {
            assert!(validate_request(&CloneRequest {
                source: source.into(),
                parent: parent.clone(),
                directory_name: directory_name.into(),
                account_id: None,
            })
            .is_err());
        }
    }

    #[test]
    #[cfg(unix)]
    fn cancellation_kills_and_reaps_the_clone_process_group() {
        let control = Arc::new(CloneControl::new());
        let trigger = control.clone();
        let worker = thread::spawn(move || {
            thread::sleep(Duration::from_millis(50));
            assert!(trigger.request_cancel());
        });
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30 & wait"]);
        let error = match run_clone(command, control, Arc::new(|_| {})) {
            Ok(_) => panic!("cancelled process unexpectedly succeeded"),
            Err(error) => error,
        };
        worker.join().unwrap();
        assert_eq!(error.code, "cancelled");
    }

    #[test]
    fn cancellation_and_publication_have_a_single_winner() {
        let parent = tempfile::tempdir().unwrap();
        let location = RepositoryLocation::Native {
            path: parent.path().to_string_lossy().into_owned(),
        };
        let cancelled_temporary = parent.path().join("cancelled-temporary");
        let cancelled_destination = parent.path().join("cancelled-destination");
        std::fs::create_dir(&cancelled_temporary).unwrap();
        let cancelled = CloneControl::new();
        assert!(cancelled.request_cancel());
        assert_eq!(
            publish_completed_clone(
                &cancelled,
                &location,
                cancelled_temporary.to_str().unwrap(),
                cancelled_destination.to_str().unwrap(),
            )
            .unwrap_err()
            .code,
            "cancelled"
        );
        assert!(cancelled_temporary.exists());
        assert!(!cancelled_destination.exists());

        let published_temporary = parent.path().join("published-temporary");
        let published_destination = parent.path().join("published-destination");
        std::fs::create_dir(&published_temporary).unwrap();
        let publishing = CloneControl::new();
        publish_completed_clone(
            &publishing,
            &location,
            published_temporary.to_str().unwrap(),
            published_destination.to_str().unwrap(),
        )
        .unwrap();
        assert!(!published_temporary.exists());
        assert!(published_destination.exists());
        assert!(!publishing.request_cancel());
    }

    #[test]
    #[cfg(unix)]
    fn cancellation_does_not_wait_for_escaped_pipe_holders() {
        if Command::new("python3").arg("--version").output().is_err() {
            return;
        }
        let control = Arc::new(CloneControl::new());
        let trigger = control.clone();
        let mut command = Command::new("sh");
        command.args(["-c", "python3 -c 'import os,sys,time; os.setsid(); print(\"ready\", file=sys.stderr, flush=True); time.sleep(3)' & wait"]);
        let start = Instant::now();
        let result = run_clone(
            command,
            control.clone(),
            Arc::new(move |_| {
                trigger.request_cancel();
            }),
        );
        assert!(start.elapsed() < Duration::from_secs(2));
        assert_eq!(result.err().unwrap().code, "cancelled");
        assert!(control.child.lock().unwrap().is_none());
    }
}
