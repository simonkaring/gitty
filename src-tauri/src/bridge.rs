//! Shared hardening for the loopback helper bridges (askpass and editor).
//!
//! Any local process can connect to a 127.0.0.1 listener, so every connection is
//! bounded before authentication: a cap on concurrent connections, an absolute
//! handshake deadline, and (in the callers) byte limits on what is read.
use std::io::{self, BufRead, Read};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

/// Concurrent connections served by one bridge listener.
pub(crate) const MAX_CONNECTIONS: usize = 16;
/// Absolute time a client has to complete the unauthenticated/request handshake.
pub(crate) const HANDSHAKE_DEADLINE: Duration = Duration::from_secs(10);
/// Bound on how long a reply may block on a client that stopped reading.
pub(crate) const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// Helper scripts older than this are assumed to belong to a dead process.
pub(crate) const STALE_HELPER_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[derive(Clone)]
pub(crate) struct ConnectionLimiter {
    active: Arc<AtomicUsize>,
    max: usize,
}

/// Releases its slot when dropped, including when a handler thread panics.
pub(crate) struct ConnectionPermit(Arc<AtomicUsize>);

impl Drop for ConnectionPermit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl ConnectionLimiter {
    pub(crate) fn new(max: usize) -> Self {
        Self {
            active: Arc::new(AtomicUsize::new(0)),
            max,
        }
    }

    pub(crate) fn try_acquire(&self) -> Option<ConnectionPermit> {
        self.active
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                (n < self.max).then_some(n + 1)
            })
            .ok()
            .map(|_| ConnectionPermit(self.active.clone()))
    }

    #[cfg(test)]
    pub(crate) fn in_flight(&self) -> usize {
        self.active.load(Ordering::SeqCst)
    }
}

/// Accepts connections forever, handing each to `handler` on its own thread with
/// its request id. Connections beyond the limiter's cap are dropped unread.
pub(crate) fn serve<F>(listener: TcpListener, limiter: ConnectionLimiter, handler: F)
where
    F: Fn(TcpStream, usize) + Send + Sync + 'static,
{
    let handler = Arc::new(handler);
    let mut next_id = 1usize;
    for stream in listener.incoming().flatten() {
        let Some(permit) = limiter.try_acquire() else {
            drop(stream);
            continue;
        };
        let request_id = next_id;
        next_id += 1;
        let handler = handler.clone();
        // A failed spawn drops the closure, and with it the stream and permit.
        let _ = std::thread::Builder::new()
            .name("gitty-bridge-connection".into())
            .spawn(move || {
                let _permit = permit;
                handler(stream, request_id);
            });
    }
}

/// A socket reader whose every read is limited by one absolute deadline, so a
/// client that dribbles bytes cannot keep a connection open indefinitely.
pub(crate) struct DeadlineReader<'a> {
    stream: &'a TcpStream,
    deadline: Instant,
}

impl<'a> DeadlineReader<'a> {
    pub(crate) fn new(stream: &'a TcpStream, deadline: Instant) -> Self {
        Self { stream, deadline }
    }
}

impl Read for DeadlineReader<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let remaining = self
            .deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| io::Error::from(io::ErrorKind::TimedOut))?;
        self.stream.set_read_timeout(Some(remaining))?;
        self.stream.read(buf)
    }
}

/// Reads one `\n`-terminated line of at most `max` bytes (terminator included).
/// An oversize, unterminated or non-UTF-8 line is an error; the bytes beyond the
/// limit are never buffered.
pub(crate) fn read_bounded_line(reader: &mut impl BufRead, max: u64) -> io::Result<String> {
    let mut line = Vec::new();
    reader.by_ref().take(max).read_until(b'\n', &mut line)?;
    if line.last() != Some(&b'\n') {
        return Err(io::ErrorKind::InvalidData.into());
    }
    String::from_utf8(line).map_err(|_| io::ErrorKind::InvalidData.into())
}

