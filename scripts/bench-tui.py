"""Generate a merge-heavy fixture or benchmark GITTY_TUI_BENCH_REPO. No clone."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile


def generate(path, count):
    path.mkdir(parents=True)  # Never overwrite an existing repository.
    subprocess.run(["git", "init", "-q", "-b", "main", str(path)], check=True)
    with subprocess.Popen(
        ["git", "-C", str(path), "fast-import", "--quiet"],
        stdin=subprocess.PIPE,
    ) as process:
        main = side = None
        for index in range(count):
            mark = index + 1
            branch = "side" if index % 100 == 50 else "main"
            message = f"{branch} {mark}\n".encode()
            record = (
                f"commit refs/heads/{branch}\nmark :{mark}\n"
                f"committer TUI Bench <bench@example.invalid> {1700000000 + index} +0000\n"
                f"data {len(message)}\n"
            ).encode() + message
            if main is not None:
                record += f"from :{main}\n".encode()
            if branch == "main" and index % 100 == 99 and side is not None:
                record += f"merge :{side}\n".encode()
            process.stdin.write(record + b"\n")
            if branch == "side":
                side = mark
            else:
                main = mark
        process.stdin.close()
        assert process.wait() == 0, "fast-import failed"
    subprocess.run(["git", "-C", str(path), "reset", "--hard", "-q", "HEAD"], check=True)
    actual = int(subprocess.check_output(["git", "-C", str(path), "rev-list", "--all", "--count"]))
    assert actual == count, (actual, count)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--generate", type=Path, help="create a NEW synthetic repository here")
    parser.add_argument("--commits", type=int, default=200_000)
    args = parser.parse_args()
    if args.generate:
        if args.commits < 100:
            parser.error("use at least 100 commits to include a merge")
        generate(args.generate, args.commits)
        os.environ["GITTY_TUI_BENCH_REPO"] = str(args.generate.resolve())
    if not os.environ.get("GITTY_TUI_BENCH_REPO"):
        parser.error("set GITTY_TUI_BENCH_REPO or pass --generate")
    with tempfile.TemporaryDirectory(prefix="gitty-tui-bench-") as temp:
        output = Path(os.environ.get("GITTY_TUI_BENCH_OUT", str(Path(temp) / "result.json")))
        subprocess.run([
            "cargo", "test", "--release", "-p", "gitty-cli", "--bin", "gitty-cli",
            "tui::tests::terminal_benchmark", "--", "--ignored", "--exact", "--nocapture",
        ], env={**os.environ, "GITTY_TUI_BENCH_OUT": str(output)}, check=True)
        print(json.dumps(json.loads(output.read_text()), indent=2))
