//! Full, bounded (never truncated) conflict blobs and capability-rooted writes.
use crate::{
    dto::*,
    mutate::validate_mutation_path,
    operation_dto::*,
    process::{self, args},
    repository::{fingerprint, Repository},
};
use std::io::{Read, Write};

const LIMIT: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Hash, PartialEq, Eq)]
pub(crate) struct WorkingSnapshot {
    kind: String,
    bytes: Vec<u8>,
}

fn text(bytes: &[u8]) -> Option<String> {
    if bytes.contains(&0) {
        None
    } else {
        std::str::from_utf8(bytes).ok().map(String::from)
    }
}
fn unsupported(message: &str) -> Error {
    Error::new("unsupportedConflict", message)
}

fn saved_but_unstaged(error: Error) -> Error {
    Error::new("mutationUnverified", format!("{} The working resolution was saved, but staging was not confirmed. Refresh and inspect the file and index before retrying.", error.message))
}

// Fixed program, no interpolated code or shell. WSL filesystem operations must
// execute inside Linux, rather than follow Windows UNC/reparse-point semantics.
// All ancestors and the final file are opened relative to pinned directory fds.
const WSL_FILE: &str = r#"
import os, sys, json, stat
r = json.loads(sys.stdin.buffer.readline())
root, path, action = r['root'], r['path'], r['action']
fds = []
try:
 d = os.open(root, os.O_RDONLY | os.O_DIRECTORY); fds.append(d)
 for part in path.split('/')[:-1]:
  d = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=d); fds.append(d)
 name = path.split('/')[-1]
 try:
  m = os.stat(name, dir_fd=d, follow_symlinks=False)
 except FileNotFoundError:
  m = None
 if m is None: kind, data = 'missing', b''
 elif stat.S_ISLNK(m.st_mode): kind, data = 'symlink', os.fsencode(os.readlink(name, dir_fd=d))
 elif stat.S_ISDIR(m.st_mode): kind, data = 'directory', b''
 elif not stat.S_ISREG(m.st_mode): kind, data = 'unsupported', b''
 else:
  f = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=d)
  with os.fdopen(f, 'rb') as stream: data = stream.read(16777217)
  if len(data) > 16777216: raise ValueError('Working file exceeds 16 MiB; resolve it in Git')
  kind = 'executable' if m.st_mode & 0o111 else 'file'
 if len(data) > 16777216: raise ValueError('Working path exceeds 16 MiB; resolve it in Git')
 if action == 'read':
  sys.stdout.buffer.write(kind.encode() + b'\0' + data)
 else:
  if kind == 'unsupported': raise ValueError('Directories and special files must be resolved in Git')
  expected = r['expected']
  if expected['kind'] != kind or bytes(expected['bytes']) != data: raise ValueError('staleConflict: working file changed; reload it')
  if action == 'delete':
   if m is not None: os.unlink(name, dir_fd=d)
  elif action == 'symlink':
   import secrets
   target = sys.stdin.buffer.read(16777217)
   if not target or len(target) > 16777216 or b'\0' in target: raise ValueError('Invalid symlink target')
   tmp = '.gitty-resolution-' + secrets.token_hex(16)
   try:
    os.symlink(os.fsdecode(target), tmp, dir_fd=d)
    os.rename(tmp, name, src_dir_fd=d, dst_dir_fd=d)
   finally:
    try: os.unlink(tmp, dir_fd=d)
    except FileNotFoundError: pass
  else:
   import secrets
   tmp = '.gitty-resolution-' + secrets.token_hex(16)
   f = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=d)
   try:
    with os.fdopen(f, 'wb') as stream:
     stream.write(sys.stdin.buffer.read(16777217)); stream.flush(); os.fsync(stream.fileno())
     os.fchmod(stream.fileno(), 0o755 if r['executable'] else 0o644)
    os.rename(tmp, name, src_dir_fd=d, dst_dir_fd=d)
   finally:
    try: os.unlink(tmp, dir_fd=d)
    except FileNotFoundError: pass
