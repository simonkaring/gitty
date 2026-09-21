//! All subprocesses have bounded capture, a deadline, controlled stdin and no shell.
use crate::dto::{Error, RepositoryLocation, Result};
use std::{
    io::{Read, Seek, SeekFrom, Write},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

const MAX_OUTPUT: usize = 32 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(30);
thread_local! { static REQUEST_DEADLINE: std::cell::Cell<Option<Instant>> = const { std::cell::Cell::new(None) }; }
pub fn request<T>(f: impl FnOnce() -> Result<T>) -> Result<T> {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            REQUEST_DEADLINE.with(|d| d.set(None));
        }
    }
    REQUEST_DEADLINE.with(|d| d.set(Some(Instant::now() + Duration::from_secs(60))));
    let _reset = Reset;
    f()
}

#[cfg(windows)]
pub(crate) struct ProcessJob(windows_sys::Win32::Foundation::HANDLE);
// The handle is exclusively owned and Win32 job operations may run on any thread.
#[cfg(windows)]
unsafe impl Send for ProcessJob {}
#[cfg(windows)]
impl ProcessJob {
    pub(crate) fn attach(child: &std::process::Child) -> Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(std::io::Error::last_os_error().into());
            }
            let job = Self(handle);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of_val(&info) as u32,
            ) == 0
                || AssignProcessToJobObject(handle, child.as_raw_handle()) == 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            Ok(job)
        }
    }
    pub(crate) fn kill(&self) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
        }
    }
}
#[cfg(windows)]
impl Drop for ProcessJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
pub struct Output {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub success: bool,
    pub code: Option<i32>,
}