/// Best-effort removal of `<prefix><uuid>.sh|.bat` helper scripts that a previous
/// run left in `dir`. Only regular files with exactly that name and an age of at
/// least `max_age` are removed; directories and symlinks are never touched.
pub(crate) fn remove_stale_helpers(dir: &Path, prefix: &str, max_age: Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(rest) = name.strip_prefix(prefix) else {
            continue;
        };
        let Some(id) = rest
            .strip_suffix(".sh")
            .or_else(|| rest.strip_suffix(".bat"))
        else {
            continue;
        };
        if uuid::Uuid::parse_str(id).is_err() {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.file_type().is_file() {
            continue;
        }
        let old_enough = meta
            .modified()
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age >= max_age);
        if old_enough {
            let _ = std::fs::remove_file(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Write};

    fn wait_for(mut condition: impl FnMut() -> bool) -> bool {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(5) {
            if condition() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }

    #[test]
    fn connections_beyond_the_cap_are_refused_and_slots_recover() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let limiter = ConnectionLimiter::new(2);
        let observer = limiter.clone();
        std::thread::spawn(move || {
            serve(listener, limiter, |mut stream, _| {
                let _ = stream.write_all(b"k");
                // Hold the slot until the client hangs up.
                let mut byte = [0u8; 1];
                let _ = stream.read(&mut byte);
            })
        });

        let served = |stream: &mut TcpStream| {
            let mut byte = [0u8; 1];
            matches!(stream.read(&mut byte), Ok(1)) && byte == *b"k"
        };
        let mut first = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut second = TcpStream::connect(("127.0.0.1", port)).unwrap();
        assert!(served(&mut first) && served(&mut second));
        assert_eq!(observer.in_flight(), 2);

        let mut refused = TcpStream::connect(("127.0.0.1", port)).unwrap();
        refused
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        assert!(!served(&mut refused), "third connection must be dropped");
        assert_eq!(observer.in_flight(), 2);

        drop((first, second));
        assert!(wait_for(|| observer.in_flight() == 0));
        let mut again = TcpStream::connect(("127.0.0.1", port)).unwrap();
        assert!(served(&mut again), "slots are reusable after release");
    }

    #[test]
    fn permit_is_released_when_the_handler_panics() {
        let limiter = ConnectionLimiter::new(1);
        let permit = limiter.try_acquire().unwrap();
        assert!(limiter.try_acquire().is_none());
        let _ = std::thread::spawn(move || {
            let _permit = permit;
            panic!("handler failure");
        })
        .join();
        assert_eq!(limiter.in_flight(), 0);
        assert!(limiter.try_acquire().is_some());
    }

    #[test]
    fn bounded_lines_reject_oversize_unterminated_and_invalid_input() {
        let mut ok = BufReader::new(&b"abc\nrest"[..]);
        assert_eq!(read_bounded_line(&mut ok, 8).unwrap(), "abc\n");
        let mut exact = BufReader::new(&b"abcdefg\n"[..]);
        assert_eq!(read_bounded_line(&mut exact, 8).unwrap(), "abcdefg\n");
        let mut long = BufReader::new(&b"abcdefgh\n"[..]);
        assert!(read_bounded_line(&mut long, 8).is_err());
        let mut endless = BufReader::new(std::io::repeat(b'a'));
        assert!(read_bounded_line(&mut endless, 8).is_err());
        let mut eof = BufReader::new(&b"abc"[..]);
        assert!(read_bounded_line(&mut eof, 8).is_err());
        let mut invalid = BufReader::new(&b"\xff\xfe\n"[..]);
        assert!(read_bounded_line(&mut invalid, 8).is_err());
    }

    #[test]
    fn stale_helper_cleanup_only_removes_old_matching_regular_files() {
        let dir = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4();
        let old = dir.path().join(format!("gitty-askpass-{id}.sh"));
        let old_bat = dir
            .path()
            .join(format!("gitty-askpass-{}.bat", uuid::Uuid::new_v4()));
        let fresh = dir
            .path()
            .join(format!("gitty-askpass-{}.sh", uuid::Uuid::new_v4()));
        let other_prefix = dir.path().join(format!("gitty-editor-{id}.sh"));
        let not_uuid = dir.path().join("gitty-askpass-notes.sh");
        let wrong_ext = dir.path().join(format!("gitty-askpass-{id}.txt"));
        let directory = dir
            .path()
            .join(format!("gitty-askpass-{}.sh", uuid::Uuid::new_v4()));
        for path in [&old, &old_bat, &fresh, &other_prefix, &not_uuid, &wrong_ext] {
            std::fs::write(path, "x").unwrap();
        }
        std::fs::create_dir(&directory).unwrap();
        let aged = SystemTime::now() - Duration::from_secs(3 * 24 * 60 * 60);
        for path in [&old, &old_bat, &other_prefix, &not_uuid, &wrong_ext] {
            std::fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(aged)
                .unwrap();
        }

        remove_stale_helpers(
            dir.path(),
            "gitty-askpass-",
            Duration::from_secs(24 * 60 * 60),
        );
        assert!(!old.exists() && !old_bat.exists());
        assert!(fresh.exists());
        assert!(other_prefix.exists() && not_uuid.exists() && wrong_ext.exists());
        assert!(directory.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn stale_helper_cleanup_never_follows_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("precious");
        std::fs::write(&outside, "keep").unwrap();
        let link = dir
            .path()
            .join(format!("gitty-askpass-{}.sh", uuid::Uuid::new_v4()));
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        remove_stale_helpers(dir.path(), "gitty-askpass-", Duration::ZERO);
        assert!(std::fs::symlink_metadata(&link).is_ok());
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep");
    }
}