except Exception as e:
 print(str(e), file=sys.stderr); sys.exit(1)
finally:
 for fd in reversed(fds): os.close(fd)
"#;

impl Repository {
    fn conflict_path(&self, path: &str) -> Result<()> {
        if validate_mutation_path(path)? != path
            || path.contains('\\')
            || path
                .split('/')
                .any(|p| p.eq_ignore_ascii_case(".git") || p.contains(':'))
        {
            return Err(Error::new(
                "invalidPath",
                "Conflict path must be an exact repository-relative file path, outside .git.",
            ));
        }
        Ok(())
    }
    fn wsl_file(
        &self,
        path: &str,
        action: &str,
        expected: Option<&WorkingSnapshot>,
        bytes: &[u8],
        executable: bool,
    ) -> Result<Vec<u8>> {
        let RepositoryLocation::Wsl { distribution, .. } = self.location() else {
            unreachable!()
        };
        let request = serde_json::json!({"root": self.session.root, "path": path, "action": action, "expected": expected, "executable": executable});
        let mut input =
            serde_json::to_vec(&request).map_err(|e| Error::new("encoding", e.to_string()))?;
        input.push(b'\n');
        input.extend_from_slice(bytes);
        let mut command = std::process::Command::new("wsl.exe");
        command.args([
            "--distribution",
            distribution,
            "--exec",
            "python3",
            "-c",
            WSL_FILE,
        ]);
        let output =
            process::run_with_input_for(command, &input, process::CHECK_TIMEOUT, LIMIT * 6 + 8192)
                .map_err(|e| {
                    if action == "read" || e.code == "processStart" {
                        e
                    } else {
                        Error::new(
                            "mutationUnverified",
                            format!(
                        "{} The working file may already have changed. Refresh before retrying.",
                        e.message
                    ),
                        )
                    }
                })?;
        if !output.success {
            return Err(unsupported(&format!(
                "WSL conflict filesystem access requires python3 and a supported path: {}",
                crate::mutate::report(&output)
            )));
        }
        Ok(output.stdout)
    }
    fn conflict_directory(&self, path: &str) -> Result<(cap_std::fs::Dir, String)> {
        let mut dir =
            cap_std::fs::Dir::open_ambient_dir(&self.session.root, cap_std::ambient_authority())?;
        let mut parts = path.split('/').peekable();
        while let Some(part) = parts.next() {
            if parts.peek().is_none() {
                return Ok((dir, part.to_string()));
            }
            let meta = dir.symlink_metadata(part).map_err(|e| unsupported(&format!("The conflict's parent directory is unavailable: {e}. Resolve this path in Git.")))?;
            if !meta.is_dir() || meta.file_type().is_symlink() {
                return Err(unsupported(
                    "Conflict paths through symlinks or non-directories cannot be edited.",
                ));
            }
            // cap-std prevents escape from this directory even if an ancestor is
            // concurrently replaced with a symlink between the check and open.
            dir = dir.open_dir(part)?;
        }
        Err(unsupported("Invalid conflict path"))
    }
    fn native_snapshot(dir: &cap_std::fs::Dir, name: &str) -> Result<WorkingSnapshot> {
        let meta = match dir.symlink_metadata(name) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(WorkingSnapshot {
                    kind: "missing".into(),
                    bytes: vec![],
                })
            }
            Err(e) => return Err(e.into()),
        };
        if meta.file_type().is_symlink() {
            #[cfg(unix)]
            {
                use std::os::unix::ffi::OsStrExt;
                let target = dir.read_link_contents(name)?;
                let bytes = target.as_os_str().as_bytes().to_vec();
                if bytes.len() > LIMIT {
                    return Err(unsupported("Symlink target exceeds 16 MiB"));
                }
                return Ok(WorkingSnapshot {
                    kind: "symlink".into(),
                    bytes,
                });
            }
        }
        if meta.is_dir() {
            return Ok(WorkingSnapshot {
                kind: "directory".into(),
                bytes: vec![],
            });
        }
        if !meta.is_file() || meta.file_type().is_symlink() {
            return Ok(WorkingSnapshot {
                kind: "unsupported".into(),
                bytes: vec![],
            });
        }
        let mut bytes = Vec::new();
        dir.open(name)?
            .take((LIMIT + 1) as u64)
            .read_to_end(&mut bytes)?;
        if bytes.len() > LIMIT {
            return Err(unsupported(
                "Working file exceeds 16 MiB; resolve it in Git. Editing is never truncated.",
            ));
        }
        #[cfg(unix)]
        let executable = {
            use cap_std::fs::PermissionsExt;
            meta.permissions().mode() & 0o111 != 0
        };
        #[cfg(not(unix))]
        let executable = false;
        Ok(WorkingSnapshot {
            kind: if executable { "executable" } else { "file" }.into(),
            bytes,
        })
    }
    pub(crate) fn conflict_working_snapshot(&self, path: &str) -> Result<WorkingSnapshot> {
        self.conflict_path(path)?;
        match self.location() {
            RepositoryLocation::Native { .. } => {
                let (dir, name) = self.conflict_directory(path)?;
                Self::native_snapshot(&dir, &name)
            }
            RepositoryLocation::Wsl { .. } => {
                let output = self.wsl_file(path, "read", None, &[], false)?;
                let separator = output
                    .iter()
                    .position(|b| *b == 0)
                    .ok_or_else(|| unsupported("Invalid WSL file response"))?;
                Ok(WorkingSnapshot {
                    kind: process::text(output[..separator].to_vec())?,
                    bytes: output[separator + 1..].to_vec(),
                })
            }
        }
    }
    fn write_conflict_working(
        &self,
        path: &str,
        expected: &WorkingSnapshot,
        bytes: Option<&[u8]>,
        executable: bool,
        symlink: bool,
    ) -> Result<()> {
        if bytes.is_some_and(|b| b.len() > LIMIT) {
            return Err(unsupported("Resolution exceeds 16 MiB"));
        }
        if matches!(self.location(), RepositoryLocation::Wsl { .. }) {
            self.wsl_file(
                path,
                if bytes.is_none() {
                    "delete"
                } else if symlink {
                    "symlink"
                } else {
                    "write"
                },
                Some(expected),
                bytes.unwrap_or_default(),
                executable,
            )?;
            return Ok(());
        }
        let (dir, name) = self.conflict_directory(path)?;
        if Self::native_snapshot(&dir, &name)? != *expected {
            return Err(Error::new(
                "staleConflict",
                "Working file changed. Reload the conflict.",
            ));
        }
        if expected.kind == "unsupported" {
            return Err(unsupported(
                "Directories and special files must be resolved in Git.",
            ));
        }
        if let Some(bytes) = bytes {
            if symlink && (bytes.is_empty() || bytes.contains(&0)) {
                return Err(unsupported("Invalid symlink target"));
            }
            let temp = format!(".gitty-resolution-{}", uuid::Uuid::new_v4());
            let result = (|| -> Result<()> {
                if symlink {
                    #[cfg(unix)]
                    {
                        use std::os::unix::ffi::OsStrExt;
                        let target = std::ffi::OsStr::from_bytes(bytes);
                        dir.symlink_contents(target, &temp)?;
                        dir.rename(&temp, &dir, &name)?;
                        return Ok(());
                    }
                    #[cfg(not(unix))]
                    return Err(unsupported("Symlink resolution requires WSL on Windows."));
                }
                let mut opts = cap_std::fs::OpenOptions::new();
                opts.write(true).create_new(true);
                let mut file = dir.open_with(&temp, &opts)?;
                file.write_all(bytes)?;
                #[cfg(unix)]
                {
                    use cap_std::fs::PermissionsExt;
                    file.set_permissions(cap_std::fs::Permissions::from_mode(if executable {
                        0o755
                    } else {
                        0o644
                    }))?;
                }
                #[cfg(not(unix))]
                let _ = executable;
                file.sync_all()?;
                dir.rename(&temp, &dir, &name)?;
                Ok(())
            })();
            let _ = dir.remove_file(&temp);
            result
        } else {
            if expected.kind != "missing" {
                dir.remove_file(&name)?;
            }
            Ok(())
        }
    }
    fn conflict_data(&self, path: &str) -> Result<(ConflictFile, WorkingSnapshot)> {
        self.require_worktree()?;
        self.conflict_path(path)?;
        let raw = self.check_text(&["ls-files", "--unmerged", "-z", "--", path])?;
        let mut stages: [Option<ConflictVersion>; 3] = [None, None, None];
        for record in raw.split('\0').filter(|r| !r.is_empty()) {
            let (header, actual) = record
                .split_once('\t')
                .ok_or_else(|| Error::new("gitParse", "Malformed index stage"))?;
            if actual != path {
                return Err(unsupported(
                    "Select an individual conflicted file, not a directory.",
                ));
            }
            let fields: Vec<_> = header.split_whitespace().collect();
            if fields.len() != 3 {
                return Err(Error::new("gitParse", "Malformed index stage"));
            }
            let stage: usize = fields[2]
                .parse()
                .map_err(|_| Error::new("gitParse", "Invalid index stage"))?;
            if !(1..=3).contains(&stage) {
                return Err(Error::new("gitParse", "Invalid index stage"));
            }
            let content = if matches!(fields[0], "100644" | "100755" | "120000") {
                let size: usize = self
                    .check_text(&["cat-file", "-s", fields[1]])?
                    .parse()
                    .map_err(|_| Error::new("gitParse", "Invalid blob size"))?;
                if size > LIMIT {
                    return Err(unsupported("Conflict blob exceeds 16 MiB; resolve it in Git. Editing is never truncated."));
                }
                let output = self.check(&["cat-file", "blob", fields[1]])?;
                if !output.success {
                    return Err(self.failed(&output));
                }
                text(&output.stdout)
            } else {
                None
            };
            stages[stage - 1] = Some(ConflictVersion {
                oid: fields[1].into(),
                mode: fields[0].into(),
                content,
            });
        }
        if stages.iter().all(Option::is_none) {
            return Err(Error::new(
                "notConflicted",
                "This path no longer has unmerged index stages. Refresh the repository.",
            ));
        }
        let working = self.conflict_working_snapshot(path)?;
        let gitlink = stages.iter().flatten().all(|s| s.mode == "160000")
            && stages[1].is_some()
            && stages[2].is_some()
            && matches!(working.kind.as_str(), "directory" | "missing");
        let symlink = stages.iter().flatten().any(|s| s.mode == "120000");
        let unsupported_kind = stages
            .iter()
            .flatten()
            .any(|s| !matches!(s.mode.as_str(), "100644" | "100755" | "120000") && !gitlink)
            || (working.kind == "unsupported" || working.kind == "directory") && !gitlink
            || (working.kind == "symlink" && !symlink);
        let special = unsupported_kind || symlink || gitlink;
        let binary = stages.iter().flatten().any(|s| s.content.is_none())
            || (working.kind != "missing" && text(&working.bytes).is_none());
        let reason = if unsupported_kind {
            Some("Submodule, directory/file or special-file conflicts must be resolved in Git. No filesystem writes are allowed here.".into())
        } else if gitlink {
            Some("Submodule pointer conflict: select an exact indexed commit. The submodule directory and its checked-out contents will not be changed; deletion and text editing are unavailable.".into())
        } else if symlink {
            Some("Symlink conflicts support exact side selection or deletion. Text editing and staging the working path are unavailable.".into())
        } else if binary {
            Some("Binary or non-UTF-8 content cannot be edited as text. Choose a side, delete, or stage the working file without text conversion.".into())
        } else {
            None
        };
        let fingerprint = fingerprint((&raw, &working, &self.conflict_context()?));
        let rebasing = self.git_dir_entries()?.contains("rebase-merge");
        let [base, ours, theirs] = stages;
        Ok((
            ConflictFile {
                path: path.into(),
                fingerprint,
                base,
                ours,
                theirs,
                result: if working.kind == "missing" || special {
                    None
                } else {
                    text(&working.bytes)
                },
                editable: !special && !binary,
                reason,
                ours_label: if rebasing {
                    "Ours — rebased destination (index stage 2)"
                } else {
                    "Ours — current branch (index stage 2)"
                }
                .into(),
                theirs_label: if rebasing {
                    "Theirs — replayed commit (index stage 3)"
                } else {
                    "Theirs — incoming change (index stage 3)"
                }
                .into(),
            },
            working,
        ))
    }
    pub fn conflict_file(&self, path: &str) -> Result<ConflictFile> {
        self.conflict_data(path).map(|(file, _)| file)
    }
    pub(crate) fn resolve_conflict(
        &self,
        path: &str,
        expected: &str,
        resolution: ConflictResolution,
    ) -> Result<()> {
        self.operation_writable()?;
        let operation = self.operation_state()?;
        if operation.kind == OperationKind::Unsupported {
            return Err(Error::new("unsupportedOperation", operation.label));
        }
        let (file, working) = self.conflict_data(path)?;
        if file.fingerprint != expected {
            return Err(Error::new(
                "staleConflict",
                "Index stages or working file changed. Reload the conflict before resolving.",
            ));
        }
        let symlink = [&file.base, &file.ours, &file.theirs]
            .into_iter()
            .flatten()
            .any(|s| s.mode == "120000");
        let gitlink = file.ours.as_ref().is_some_and(|s| s.mode == "160000")
            && file.theirs.as_ref().is_some_and(|s| s.mode == "160000")
            && [&file.base, &file.ours, &file.theirs]
                .into_iter()
                .flatten()
                .all(|s| s.mode == "160000")
            && matches!(working.kind.as_str(), "directory" | "missing");
        if gitlink {
            let side = match resolution {
                ConflictResolution::Ours => file.ours.unwrap(),
                ConflictResolution::Theirs => file.theirs.unwrap(),
                _ => return Err(unsupported("Submodule pointer conflicts require choosing an exact index side. Resolve deletion or worktree changes in Git.")),
            };
            let input = format!("{} {}\t{}\0", side.mode, side.oid, path);
            let output = self.write(
                &args(&["update-index", "-z", "--index-info"]),
                &[],
                input.as_bytes(),
                8192,
            )?;
            if !output.success {
                return Err(self.failed(&output));
            }
            return Ok(());
        }
        if working.kind == "unsupported"
            || working.kind == "directory"
            || (working.kind == "symlink" && !symlink)
            || [&file.base, &file.ours, &file.theirs]
                .into_iter()
                .flatten()
                .any(|s| !matches!(s.mode.as_str(), "100644" | "100755" | "120000"))
        {
            return Err(unsupported(
                "Resolve submodule, directory/file and special-file conflicts in Git.",
            ));
        }
        if symlink
            && matches!(
                resolution,
                ConflictResolution::Text { .. } | ConflictResolution::Working
            )
        {
            return Err(unsupported(
                "Symlink conflicts require selecting an exact side or deleting the path.",
            ));
        }
        let executable = working.kind == "executable"
            || (working.kind == "missing"
                && file
                    .ours
                    .as_ref()
                    .or(file.theirs.as_ref())
                    .is_some_and(|v| v.mode == "100755"));
        let saved = !matches!(resolution, ConflictResolution::Working);
        match resolution {
            ConflictResolution::Ours | ConflictResolution::Theirs => {
                let side = if matches!(resolution, ConflictResolution::Ours) {
                    file.ours
                } else {
                    file.theirs
                };
                let side = side.ok_or_else(|| Error::new("missingStage", "The selected side is absent (deleted). Choose Delete explicitly to resolve as a deletion."))?;
                let output = self.check(&["cat-file", "blob", &side.oid])?;
                if !output.success {
                    return Err(self.failed(&output));
                }
                self.write_conflict_working(
                    path,
                    &working,
                    Some(&output.stdout),
                    side.mode == "100755",
                    side.mode == "120000",
                )?;
                // Index the exact selected blob. In particular no UTF-8 decoding,
                // newline rewriting, clean filter or binary round-trip occurs.
                let input = format!("{} {}\t{}\0", side.mode, side.oid, path);
                let output = self
                    .write(
                        &args(&["update-index", "-z", "--index-info"]),
                        &[],
                        input.as_bytes(),
                        8192,
                    )
                    .map_err(saved_but_unstaged)?;
                if !output.success {
                    return Err(saved_but_unstaged(self.failed(&output)));
                }
                return Ok(());
            }
            ConflictResolution::Text { content } => {
                if !file.editable || content.contains('\0') {
                    return Err(unsupported(
                        "This conflict cannot safely be edited as UTF-8 text.",
                    ));
                }
                self.write_conflict_working(
                    path,
                    &working,
                    Some(content.as_bytes()),
                    executable,
                    false,
                )?;
            }
            ConflictResolution::Delete => {
                self.write_conflict_working(path, &working, None, false, false)?
            }
            ConflictResolution::Working => {
                if working.kind == "missing" {
                    return Err(Error::new(
                        "missingWorkingFile",
                        "The working file is missing. Choose Delete explicitly.",
                    ));
                }
            }
        }
        let staged = (|| {
            let output = self.write(
                &args(&[
                    "add",
                    "--all",
                    "--pathspec-from-file=-",
                    "--pathspec-file-nul",
                ]),
                &[],
                path.as_bytes(),
                4096,
            )?;
            if !output.success {
                return Err(self.failed(&output));
            }
            Ok(())
        })();
        if saved {
            staged.map_err(saved_but_unstaged)
        } else {
            staged
        }
    }
}

