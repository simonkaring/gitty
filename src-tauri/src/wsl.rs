use crate::{dto::*, process};

// wsl.exe's own list output is UTF-16LE (unlike Linux command output,
// which is UTF-8). Keep decoding independent of the host for fixture tests.
fn distribution_names(bytes: Vec<u8>) -> Result<Vec<String>> {
    let utf16 = bytes.starts_with(&[0xff, 0xfe]) || bytes.contains(&0);
    let text = if utf16 {
        if bytes.len() % 2 != 0 {
            return Err(Error::new(
                "wslEncoding",
                "Truncated UTF-16 distribution list",
            ));
        }
        let units: Vec<_> = bytes
            .chunks_exact(2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect();
        String::from_utf16(&units).map_err(|e| Error::new("wslEncoding", e.to_string()))?
    } else {
        process::text(bytes)?
    };
    Ok(text
        .trim_start_matches('\u{feff}')
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect())
}

fn supported() -> Result<()> {
    if cfg!(windows) {
        Ok(())
    } else {
        Err(Error::new(
            "unsupportedPlatform",
            "WSL is available only on Windows",
        ))
    }
}
pub fn distributions() -> Result<Vec<WslDistribution>> {
    supported()?;
    fn names(running: bool) -> Result<Vec<String>> {
        let mut c = std::process::Command::new("wsl.exe");
        c.args(["--list", "--quiet"]);
        if running {
            c.arg("--running");
        }
        let o = process::run(c)?;
        if !o.success {
            return Err(Error::new("wsl", "Unable to enumerate WSL distributions"));
        }
        distribution_names(o.stdout)
    }
    let all = names(false)?;
    let running = names(true)?;
    Ok(all
        .into_iter()
        .map(|name| WslDistribution {
            running: running.contains(&name),
            name,
        })
        .collect())
}
pub fn directories(distribution: &str, path: &str) -> Result<Vec<DirectoryEntry>> {
    supported()?;
    process::validate_distribution(distribution)?;
    if !path.starts_with('/') || path.contains('\0') {
        return Err(Error::new(
            "invalidPath",
            "WSL browsing requires an absolute Linux path",
        ));
    }
    if !distributions()?.iter().any(|d| d.name == distribution) {
        return Err(Error::new(
            "invalidDistribution",
            "Unknown WSL distribution",
        ));
    }
    let mut c = std::process::Command::new("wsl.exe");
    c.args([
        "--distribution",
        distribution,
        "--exec",
        "find",
        path,
        "-mindepth",
        "1",
        "-maxdepth",
        "1",
        "-type",
        "d",
        "-print0",
    ]);
    let o = process::run(c)?;
    if !o.success {
        return Err(Error::new(
            "wslBrowse",
            String::from_utf8_lossy(&o.stderr).into_owned(),
        ));
    }
    directory_entries(o.stdout)
}
fn directory_entries(bytes: Vec<u8>) -> Result<Vec<DirectoryEntry>> {
    let raw = process::text(bytes)?;
    let mut entries: Vec<_> = raw
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(|p| DirectoryEntry {
            name: p.rsplit('/').next().unwrap_or(p).into(),
            path: p.into(),
        })
        .collect();
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_decodes_utf16_bom_unicode_and_utf8() {
        let encode = |s: &str| s.encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(
            distribution_names(encode("\u{feff}Ubuntu\r\n工作\r\n\r\n")).unwrap(),
            vec!["Ubuntu", "工作"]
        );
        assert_eq!(
            distribution_names(encode("Ubuntu\r\n")).unwrap(),
            vec!["Ubuntu"]
        );
        assert_eq!(
            distribution_names(encode("\u{feff}工作")).unwrap(),
            vec!["工作"]
        );
        assert_eq!(
            distribution_names(b"Ubuntu\r\nDebian\n".to_vec()).unwrap(),
            vec!["Ubuntu", "Debian"]
        );
        assert!(distribution_names(vec![]).unwrap().is_empty());
        assert_eq!(
            distribution_names(vec![0xff, 0xfe, 0x41]).unwrap_err().code,
            "wslEncoding"
        );
        assert_eq!(
            distribution_names(vec![0xff, 0xfe, 0x00, 0xd8])
                .unwrap_err()
                .code,
            "wslEncoding"
        );
    }

    #[test]
    fn linux_directory_output_is_nul_delimited_utf8_not_utf16() {
        let entries = directory_entries(
            "/home/工作\0/home/a\nb\0/home/ spaced \0"
                .as_bytes()
                .to_vec(),
        )
        .unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].name, " spaced ");
        assert_eq!(entries[1].path, "/home/a\nb");
        assert_eq!(entries[2].name, "工作");
        assert_eq!(
            directory_entries(vec![b'/', 0xff, 0]).unwrap_err().code,
            "unsupportedEncoding"
        );
    }
}
