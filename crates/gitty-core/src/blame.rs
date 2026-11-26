//! Bounded text blame. Metadata is stored once per commit, not once per line.
use crate::{
    dto::{Error, RepositoryLocation, Result},
    process::{self, args},
    repository::{resolve, validate_path, Repository},
};
use serde::Serialize;
use std::{collections::BTreeMap, io::Read};

const LIMIT: usize = 8 * 1024 * 1024;
const MAX_LINES: usize = 100_000;

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct BlameCommit {
    pub author: String,
    pub summary: String,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    /// None denotes working content that has not been committed.
    pub oid: Option<String>,
    pub original_line: u64,
    pub line: u64,
    pub content: String,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Blame {
    pub path: String,
    pub revision: Option<String>,
    pub commits: BTreeMap<String, BlameCommit>,
    pub lines: Vec<BlameLine>,
}

fn malformed() -> Error {
    Error::new("gitParse", "Incomplete or invalid blame output.")
}

fn parse(path: &str, revision: Option<String>, bytes: &[u8]) -> Result<Blame> {
    if bytes.len() > LIMIT {
        return Err(Error::new(
            "outputLimit",
            "Blame exceeded the 8 MiB preview limit.",
        ));
    }
    if bytes.contains(&0) {
        return Err(Error::new(
            "unsupportedBlame",
            "Blame requires a text file.",
        ));
    }
    let raw = process::text_ref(bytes)?;
    let mut input = raw.split_terminator('\n');
    let mut result = Blame {
        path: path.into(),
        revision,
        commits: BTreeMap::new(),
        lines: vec![],
    };
    while let Some(header) = input.next() {
        if result.lines.len() == MAX_LINES {
            return Err(Error::new("outputLimit", "Blame exceeded 100,000 lines."));
        }
        let fields: Vec<_> = header.split_whitespace().collect();
        if !(3..=4).contains(&fields.len()) {
            return Err(malformed());
        }
        let oid = fields[0];
        if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(malformed());
        }
        let original_line: u64 = fields[1].parse().map_err(|_| malformed())?;
        let line: u64 = fields[2].parse().map_err(|_| malformed())?;
        if fields
            .get(3)
            .is_some_and(|count| !count.parse::<u64>().is_ok_and(|n| n > 0))
        {
            return Err(malformed());
        }
        if original_line == 0 || line != result.lines.len() as u64 + 1 {
            return Err(malformed());
        }
        let (mut author, mut summary, mut content) = (None, None, None);
        for field in input.by_ref() {
            if let Some(text) = field.strip_prefix('\t') {
                content = Some(text.to_owned());
                break;
            }
            if let Some(text) = field.strip_prefix("author ") {
                author = Some(text.to_owned());
            }
            if let Some(text) = field.strip_prefix("summary ") {
                summary = Some(text.to_owned());
            }
        }
        if !result.commits.contains_key(oid) {
            result.commits.insert(
                oid.into(),
                BlameCommit {
                    author: author.ok_or_else(malformed)?,
                    summary: summary.ok_or_else(malformed)?,
                },
            );
        }
        result.lines.push(BlameLine {
            oid: (!oid.bytes().all(|b| b == b'0')).then(|| oid.to_owned()),
            original_line,
            line,
            content: content.ok_or_else(malformed)?,
        });
    }
    Ok(result)
}