#[cfg(all(test, unix))]
mod helper_tests {
    use super::WSL_FILE;
    use std::{
        io::Write,
        os::unix::fs::symlink,
        process::{Command, Stdio},
    };

    fn python(request: serde_json::Value, bytes: &[u8]) -> std::process::Output {
        let mut child = Command::new("python3")
            .arg("-c")
            .arg(WSL_FILE)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = serde_json::to_vec(&request).unwrap();
        input.push(b'\n');
        input.extend_from_slice(bytes);
        child.stdin.take().unwrap().write_all(&input).unwrap();
        child.wait_with_output().unwrap()
    }

    #[test]
    fn wsl_helper_reads_replaces_and_rejects_stale_symlink_targets() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("link");
        let target = dir.path().join("outside");
        std::fs::write(&target, b"untouched").unwrap();
        symlink(&target, &path).unwrap();
        let root = dir.path().to_str().unwrap();
        let read = python(
            serde_json::json!({"root": root, "path": "link", "action": "read"}),
            &[],
        );
        assert!(
            read.status.success(),
            "{}",
            String::from_utf8_lossy(&read.stderr)
        );
        let original = std::fs::read_link(&path).unwrap().into_os_string();
        use std::os::unix::ffi::OsStrExt;
        assert_eq!(
            read.stdout,
            [b"symlink\0".as_slice(), original.as_bytes()].concat()
        );
        let expected = serde_json::json!({"kind": "symlink", "bytes": original.as_bytes()});
        let request = serde_json::json!({"root": root, "path": "link", "action": "symlink", "expected": expected, "executable": false});
        let updated = python(request.clone(), b"other-target");
        assert!(
            updated.status.success(),
            "{}",
            String::from_utf8_lossy(&updated.stderr)
        );
        assert_eq!(
            std::fs::read_link(&path).unwrap(),
            std::path::Path::new("other-target")
        );
        assert!(!python(request, b"overwrite").status.success());
        assert_eq!(std::fs::read(&target).unwrap(), b"untouched");
    }

    #[test]
    fn wsl_helper_identifies_a_submodule_directory_without_opening_its_contents() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("nested")).unwrap();
        let output = python(
            serde_json::json!({"root": dir.path().to_str().unwrap(), "path": "nested", "action": "read"}),
            &[],
        );
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stdout, b"directory\0");
    }
}