pub(crate) fn capture(
    mut reader: impl Read,
    overflow: Arc<AtomicBool>,
) -> std::io::Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut buf = [0; 8192];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        if out.len() + n > MAX_OUTPUT {
            overflow.store(true, Ordering::Relaxed);
        } else {
            out.extend_from_slice(&buf[..n]);
        }
    }
    Ok(out)
}
pub(crate) fn remaining_timeout() -> Result<Duration> {
    let timeout = REQUEST_DEADLINE
        .with(|d| {
            d.get()
                .map(|deadline| deadline.saturating_duration_since(Instant::now()))
                .unwrap_or(TIMEOUT)
        })
        .min(TIMEOUT);
    if timeout.is_zero() {
        return Err(Error::new(
            "timeout",
            "Repository request exceeded its 60 second deadline",
        ));
    }
    Ok(timeout)
}
pub fn run(mut command: Command) -> Result<Output> {
    run_with_timeout(&mut command, remaining_timeout()?)
}
fn run_with_timeout(command: &mut Command, timeout: Duration) -> Result<Output> {
    run_with_stdin(command, timeout, Stdio::null())
}
fn run_with_stdin(command: &mut Command, timeout: Duration, stdin: Stdio) -> Result<Output> {
    command
        .stdin(stdin)
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
        .map_err(|e| Error::new("processStart", e.to_string()))?;
    #[cfg(windows)]
    let job = match ProcessJob::attach(&child) {
        Ok(job) => job,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    };
    let overflow = Arc::new(AtomicBool::new(false));
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let a = overflow.clone();
    let b = overflow.clone();
    let out = thread::spawn(move || capture(stdout, a));
    let err = thread::spawn(move || capture(stderr, b));
    let start = Instant::now();
    let mut failure = None;
    let mut exited = None;
    let status = loop {
        if overflow.load(Ordering::Relaxed) || start.elapsed() > timeout {
            failure = Some(if overflow.load(Ordering::Relaxed) {
                Error::new(
                    "outputLimit",
                    "Git output exceeded the 32 MiB per-stream limit; narrow the request",
                )
            } else {
                Error::new(
                    "timeout",
                    format!("Command exceeded its {} ms deadline", timeout.as_millis()),
                )
            });
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            #[cfg(windows)]
            job.kill();
            let _ = child.kill();
            break child.wait();
        }
        if let Some(status) = exited {
            if out.is_finished() && err.is_finished() {
                break Ok(status);
            }
            thread::sleep(Duration::from_millis(10));
            continue;
        }
        match child.try_wait() {
            Ok(Some(s)) => {
                exited = Some(s);
            }
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(e);
            }
        }
    };
    let stdout = out
        .join()
        .map_err(|_| Error::new("process", "Output reader failed"))??;
    let stderr = err
        .join()
        .map_err(|_| Error::new("process", "Error reader failed"))??;
    if let Some(e) = failure {
        return Err(e);
    }
    if overflow.load(Ordering::Relaxed) {
        return Err(Error::new("outputLimit", "Command output exceeded 32 MiB"));
    }
    let status = status?;
    Ok(Output {
        stdout,
        stderr,
        success: status.success(),
        code: status.code(),
    })
}
pub fn text(bytes: Vec<u8>) -> Result<String> {
    String::from_utf8(bytes).map_err(|_| {
        Error::new(
            "unsupportedEncoding",
            "Non-UTF-8 Git paths or metadata cannot be represented by the JSON contract",
        )
    })
}
pub fn text_ref(bytes: &[u8]) -> Result<&str> {
    std::str::from_utf8(bytes).map_err(|_| {
        Error::new(
            "unsupportedEncoding",
            "Non-UTF-8 Git paths or metadata cannot be represented by the JSON contract",
        )
    })
}
pub fn git(location: &RepositoryLocation, args: &[String]) -> Result<Output> {
    run(git_command(location, args)?)
}
pub(crate) fn git_command(location: &RepositoryLocation, args: &[String]) -> Result<Command> {
    let mut cmd = match location {
        RepositoryLocation::Native { path } => {
            if path.to_ascii_lowercase().starts_with("\\\\wsl") {
                return Err(Error::new(
                    "wslLocationRequired",
                    "Open WSL repositories through their distribution, not Windows Git on UNC",
                ));
            }
            let mut c = Command::new("git");
            c.arg("-C").arg(path);
            c
        }
        RepositoryLocation::Wsl { distribution, path } => {
            if !cfg!(windows) {
                return Err(Error::new(
                    "unsupportedPlatform",
                    "WSL is available only on Windows",
                ));
            }
            validate_distribution(distribution)?;
            let mut c = Command::new("wsl.exe");
            c.args([
                "--distribution",
                distribution,
                "--exec",
                "env",
                "GIT_OPTIONAL_LOCKS=0",
                "GIT_NO_LAZY_FETCH=1",
                "GIT_TERMINAL_PROMPT=0",
                "GIT_NO_REPLACE_OBJECTS=1",
                "GIT_LITERAL_PATHSPECS=1",
                "GIT_PAGER=cat",
                "LC_ALL=C",
                "git",
                "-C",
                path,
            ]);
            c
        }
    };
    // Repository/index/object-store overrides must not redirect this session. Honor
    // native configuration-file selectors, including administrators' system config.
    for (key, _) in std::env::vars_os() {
        let name = key.to_string_lossy();
        let config_selector = matches!(location, RepositoryLocation::Native { .. })
            && matches!(
                name.as_ref(),
                "GIT_CONFIG_GLOBAL" | "GIT_CONFIG_SYSTEM" | "GIT_CONFIG_NOSYSTEM"
            );
        if name.starts_with("GIT_") && !config_selector {
            cmd.env_remove(key);
        }
    }
    cmd.env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("LC_ALL", "C");
    cmd.args([
        "--no-pager",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "maintenance.auto=false",
        "-c",
        "gc.auto=0",
        "-c",
        "diff.external=",
        "-c",
        "core.quotePath=true",
        "-c",
        "core.pager=cat",
        "-c",
        "protocol.allow=never",
        "-c",
        "diff.submodule=short",
    ]);
    cmd.args(args);
    Ok(cmd)
}
pub fn checked(location: &RepositoryLocation, args: &[String]) -> Result<Vec<u8>> {
    checked_output(git(location, args)?)
}
pub fn checked_with_input(
    location: &RepositoryLocation,
    args: &[String],
    input: &[u8],
) -> Result<Vec<u8>> {
    if input.len() > 32 * 1024 {
        return Err(Error::new("inputLimit", "Git batch input exceeded 32 KiB"));
    }
    // A bounded anonymous file supplies EOF without a pipe writer that could
    // deadlock against full stdout/stderr pipes. WSL requests pass this stdin
    // handle to wsl.exe using the same command runner.
    let mut file = tempfile::tempfile()?;
    file.write_all(input)?;
    file.seek(SeekFrom::Start(0))?;
    let mut command = git_command(location, args)?;
    checked_output(run_with_stdin(
        &mut command,
        remaining_timeout()?,
        file.into(),
    )?)
}
fn checked_output(o: Output) -> Result<Vec<u8>> {
    if !o.success {
        return Err(Error::new(
            "git",
            String::from_utf8_lossy(&o.stderr).trim().to_string(),
        ));
    }
    Ok(o.stdout)
}
pub fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| s.to_string()).collect()
}
pub fn validate_distribution(name: &str) -> Result<()> {
    if name.is_empty() || name.starts_with('-') || name.chars().any(|c| c.is_control()) {
        return Err(Error::new(
            "invalidDistribution",
            "Invalid WSL distribution name",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn non_utf8_metadata_is_never_lossily_aliased() {
        assert_eq!(
            text(vec![b'x', 0xff]).unwrap_err().code,
            "unsupportedEncoding"
        );
    }
    #[test]
    fn output_capture_is_bounded() {
        let overflow = Arc::new(AtomicBool::new(false));
        let bytes = capture(
            std::io::repeat(b'x').take((MAX_OUTPUT + 1) as u64),
            overflow.clone(),
        )
        .unwrap();
        assert!(bytes.len() <= MAX_OUTPUT);
        assert!(overflow.load(Ordering::Relaxed));
    }
    #[test]
    #[cfg(unix)]
    fn deadline_kills_process() {
        let mut c = Command::new("sleep");
        c.arg("5");
        assert_eq!(
            run_with_timeout(&mut c, Duration::from_millis(30))
                .err()
                .unwrap()
                .code,
            "timeout"
        );
    }
}
