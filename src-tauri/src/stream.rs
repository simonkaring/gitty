//! A single pinned Git walk, consumed with bounded backpressure instead of captured wholesale.
use crate::{dto::*, process};
use std::{
    io::{BufRead, BufReader, Read},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver},
        Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

/// Upper bound for stdin revision input; each tip line is at most 65 bytes.
pub const MAX_STDIN_INPUT: usize = 16 * 1024 * 1024;

/// Encodes revisions as the newline-terminated list `git --stdin` expects.
pub fn revision_input(revisions: &[String]) -> Result<Vec<u8>> {
    let mut input = Vec::with_capacity(revisions.len() * 41);
    for revision in revisions {
        if revision.is_empty() || revision.bytes().any(|b| b == b'\n' || b == b'\0') {
            return Err(Error::new("gitParse", "Invalid revision for Git stdin"));
        }
        if input.len() + revision.len() + 1 > MAX_STDIN_INPUT {
            return Err(Error::new(
                "inputLimit",
                format!("Git stdin input exceeded {MAX_STDIN_INPUT} bytes"),
            ));
        }
        input.extend_from_slice(revision.as_bytes());
        input.push(b'\n');
    }
    Ok(input)
}

pub struct GitStream {
    child: Child,
    receiver: Option<Receiver<Result<Option<Vec<u8>>>>>,
    reader: Option<JoinHandle<()>>,
    stderr: Option<JoinHandle<std::io::Result<Vec<u8>>>>,
    overflow: Arc<AtomicBool>,
    finished: bool,
    allow_difference_exit: bool,
    cancel: Option<Arc<AtomicBool>>,
    #[cfg(windows)]
    job: process::ProcessJob,
}
impl GitStream {
    pub fn git(
        location: &RepositoryLocation,
        args: &[String],
        delimiter: u8,
        max_record: usize,
    ) -> Result<Self> {
        Self::spawn(
            process::git_command(location, args)?,
            Stdio::null(),
            delimiter,
            max_record,
        )
    }
    /// Like [`GitStream::git`], but Git reads `input` on stdin (bounded by
    /// `MAX_STDIN_INPUT`). Revision lists belong here, never on argv, whose length
    /// limit (~32 KiB on Windows) a repository with many refs easily exceeds.
    pub fn git_with_input(
        location: &RepositoryLocation,
        args: &[String],
        input: &[u8],
        delimiter: u8,
        max_record: usize,
    ) -> Result<Self> {
        let stdin = process::input_stdio(input, MAX_STDIN_INPUT)?;
        Self::spawn(
            process::git_command(location, args)?,
            stdin,
            delimiter,
            max_record,
        )
    }
    pub fn diff(location: &RepositoryLocation, args: &[String]) -> Result<Self> {
        let mut stream = Self::git(location, args, b'\n', 32 * 1024 * 1024)?;
        // --no-index signals differences with exit 1; all other failures remain errors.
        stream.allow_difference_exit = true;
        Ok(stream)
    }
    fn spawn(mut command: Command, stdin: Stdio, delimiter: u8, max_record: usize) -> Result<Self> {
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
        process::note_spawn();
        #[cfg(windows)]
        let job = match process::ProcessJob::attach(&child) {
            Ok(job) => job,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
        };
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        // One queued record plus one being read: history uses <= 128 bytes per record.
        let (sender, receiver) = mpsc::sync_channel(1);
        let reader = thread::spawn(move || {
            let mut input = BufReader::new(stdout);
            loop {
                let mut record = Vec::new();
                let result = (&mut input)
                    .take(max_record as u64 + 1)
                    .read_until(delimiter, &mut record);
                let message = match result {
                    Err(e) => Err(e.into()),
                    Ok(0) => Ok(None),
                    Ok(_) if record.len() > max_record => Err(Error::new(
                        "outputLimit",
                        "Git stream record exceeded its size limit",
                    )),
                    Ok(_) => {
                        if record.last() == Some(&delimiter) {
                            record.pop();
                        }
                        Ok(Some(record))
                    }
                };
                let done = !matches!(message, Ok(Some(_)));
                if sender.send(message).is_err() || done {
                    break;
                }
            }
        });
        let overflow = Arc::new(AtomicBool::new(false));
        let flag = overflow.clone();
        let stderr = thread::spawn(move || process::capture(stderr, flag));
        Ok(Self {
            child,
            receiver: Some(receiver),
            reader: Some(reader),
            stderr: Some(stderr),
            overflow,
            finished: false,
            allow_difference_exit: false,
            cancel: None,
            #[cfg(windows)]
            job,
        })
    }
    /// Makes `next` fail with the `cancelled` error as soon as `flag` is set, even
    /// while Git is still scanning and has produced no record. Dropping the stream
    /// afterwards kills and reaps the child.
    pub fn with_cancel(mut self, flag: Arc<AtomicBool>) -> Self {
        self.cancel = Some(flag);
        self
    }
    fn check_cancelled(&self) -> Result<()> {
        if self
            .cancel
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::Relaxed))
        {
            return Err(Error::new("cancelled", "Stream cancelled"));
        }
        Ok(())
    }
    pub fn next(&mut self) -> Result<Option<Vec<u8>>> {
        if self.finished {
            return Ok(None);
        }
        let deadline = Instant::now() + process::remaining_timeout()?;
        loop {
            self.check_cancelled()?;
            if self.overflow.load(Ordering::Relaxed) {
                return Err(Error::new("outputLimit", "Git stderr exceeded 32 MiB"));
            }
            if Instant::now() >= deadline {
                return Err(Error::new(
                    "timeout",
                    "Timed out waiting for the next Git stream record",
                ));
            }
            match self
                .receiver
                .as_ref()
                .unwrap()
                .recv_timeout(Duration::from_millis(10))
            {
                Ok(Ok(Some(record))) => return Ok(Some(record)),
                Ok(Err(error)) => return Err(error),
                Ok(Ok(None)) => {
                    // EOF is not success until Git's exit status and stderr have been collected.
                    let mut nap = Duration::from_millis(1);
                    loop {
                        self.check_cancelled()?;
                        if Instant::now() >= deadline {
                            return Err(Error::new("timeout", "Timed out finalizing Git stream"));
                        }
                        if self.stderr.as_ref().is_some_and(|r| r.is_finished()) {
                            if let Some(status) = self.child.try_wait()? {
                                let stderr =
                                    self.stderr.take().unwrap().join().map_err(|_| {
                                        Error::new("process", "Git stderr reader failed")
                                    })??;
                                self.finished = true;
                                if self.overflow.load(Ordering::Relaxed) {
                                    return Err(Error::new(
                                        "outputLimit",
                                        "Git stderr exceeded 32 MiB",
                                    ));
                                }
                                if !status.success()
                                    && !(self.allow_difference_exit && status.code() == Some(1))
                                {
                                    return Err(Error::new(
                                        "git",
                                        String::from_utf8_lossy(&stderr).trim().to_string(),
                                    ));
                                }
                                return Ok(None);
                            }
                        }
                        thread::sleep(nap);
                        nap = (nap * 2).min(Duration::from_millis(10));
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(Error::new("process", "Git stream ended unexpectedly"))
                }
            }
        }
    }
}
impl Drop for GitStream {
    fn drop(&mut self) {
        // Disconnect first, so a producer blocked by backpressure can leave its send().
        self.receiver.take();
        if !self.finished {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(self.child.id() as i32), libc::SIGKILL);
            }
            #[cfg(windows)]
            self.job.kill();
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        if let Some(stderr) = self.stderr.take() {
            let _ = stderr.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn git_exit_errors_are_not_mistaken_for_empty_history() {
        let mut command = Command::new("git");
        command.arg("--gitty-invalid-option");
        let mut stream = GitStream::spawn(command, Stdio::null(), b'\n', 128).unwrap();
        assert_eq!(stream.next().unwrap_err().code, "git");
    }
    #[test]
    #[cfg(unix)]
    fn oversized_stream_records_return_explicit_errors() {
        let mut command = Command::new("yes");
        command.arg("a record longer than eight bytes");
        let mut stream = GitStream::spawn(command, Stdio::null(), b'\n', 8).unwrap();
        assert_eq!(stream.next().unwrap_err().code, "outputLimit");
    }
    #[test]
    #[cfg(unix)]
    fn dropping_an_unconsumed_stream_reaps_process_and_readers() {
        let mut command = Command::new("yes");
        command.arg("record");
        let stream = GitStream::spawn(command, Stdio::null(), b'\n', 128).unwrap();
        let id = stream.child.id();
        drop(stream);
        assert_eq!(unsafe { libc::kill(id as i32, 0) }, -1);
    }
    #[test]
    #[cfg(unix)]
    fn cancelling_interrupts_a_silent_stream_promptly_and_reaps_it() {
        let mut command = Command::new("sleep");
        command.arg("60");
        let flag = Arc::new(AtomicBool::new(false));
        let mut stream = GitStream::spawn(command, Stdio::null(), b'\n', 8)
            .unwrap()
            .with_cancel(flag.clone());
        let id = stream.child.id();
        let canceller = thread::spawn({
            let flag = flag.clone();
            move || {
                thread::sleep(Duration::from_millis(50));
                flag.store(true, Ordering::Relaxed);
            }
        });
        let start = Instant::now();
        assert_eq!(stream.next().unwrap_err().code, "cancelled");
        assert!(start.elapsed() < Duration::from_secs(5));
        canceller.join().unwrap();
        drop(stream);
        assert_eq!(unsafe { libc::kill(id as i32, 0) }, -1);
    }
    #[test]
    fn revision_input_is_newline_terminated_and_bounded() {
        let ids = vec!["a".repeat(40), "b".repeat(64)];
        let input = revision_input(&ids).unwrap();
        assert_eq!(input, format!("{}\n{}\n", ids[0], ids[1]).into_bytes());
        assert_eq!(revision_input(&[]).unwrap(), b"");
        assert_eq!(
            revision_input(&["a\nb".into()]).unwrap_err().code,
            "gitParse"
        );
        let many = vec!["a".repeat(63); MAX_STDIN_INPUT / 64 + 1];
        assert_eq!(revision_input(&many).unwrap_err().code, "inputLimit");
        assert!(process::input_stdio(&[0; 9], 8).is_err());
    }
    #[test]
    #[cfg(unix)]
    fn stdin_streams_deliver_input_and_are_reaped_on_drop() {
        let mut command = Command::new("cat");
        command.arg("-");
        let mut stream = GitStream::spawn(
            command,
            process::input_stdio(b"one\ntwo\n", 64).unwrap(),
            b'\n',
            8,
        )
        .unwrap();
        assert_eq!(stream.next().unwrap().unwrap(), b"one");
        assert_eq!(stream.next().unwrap().unwrap(), b"two");
        assert!(stream.next().unwrap().is_none());
        // An unconsumed stream with stdin must still be killed and reaped.
        let mut command = Command::new("sh");
        command.args(["-c", "cat; sleep 60"]);
        let stream =
            GitStream::spawn(command, process::input_stdio(b"x\n", 64).unwrap(), b'\n', 8).unwrap();
        let id = stream.child.id();
        drop(stream);
        assert_eq!(unsafe { libc::kill(id as i32, 0) }, -1);
    }
}
