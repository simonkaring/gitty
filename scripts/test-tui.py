"""macOS PTY smoke: cargo build -p gitty-cli && python3 scripts/test-tui.py."""

import errno
import codecs
import fcntl
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BIN = Path("target/debug/gitty-cli").resolve()


def git(repo, *args):
    return subprocess.check_output(
        ["git", "-C", str(repo), *args], stderr=subprocess.STDOUT
    ).strip()


class AuthFixture(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.headers.get("Authorization") == "Basic dHVpLXVzZXI6dHVpLXBhc3M=":
            self.server.answered.set()
            self.send_response(403)
        else:
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="tui-smoke"')
        self.end_headers()

    def log_message(self, *args):
        pass


def main(root, auth):
    repo, remote = root / "work", root / "remote"
    repo.mkdir()
    remote.mkdir()
    git(repo, "init", "-b", "main")
    git(remote, "init", "--bare", "-b", "main")
    git(repo, "config", "user.name", "TUI smoke")
    git(repo, "config", "user.email", "tui@example.invalid")
    git(repo, "config", "commit.gpgsign", "false")
    git(repo, "config", "core.hooksPath", ".git/hooks")
    git(repo, "remote", "add", "origin", str(remote))
    git(repo, "remote", "add", "z-auth", f"http://127.0.0.1:{auth.server_port}/repo")
    git(repo, "config", "credential.helper", "")
    (repo / "file.txt").write_text("first line\n")
    git(repo, "add", "file.txt")
    git(repo, "commit", "-m", "fixture initial commit")
    (repo / "file.txt").write_text("new line reviewed\n")
    # A controlling terminal must exist for the TUI, but not for its hook.
    hook = repo / ".git/hooks/pre-commit"
    hook.write_text(
        "#!/bin/sh\nif ( : < /dev/tty ) 2>/dev/null; then exit 1; fi\n"
        "printf 'isolated' > .git/tui-isolated\n"
    )
    hook.chmod(0o755)

    pid, fd = pty.fork()
    if pid == 0:
        # Closing the master after the restore sequence must not signal the child.
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        os.environ["TERM"] = "xterm-256color"
        os.execv(BIN, [str(BIN), "tui", "--repo", str(repo)])

    screen = {}
    cursor = (0, 0)
    pending = ""
    decoder = codecs.getincrementaldecoder("utf-8")()

    def update(data):
        nonlocal cursor, pending
        pending += decoder.decode(data)
        while pending:
            if pending.startswith("\x1b"):
                command = re.match(r"\x1b\[([0-?]*)([ -/]*)([@-~])", pending)
                if not command:
                    return
                params, _, code = command.groups()
                if code == "H":
                    row, col = (params or "1;1").split(";")
                    cursor = int(row) - 1, int(col) - 1
                elif (code, params) in [("J", "2"), ("h", "?1049")]:
                    screen.clear()
                pending = pending[command.end() :]
                continue
            row, col = cursor
            screen.setdefault(row, {})[col] = pending[0]
            cursor = row, col + 1
            pending = pending[1:]

    def resize(columns):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, columns, 0, 0))

    def pump_until(done, what):
        # Keep reading: a TUI blocks once the terminal stops draining its output.
        seen = bytearray()
        deadline = time.monotonic() + 10
        while not done(seen) and time.monotonic() < deadline:
            if not select.select([fd], [], [], 0.1)[0]:
                continue
            try:
                data = os.read(fd, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                data = b""
            if not data:
                break
            seen.extend(data)
            update(data)
        assert done(seen), (what, seen[:2000])

    def expect(text):
        def matched(seen):
            if text.startswith(b"\x1b"):
                return text in seen
            return any(
                text.decode() in "".join(line.get(col, " ") for col in range(max(line) + 1))
                for line in screen.values()
            )

        pump_until(matched, text)

    def idle():
        # Screen text can outlive the action that wrote it; wait for Git to finish.
        def done(_):
            rows = ["".join(line.get(col, " ") for col in range(max(line) + 1)) for line in screen.values()]
            return not any("Running Git" in row for row in rows)

        pump_until(done, "the running Git action to finish")

    def key(value):
        os.write(fd, value)

    reaped = False
    try:
        resize(80)
        expect(b"fixture initial commit")
        # A double click on the first history row (screen row 4) opens the commit.
        click = b"\x1b[<0;30;4M\x1b[<0;30;4m"
        key(click + click)
        expect(b"Files \xc2\xb7 1")
        key(b"\x1b")
        expect(b"History")
        key(b"\r")
        expect(b"file.txt")
        key(b"\r")
        expect(b"+ first line")
        key(b"\x1b")
        expect(b"scroll message")
        key(b"w")
        expect(b"tab staged")
        key(b"s")
        expect(b"+ new line reviewed")
        key(b"\r")
        expect(b"Staged.")
        assert git(repo, "diff", "--cached", "--name-only") == b"file.txt"
        key(b"c")
        expect(b"Summary of the change")
        key(b"terminal commit\x1bOQ")
        expect(b"Committed")
        assert git(repo, "log", "-1", "--format=%s") == b"terminal commit"
        assert (repo / ".git/tui-isolated").read_text() == "isolated"
        key(b"m")
        expect(b"publish to set one")
        key(b"b")
        expect(b"Destination branch")
        key(b"\r")
        expect(b"enter confirm")
        key(b"\r")
        expect(b"Publish completed.")
        assert git(repo, "rev-parse", "HEAD") == git(remote, "rev-parse", "refs/heads/main")
        (repo / "file.txt").write_text("stashed edit\n")
        key(b"z")
        expect(b"Stash 1 change")
        key(b"\r")
        expect(b"Stashed your changes.")
        assert (repo / "file.txt").read_text() == "new line reviewed\n"
        assert len(git(repo, "stash", "list").splitlines()) == 1
        # The toolbar's Pop button sits at columns 52-58 of row 2 at this width.
        key(b"\x1b[<0;54;2M\x1b[<0;54;2m")
        expect(b"Pop the latest stash")
        key(b"\r")
        expect(b"Restored the stash")
        assert (repo / "file.txt").read_text() == "stashed edit\n"
        assert git(repo, "stash", "list") == b""
        key(b"jf")
        expect(b"enter confirm")
        key(b"\r")
        expect(b"Git username (masked)")
        key(b"tui-user\r")
        expect(b"Git password or credential (masked)")
        key(b"tui-pass\r")
        pump_until(lambda _: auth.answered.is_set(), "Git did not receive both values from askpass")
        expect(b"Git did not complete the action.")
        key(b"f")
        expect(b"enter confirm")
        key(b"\r")
        expect(b"Git username (masked)")
        key(b"\x1b")
        idle()
        expect(b"Git did not complete the action.")
        resize(46)
        expect(b"Sync")
        key(b"f")
        expect(b"enter confirm")
        key(b"\r")
        expect(b"Git username (masked)")
        # Quitting from a pending prompt cancels it, then waits for Git to stop.
        key(b"\x03")
        expect(b"\x1b[?1049l")
        deadline = time.monotonic() + 3
        ending = b""
        while time.monotonic() < deadline:
            child, status = os.waitpid(pid, os.WNOHANG)
            if child:
                reaped = True
                break
            if select.select([fd], [], [], 0.1)[0]:
                try:
                    ending += os.read(fd, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
        assert reaped, ("TUI restored but did not exit", ending)
        assert status == 0, (status, ending)
    finally:
        if not reaped:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        os.close(fd)
        if not reaped:
            os.waitpid(pid, 0)


if __name__ == "__main__":
    import sys

    assert sys.platform == "darwin", "this smoke includes macOS-only write paths"
    with ThreadingHTTPServer(("127.0.0.1", 0), AuthFixture) as auth:
        auth.answered = threading.Event()
        server = threading.Thread(target=auth.serve_forever, daemon=True)
        server.start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                main(Path(tmp), auth)
        finally:
            auth.shutdown()
            server.join()
    print("macOS PTY: history, diff, stage, commit, isolated hook, publish, askpass, resize, restore")