impl Repository {
    pub fn blame(&self, revision: Option<&str>, path: &str) -> Result<Blame> {
        validate_path(path)?;
        let revision = revision.map(|r| resolve(self.location(), r)).transpose()?;
        let mut command = args(&[
            "-c",
            "blame.ignoreRevsFile=",
            "blame",
            "--porcelain",
            "--root",
            "--no-textconv",
            "--no-progress",
        ]);
        let input = if let Some(oid) = &revision {
            command.push(oid.clone());
            None
        } else {
            self.require_worktree()?;
            if !matches!(self.location(), RepositoryLocation::Native { .. }) {
                return Err(Error::new(
                    "unsupportedLocation",
                    "Working-file blame requires a native repository.",
                ));
            }
            let root = cap_std::fs::Dir::open_ambient_dir(
                &self.session.root,
                cap_std::ambient_authority(),
            )?;
            if !root.symlink_metadata(path)?.is_file() {
                return Err(Error::new(
                    "unsupportedBlame",
                    "Select a regular working file.",
                ));
            }
            let file = root.open(path)?;
            let mut bytes = Vec::new();
            file.take((LIMIT + 1) as u64).read_to_end(&mut bytes)?;
            if bytes.len() > LIMIT {
                return Err(Error::new(
                    "outputLimit",
                    "Working file exceeds the 8 MiB blame limit.",
                ));
            }
            if bytes.contains(&0) {
                return Err(Error::new(
                    "unsupportedBlame",
                    "Blame requires a text file.",
                ));
            }
            command.extend(args(&["--contents", "-"]));
            Some(bytes)
        };
        command.extend(args(&["--", path]));
        let bytes = if let Some(input) = input {
            let output = process::run_with_input_for(
                process::git_command(self.location(), &command)?,
                &input,
                process::remaining_timeout()?,
                LIMIT,
            )?;
            if !output.success {
                return Err(self.failed(&output));
            }
            output.stdout
        } else {
            process::checked(self.location(), &command)?
        };
        parse(path, revision, &bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::Service;

    #[test]
    fn blame_tracks_commits_renames_literal_paths_and_working_lines_without_writes() {
        let root = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(root.path())
                .args([
                    "-c",
                    "user.name=Blame Test",
                    "-c",
                    "user.email=blame@example.invalid",
                    "-c",
                    "commit.gpgsign=false",
                ])
                .args(args)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env(
                    "GIT_CONFIG_GLOBAL",
                    if cfg!(windows) { "NUL" } else { "/dev/null" },
                )
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout)
                .unwrap()
                .trim_end()
                .to_owned()
        };
        git(&["init", "-b", "main"]);
        std::fs::write(root.path().join("old"), "first\nsecond\nthird\n").unwrap();
        git(&["add", "old"]);
        git(&["commit", "-qm", "original"]);
        let first = git(&["rev-parse", "HEAD"]);
        git(&["mv", "old", "odd [name].txt"]);
        git(&["commit", "-qm", "rename"]);
        let service = Service::new(data.path().into());
        let handle = service
            .open(RepositoryLocation::Native {
                path: root.path().to_string_lossy().into(),
            })
            .unwrap()
            .session
            .handle;
        let repo = service.repo(&handle).unwrap();
        let before = git(&["status", "--porcelain=v2"]);
        let blame = repo.blame(Some("HEAD"), "odd [name].txt").unwrap();
        assert_eq!(blame.lines.len(), 3);
        assert!(blame.lines.iter().all(|l| l.oid.as_deref() == Some(&first)));
        assert_eq!(blame.commits.len(), 1);
        assert_eq!(blame.commits[&first].summary, "original");
        assert_eq!(git(&["status", "--porcelain=v2"]), before);
        std::fs::write(
            root.path().join("odd [name].txt"),
            "first\nnew working line\nthird\n",
        )
        .unwrap();
        let index = std::fs::read(root.path().join(".git/index")).unwrap();
        let blame = repo.blame(None, "odd [name].txt").unwrap();
        assert_eq!(blame.lines[0].oid.as_deref(), Some(first.as_str()));
        assert_eq!(blame.lines[1].oid, None);
        assert_eq!(blame.lines[1].content, "new working line");
        assert_eq!(
            std::fs::read(root.path().join(".git/index")).unwrap(),
            index
        );
        assert!(repo.blame(Some("HEAD"), "../outside").is_err());
        assert!(repo.blame(None, "missing").is_err());
        std::fs::write(root.path().join("huge"), vec![b'x'; LIMIT + 1]).unwrap();
        assert_eq!(repo.blame(None, "huge").unwrap_err().code, "outputLimit");
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            std::fs::write(outside.path().join("secret"), "outside\n").unwrap();
            std::os::unix::fs::symlink(outside.path(), root.path().join("link")).unwrap();
            assert!(repo.blame(None, "link/secret").is_err());
        }
        service.close(&handle).unwrap();
    }

    #[test]
    fn blame_parser_refuses_incomplete_binary_and_oversized_output() {
        for raw in [
            b"bad\n".as_slice(),
            b"\0",
            b"0000000000000000000000000000000000000000 1 1\n",
        ] {
            assert!(parse("file", None, raw).is_err());
        }
        assert_eq!(
            parse("file", None, &vec![b'x'; LIMIT + 1])
                .unwrap_err()
                .code,
            "outputLimit"
        );
    }
}
