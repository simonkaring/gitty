//! Raw commit metadata shared by detail reads and bounded history-page batches.
use crate::{dto::*, process};

pub fn batch(location: &RepositoryLocation, ids: &[String]) -> Result<Vec<CommitSummary>> {
    if ids.len() > 200 {
        return Err(Error::new(
            "batchLimit",
            "Commit batches are limited to 200 objects",
        ));
    }
    if ids.is_empty() {
        return Ok(vec![]);
    }
    // Walk IDs are already validated. Keep the protocol boundary defensive:
    // full hashes only, never revisions, options, whitespace, or batch commands.
    if ids
        .iter()
        .any(|id| !matches!(id.len(), 40 | 64) || !id.as_bytes().iter().all(u8::is_ascii_hexdigit))
    {
        return Err(Error::new(
            "invalidRevision",
            "Commit batch requires full object IDs",
        ));
    }
    let input = format!("{}\n", ids.join("\n"));
    let output = process::checked_with_input(
        location,
        &process::args(&["cat-file", "--batch"]),
        input.as_bytes(),
    )?;
    parse_batch(ids, &output)
}

fn parse_batch(ids: &[String], mut bytes: &[u8]) -> Result<Vec<CommitSummary>> {
    let malformed = || Error::new("gitParse", "Malformed or truncated cat-file batch response");
    let mut commits = Vec::with_capacity(ids.len());
    for id in ids {
        // <oid> <type> <byte-size> LF, followed by exactly byte-size bytes and LF.
        // Commit bodies may themselves contain newlines, NULs, or header-like text.
        let newline = bytes
            .iter()
            .take(128)
            .position(|&b| b == b'\n')
            .ok_or_else(malformed)?;
        let header = std::str::from_utf8(&bytes[..newline]).map_err(|_| malformed())?;
        let fields: Vec<_> = header.split(' ').collect();
        if fields == [id.as_str(), "missing"] {
            return Err(Error::new("git", format!("Commit object {id} is missing")));
        }
        if fields.len() != 3
            || fields[0] != id
            || fields[1] != "commit"
            || fields[2].is_empty()
            || !fields[2].bytes().all(|b| b.is_ascii_digit())
        {
            return Err(malformed());
        }
        let size: usize = fields[2].parse().map_err(|_| malformed())?;
        bytes = &bytes[newline + 1..];
        let object = bytes.get(..size).ok_or_else(malformed)?;
        if bytes.get(size) != Some(&b'\n') {
            return Err(malformed());
        }
        // No allocation uses an untrusted object size. Capture already enforces
        // the 32 MiB aggregate output limit for the entire page.
        commits.push(parse(id, object)?.summary);
        bytes = &bytes[size + 1..];
    }
    if !bytes.is_empty() {
        return Err(malformed());
    }
    Ok(commits)
}

