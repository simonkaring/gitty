"""Unix PTY smoke: cargo build -p gitty-cli && python3 scripts/test-tui.py."""

import errno
import codecs
import fcntl
import json
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
    base = "first line\n" + "".join(f"line {i}\n" for i in range(40)) + "last line\n"
    reviewed = base.replace("first line\n", "new line reviewed\n")
    (repo / "file.txt").write_text(base)
    git(repo, "add", "file.txt")
    git(repo, "commit", "-m", "fixture initial commit")
    (repo / "file.txt").write_text(reviewed.replace("last line\n", "discard this hunk\n"))
    # A controlling terminal must exist for the TUI, but not for its hook.
    hook = repo / ".git/hooks/pre-commit"
    hook.write_text(
        "#!/bin/sh\nif ( : < /dev/tty ) 2>/dev/null; then exit 1; fi\n"
        "printf 'isolated' > .git/tui-isolated\n"
    )
    hook.chmod(0o755)
    config = root / "config/gitty/tui.json"
    config.parent.mkdir(parents=True)
    config.write_text(json.dumps({"keys": {"stage": "x"}}))

    pid, fd = pty.fork()
    if pid == 0:
        # Closing the master after the restore sequence must not signal the child.
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        os.environ["TERM"] = "xterm-256color"
        os.environ["XDG_CONFIG_HOME"] = str(root / "config")
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
        key(b",")
        expect(b"Commit Profiles")
        key(b"\t")
        expect(b"Use Git default")
        key(b"n")
        expect(b"Author name")
        key(b"Work\tProfile Author\tprofile@example.invalid\r")
        expect(b"Profile saved.")
        key(b"\r")
        expect(b"Profile assigned")
        key(b"\x1b")
        expect("tab → Commit Profiles".encode())
        key(b"\x1b")
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
        key(b"\r")
        expect(b"hunk 1/2")
        key(b"?")
        expect(b"Keys for this view")
        expect(b"x")
        expect(b"[stage]")
        key(b"x")
        assert git(repo, "diff", "--cached") == b""
        key(b"\x1b")
        expect(b"hunk 1/2")
        key(b"x")
        expect(b"Stage hunk 1")
        expect(b"+ new line reviewed")
        key(b"\r")
        expect(b"Stage completed.")
        assert git(repo, "diff", "--cached", "--name-only") == b"file.txt"
        assert git(repo, "show", ":file.txt") == reviewed.strip().encode()
        # Unstage selected changed lines, then stage the whole hunk again.
        key(b"\t\r")
        expect(b"hunk 1/1")
        key(b"vjx")
        expect(b"Unstage 2 selected lines")
        key(b"\r")
        expect(b"Unstage completed.")
        assert git(repo, "diff", "--cached") == b""
        key(b"\t\r")
        expect(b"hunk 1/2")
        key(b"x")
        expect(b"Stage hunk 1")
        key(b"\r")
        expect(b"Stage completed.")
        key(b"\r")
        expect(b"hunk 1/1")
        key(b"d")
        expect(b"Discard hunk 1")
        key(b"\r")
        expect(b"Discard completed.")
        assert (repo / "file.txt").read_text() == reviewed
        assert git(repo, "show", ":file.txt") == reviewed.strip().encode()
        # Deleting an untracked file needs its own explicit authorization.
        (repo / "untracked.txt").write_text("delete only after D\n")
        key(b"w")
        expect(b"untracked.txt")
        key(b"d")
        expect(b"D allow deletion")
        key(b"\r")
        expect(b"Press D to explicitly allow")
        assert (repo / "untracked.txt").exists()
        key(b"D\r")
        expect(b"Discarded the reviewed file changes.")
        assert not (repo / "untracked.txt").exists()
        key(b"c")
        expect(b"Summary of the change")
        expect(b"Profile Author <profile@example.invalid>")
        key(b"terminal commit\x1bOQ")
        expect(b"Committed")
        assert git(repo, "log", "-1", "--format=%s") == b"terminal commit"
        assert git(repo, "log", "-1", "--format=%ae %ce") == (
            b"profile@example.invalid profile@example.invalid"
        )
        assert git(repo, "config", "user.email") == b"tui@example.invalid"
        assert (repo / ".git/tui-isolated").read_text() == "isolated"
        before_amend = git(repo, "rev-parse", "HEAD")
        key(b"c")
        expect(b"Summary of the change")
        key(b"terminal amended\x1bOR")
        expect(b"Amend ")
        key(b"\x1bOQ")
        expect(b"Amended")
        assert git(repo, "rev-parse", "HEAD") != before_amend
        assert git(repo, "rev-list", "--count", "HEAD") == b"2"
        assert git(repo, "log", "-1", "--format=%s") == b"terminal amended"
        key(b"B")
        expect(b"ahead/behind HEAD")
        key(b"n")
        expect(b"Create branch")
        key(b"topic\r")
        expect(b"Starting point:")
        key(b"\r")
        expect(b"Branch created.")
        expect(b"topic")
        assert git(repo, "rev-parse", "topic") == git(repo, "rev-parse", "HEAD")
        key(b"j\r")
        expect(b"Checkout branch")
        key(b"\r")
        expect(b"Checked out branch.")
        assert git(repo, "symbolic-ref", "HEAD") == b"refs/heads/topic"
        key(b"e")
        expect(b"Rename branch")
        key(b"renamed\r")
        expect(b"New name: renamed")
        key(b"\r")
        expect(b"Branch renamed.")
        assert git(repo, "symbolic-ref", "HEAD") == b"refs/heads/renamed"
        key(b"g\r")
        expect(b"Checkout branch")
        key(b"\r")
        expect(b"Checked out branch.")
        assert git(repo, "symbolic-ref", "HEAD") == b"refs/heads/main"
        key(b"jd")
        expect(b"Delete branch")
        key(b"\r")
        expect(b"Branch deleted.")
        assert git(repo, "branch", "--list", "renamed") == b""
        key(b"h/")
        expect(b"Search history")
        key(b"terminal\r")
        expect(b"Search: 1 matches.")
        key(b"nN")
        expect(b"next match")
        key(b"\x1b")
        expect(b"Search cancelled.")
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
        assert (repo / "file.txt").read_text() == reviewed
        assert len(git(repo, "stash", "list").splitlines()) == 1
        # Click the toolbar's Pop button (row 2); its column depends on the labels.
        toolbar = screen[1]
        column = "".join(toolbar.get(col, " ") for col in range(max(toolbar) + 1)).index("Pop") + 1
        key(f"\x1b[<0;{column};2M\x1b[<0;{column};2m".encode())
        expect(b"Pop the latest stash")
        key(b"\r")
        expect(b"Restored the stash")
        assert (repo / "file.txt").read_text() == "stashed edit\n"
        assert git(repo, "stash", "list") == b""
        # Review an apply with index restoration, then drop the retained stash.
        key(b"z")
        expect(b"Stash 1 change")
        key(b"\r")
        expect(b"Stashed your changes.")
        key(b"t")
        expect(b"Stashes")
        key(b"\r")
        expect(b"Stash tracked files")
        key(b"\r")
        expect(b"pgup")
        key(b"G")
        expect(b"+ stashed edit")
        key(b"\x1b")
        expect(b"tracked")
        key(b"\x1b")
        expect(b"a apply")
        key(b"a")
        expect(b"Stash apply")
        key(b"i")
        expect(b"Restore index: yes")
        key(b"\r")
        expect(b"Stash apply completed.")
        assert (repo / "file.txt").read_text() == "stashed edit\n"
        assert len(git(repo, "stash", "list").splitlines()) == 1
        key(b"d")
        expect(b"Stash drop")
        key(b"\r")
        expect(b"Stash drop completed.")
        assert git(repo, "stash", "list") == b""
        git(repo, "restore", "file.txt")
        git(repo, "switch", "-c", "source")
        (repo / "picked.txt").write_text("picked in terminal\n")
        git(repo, "add", "picked.txt")
        git(repo, "commit", "-qm", "pick source")
        git(repo, "switch", "main")
        key(b"B")
        expect(b"source")
        key(b"gjy")
        expect(b"Cherry-pick")
        key(b"\r")
        expect(b"Cherry-pick completed.")
        assert git(repo, "show", "HEAD:picked.txt") == b"picked in terminal"
        git(repo, "branch", "-D", "source")
        git(repo, "switch", "-c", "merge-side")
        (repo / "file.txt").write_text("incoming merge\n")
        git(repo, "commit", "-qam", "incoming")
        git(repo, "switch", "main")
        (repo / "file.txt").write_text("ours merge\n")
        git(repo, "commit", "-qam", "ours")
        key(b"B")
        expect(b"merge-side")
        key(b"gjM")
        expect(b"Stash local work: no")
        key(b"\r")
        expect(b"Operation paused:")
        assert git(repo, "diff", "--name-only", "--diff-filter=U") == b"file.txt"
        key(b"\x1b[18~")  # F7
        expect(b"Abort operation")
        key(b"\r")
        expect(b"Operation aborted.")
        assert git(repo, "diff", "--name-only", "--diff-filter=U") == b""
        git(repo, "branch", "plan-base")
        for name in ["drop-me", "reword-me", "keep-me"]:
            (repo / name).write_text(name + "\n")
            git(repo, "add", name)
            git(repo, "commit", "-qm", name)
        key(b"B")
        expect(b"plan-base")
        key(b"gjjI")
        expect(b"Interactive rebase")
        key(b" j  \r")
        expect(b"Review interactive rebase")
        key(b"\r")
        expect(b"Edit Git message")
        key(b"\x15rewritten in terminal\x1bOQ")
        expect(b"Operation completed.")
        assert git(repo, "rev-list", "--count", "plan-base..HEAD") == b"2"
        assert b"rewritten in terminal" in git(repo, "log", "--format=%s", "plan-base..HEAD")
        assert not (repo / "drop-me").exists()
        assert (repo / "reword-me").exists()
        key(b"m")
        expect(b"Upstream")
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
        # Until the prompt closes, a following key could still parse as Alt+key.
        pump_until(lambda _: not any("Git username" in "".join(line.values()) for line in screen.values()), "the prompt to close")
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

    assert sys.platform != "win32", "this smoke needs a POSIX pseudo-terminal"
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
    print(f"{sys.platform} PTY: contextual help/remapped staging, history/search, branches, stash inspect/apply/drop, diff, discard, commit/amend, isolated hook, publish, askpass, resize, restore")
