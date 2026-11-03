//! Backend timing harness for real repositories. Ignored by default; driven by
//! `npm run bench:backend`, which builds it in release mode and passes:
//!
//! - `GITTY_BENCH_REPOS`: repository paths separated by the platform path separator
//! - `GITTY_BENCH_ITERATIONS`: measured iterations per scenario (default 5)
//! - `GITTY_BENCH_OUT`: JSON file to write (one object per repository)
//!
//! Each scenario calls the same `Service`/`Repository` methods as the Tauri
//! commands, inside the same per-request deadline, and reports wall time and
//! the number of Git processes launched.
use crate::dto::*;
use crate::process;
use crate::repository::Service;
use std::time::Instant;

struct Sample {
    millis: Vec<f64>,
    spawns: usize,
}

fn measure(iterations: usize, mut f: impl FnMut() -> Result<()>) -> Result<Sample> {
    // One warm-up run fills the OS file cache and Git's own lazy state.
    process::request(&mut f)?;
    let mut millis = Vec::with_capacity(iterations);
    let mut spawns = 0;
    for _ in 0..iterations {
        let start = Instant::now();
        let (result, launched) = process::count_spawns(|| process::request(&mut f));
        millis.push(start.elapsed().as_secs_f64() * 1000.0);
        spawns = launched;
        result?;
    }
    Ok(Sample { millis, spawns })
}

fn raw_git(path: &str, argv: &[&str]) -> Result<()> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(argv)
        .stdout(std::process::Stdio::piped())
        .output()?;
    if !output.status.success() {
        return Err(Error::new("git", String::from_utf8_lossy(&output.stderr)));
    }
    Ok(())
}

fn bench_repository(path: &str, iterations: usize) -> Result<serde_json::Value> {
    let data = tempfile::tempdir()?;
    let service = Service::new(data.path().into());
    let location = || RepositoryLocation::Native { path: path.into() };
    let mut results = serde_json::Map::new();
    let mut record = |name: &str, sample: Result<Sample>| match sample {
        Ok(sample) => {
            eprintln!(
                "  {name:<22} median {:>9.1} ms  ({} git processes)",
                median(&sample.millis),
                sample.spawns
            );
            results.insert(
                name.into(),
                serde_json::json!({ "millis": sample.millis, "spawns": sample.spawns }),
            );
        }
        Err(error) => {
            eprintln!("  {name:<22} failed: {}", error.message);
            results.insert(name.into(), serde_json::json!({ "error": error.message }));
        }
    };

    record(
        "open",
        measure(iterations, || {
            let handle = service.open(location())?.session.handle;
            service.close(&handle)
        }),
    );
    let handle = process::request(|| service.open(location()))?
        .session
        .handle;
    let repo = service.repo(&handle)?;
    let head = repo.state()?.session.head;
    let bare = repo.session.bare;

    record(
        "tabOpenTotal",
        measure(iterations, || {
            let handle = service.open(location())?.session.handle;
            let repo = service.repo(&handle)?;
            repo.snapshot()?;
            repo.history(None, 200, HistoryQuery::default())?;
            service.close(&handle)
        }),
    );
    record(
        "snapshotRefresh",
        measure(iterations, || repo.snapshot().map(drop)),
    );
    record("state", measure(iterations, || repo.state().map(drop)));
    if !bare {
        record("status", measure(iterations, || repo.status().map(drop)));
    }
    record(
        "historyFirstPage",
        measure(iterations, || {
            repo.history(None, 200, HistoryQuery::default()).map(drop)
        }),
    );
    record(
        "history5000",
        measure(iterations.min(3), || {
            let mut page = repo.history(None, 200, HistoryQuery::default())?;
            let mut loaded = page.commits.len();
            while let (Some(cursor), true) = (page.cursor.clone(), loaded < 5000) {
                page = repo.history(Some(cursor), 200, HistoryQuery::default())?;
                loaded += page.commits.len();
            }
            Ok(())
        }),
    );
    if let Some(head) = &head {
        record(
            "commitDetail",
            measure(iterations, || repo.commit(head).map(drop)),
        );
        record(
            "commitFiles",
            measure(iterations, || {
                repo.diff_files(&DiffSpec::Commit {
                    oid: head.clone(),
                    parent: None,
                })
                .map(drop)
            }),
        );
    }
    record(
        "search",
        measure(iterations.min(3), || {
            repo.search(SearchQuery {
                text: "merge".into(),
                branch: None,
                since: None,
                until: None,
                path: None,
            })
            .map(drop)
        }),
    );
    // Floors: the cheapest Git invocations that produce the same information.
    if !bare {
        record(
            "rawGitStatus",
            measure(iterations, || {
                raw_git(
                    path,
                    &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
                )
            }),
        );
    }
    record(
        "rawGitFirst200",
        measure(iterations, || {
            raw_git(
                path,
                &["rev-list", "--date-order", "--max-count=200", "--all"],
            )
        }),
    );
    service.close(&handle)?;
    Ok(serde_json::json!({ "path": path, "results": results }))
}

fn median(values: &[f64]) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    match sorted.len() {
        0 => f64::NAN,
        n if n % 2 == 1 => sorted[n / 2],
        n => (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0,
    }
}

#[test]
#[ignore = "benchmark; run through `npm run bench:backend`"]
fn backend_benchmark() {
    let repos = std::env::var_os("GITTY_BENCH_REPOS").expect("set GITTY_BENCH_REPOS");
    let iterations = std::env::var("GITTY_BENCH_ITERATIONS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(5);
    let mut report = vec![];
    for path in std::env::split_paths(&repos) {
        let path = path.to_str().expect("UTF-8 repository path").to_string();
        eprintln!("{path}");
        report.push(
            bench_repository(&path, iterations).unwrap_or_else(
                |error| serde_json::json!({ "path": path, "error": error.message }),
            ),
        );
    }
    let json = serde_json::to_string_pretty(&report).unwrap();
    match std::env::var_os("GITTY_BENCH_OUT") {
        Some(out) => std::fs::write(out, json).unwrap(),
        None => println!("{json}"),
    }
}