pub fn parse(id: &str, bytes: &[u8]) -> Result<CommitDetail> {
    let raw = process::text_ref(bytes)?;
    let (headers, body) = raw
        .split_once("\n\n")
        .ok_or_else(|| Error::new("gitParse", "Malformed commit"))?;
    let parents = headers
        .lines()
        .filter_map(|l| l.strip_prefix("parent ").map(String::from))
        .collect();
    let author = headers
        .lines()
        .find_map(|l| l.strip_prefix("author "))
        .ok_or_else(|| Error::new("gitParse", "Missing author"))?;
    let (name, rest) = author
        .rsplit_once(" <")
        .ok_or_else(|| Error::new("gitParse", "Malformed author"))?;
    let (email, date) = rest
        .rsplit_once("> ")
        .ok_or_else(|| Error::new("gitParse", "Malformed author date"))?;
    let timestamp = date
        .split_whitespace()
        .next()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| Error::new("gitParse", "Malformed timestamp"))?;
    Ok(CommitDetail {
        summary: CommitSummary {
            id: id.into(),
            parents,
            subject: body.lines().next().unwrap_or("").into(),
            author: name.into(),
            email: email.into(),
            timestamp,
        },
        body: body.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(id: &str, body: &[u8]) -> Vec<u8> {
        let mut bytes = format!("{id} commit {}\n", body.len()).into_bytes();
        bytes.extend_from_slice(body);
        bytes.push(b'\n');
        bytes
    }

    #[test]
    fn batch_framing_uses_bytes_and_preserves_original_metadata() {
        // Both supported OID widths, signed-header continuation, UTF-8 and NULs.
        for width in [40, 64] {
            let ids = vec!["a".repeat(width), "b".repeat(width)];
            let body = format!("tree {}\nparent {}\nparent {}\nauthor Zoë 工作 <zoe@example.org> 1700000000 +1245\ncommitter Other <c@example.org> 1700000001 +0000\ngpgsig signature\n author Not an author\n\nRésumé 🦀\n\n{} commit 123\nNUL\0end without newline", ids[0], ids[0], ids[1], ids[1]);
            let bytes = [
                frame(&ids[0], body.as_bytes()),
                frame(&ids[1], body.as_bytes()),
            ]
            .concat();
            let commits = parse_batch(&ids, &bytes).unwrap();
            assert_eq!(commits.len(), 2);
            for (id, summary) in ids.iter().zip(commits) {
                assert_eq!(summary.id, *id);
                assert_eq!(summary.parents, ids);
                assert_eq!(summary.subject, "Résumé 🦀");
                assert_eq!(summary.author, "Zoë 工作");
                assert_eq!(summary.timestamp, 1_700_000_000);
            }
            assert!(parse(&ids[0], body.as_bytes())
                .unwrap()
                .body
                .ends_with("NUL\0end without newline"));
        }
    }

    #[test]
    fn batch_rejects_missing_wrong_truncated_and_extra_frames() {
        let id = "a".repeat(40);
        let ids = vec![id.clone()];
        let object = b"author Test <test@example.org> 1700000000 +0000\n\nsubject\n";
        let valid = frame(&id, object);
        // Every truncation of a valid frame must fail, including the final separator.
        for end in 0..valid.len() {
            assert_eq!(
                parse_batch(&ids, &valid[..end]).unwrap_err().code,
                "gitParse"
            );
        }
        for bytes in [
            format!("{} commit 0\n\n", "b".repeat(40)).into_bytes(),
            format!("{id} blob 0\n\n").into_bytes(),
            format!("{id} commit -1\n\n").into_bytes(),
            format!("{id} commit +1\nx\n").into_bytes(),
            format!("{id} commit {}\n\n", usize::MAX).into_bytes(),
            format!("{id} commit 999999999999999999999999999999\n\n").into_bytes(),
            format!("{id} commit 1 extra\nx\n").into_bytes(),
            [valid.clone(), b"garbage".to_vec()].concat(),
            [valid.clone(), valid.clone()].concat(),
            {
                let mut b = valid.clone();
                *b.last_mut().unwrap() = b'x';
                b
            },
        ] {
            assert_eq!(parse_batch(&ids, &bytes).unwrap_err().code, "gitParse");
        }
        assert_eq!(
            parse_batch(&ids, format!("{id} missing\n").as_bytes())
                .unwrap_err()
                .code,
            "git"
        );
        let two = vec![id.clone(), "b".repeat(40)];
        assert!(
            parse_batch(&two, &valid).is_err(),
            "Never return a partial page"
        );
        let invalid_encoding = [object.as_slice(), &[0xff]].concat();
        assert_eq!(
            parse_batch(&ids, &frame(&id, &invalid_encoding))
                .unwrap_err()
                .code,
            "unsupportedEncoding"
        );
    }

    #[test]
    fn batch_bounds_and_input_validation_precede_process_creation() {
        let location = RepositoryLocation::Native {
            path: "gitty-path-that-does-not-exist".into(),
        };
        assert!(batch(&location, &[]).unwrap().is_empty());
        assert_eq!(
            batch(&location, &vec!["a".repeat(40); 201])
                .unwrap_err()
                .code,
            "batchLimit"
        );
        for id in [
            "HEAD".into(),
            "--batch-all-objects".into(),
            format!("{}\nHEAD", "a".repeat(40)),
            "g".repeat(40),
        ] {
            assert_eq!(batch(&location, &[id]).unwrap_err().code, "invalidRevision");
        }
        assert_eq!(
            process::checked_with_input(&location, &[], &vec![0; 32 * 1024 + 1])
                .unwrap_err()
                .code,
            "inputLimit"
        );
    }
}
