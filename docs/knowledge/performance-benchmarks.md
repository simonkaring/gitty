---
type: Verification Guide
title: Performance benchmarks
description: Backend timing and macOS/Windows app comparisons, with the limits of each measurement.
status: draft
sources:
  - id: fixtures
    resource: ../../scripts/bench/fixtures.mjs
  - id: backend
    resource: ../../scripts/bench/backend.mjs
  - id: harness
    resource: ../../crates/gitty-core/src/bench_tests.rs
  - id: apps
    resource: ../../scripts/bench/apps.mjs
  - id: probe
    resource: ../../scripts/bench/probe.swift
  - id: launch
    resource: ../../crates/gitty-core/src/bench_tests.rs
  - id: readme
    resource: ../../README.md
  - id: process
    resource: ../../crates/gitty-core/src/process.rs
  - id: windows
    resource: ../../scripts/bench/apps-windows.mjs
  - id: windows-probe
    resource: ../../scripts/bench/probe-windows.ps1
  - id: windows-history
    resource: ../../scripts/bench/history-windows.mjs
  - id: windows-history-build
    resource: ../../src-tauri/tauri.bench.conf.json
  - id: windows-history-test
    resource: ../../src/components/HistoryGraph.ui.test.tsx
  - id: experiments
    resource: ../performance-experiments.md
---

# Performance benchmarks

The [optimization decision log](../performance-experiments.md) tracks hypotheses,
per-change timings, reproduction commands and keep/revert decisions. Diff navigation
measures browser key dispatch through React commit; split-row construction measures
the model in Node. Neither measures native Git or time to displayed pixels.[^experiments]

`npm run bench:fixtures` writes deterministic repositories with `git fast-import`
(small, 100k-commit/566-ref history, and 10,000 working entries) and, with
`--real`, clones git/git. Every fixture's `origin` fetches from itself, so
background fetches finish locally without changing what the apps draw.[^fixtures]

`npm run bench:backend` builds `gitty-core`'s ignored
`bench_tests::backend_benchmark` test in release mode. The comparison script
selects the core package for current revisions and the legacy desktop package
for older baseline worktrees. It calls the same `Service`/`Repository` methods as the
Tauri commands inside the per-request deadline, counts Git launches with the
test-only spawn counter, and records raw `git` floors for status and the first
200 history entries. It covers native reads only: no IPC, React rendering, WSL
or SSH.[^backend][^harness]
`tabOpenTotal` includes open plus the combined snapshot/history read, including
automatic paging to HEAD (up to 2,000 rows). `historyFirstPage` remains exactly the
standalone 200-row history request, so these scenarios measure different scopes.[^harness]
`snapshotHistoryRefresh` measures changed refs while retaining a near-top target;
`commitEditEligibility` measures the deferred containment check separately from
`commitDetail`, so moving work off the rendering path is not reported as eliminating it.[^harness]

`npm run bench:apps` (macOS) quits both apps, launches each through
LaunchServices with the repository argument (`app_launch_path` for Gitty,
`-p` for GitKraken), and uses a Swift probe for window timing, pixel-based
visual completion, and process-family footprint and CPU (including reaped
children; WebKit/Electron helpers are found by macOS's responsible process).
By default Gitty runs from a re-identified copy so its WebKit tab storage is
empty; GitKraken uses the user's profile. Visual completion cannot distinguish
a finished graph from a static loading state.[^apps][^probe][^launch]

`npm run bench:apps:windows` compares release Gitty and GitCraft on the same
fixtures after warm-up, alternating app order. It refuses to stop apps that
were already running and uses the current Windows profile. The probe records
first visible window, sampled on-screen settling (not graph readiness),
live descendant private/working-set bytes, and sampled idle CPU. It cannot
attribute detached or short-lived child processes; working sets can double-count
shared pages. Deep paging, refresh latency, and scrolling are out of scope.[^windows][^windows-probe]

`npm run bench:history:windows` uses a separately identified Gitty release
build and attaches to a fresh WebView2 via a temporary loopback endpoint. On a
disposable `large-history` copy it measures graph layout/keyboard readiness,
older pages, tail navigation, scroll animation-frame gaps, and watcher-driven
publication of a new HEAD. Its A/B toggles Git's commit-graph before launch.
Raw results include per-page elapsed time and idle frame gaps at the same depth
as the scroll sample.
These measurements include automation overhead and exclude display presentation
and GitCraft. Rows may exist before the graph canvas has matching layout; the
readiness check requires both.[^windows-history][^windows-history-build][^windows-history-test]

On 2026-11-20, the Windows 11 Enterprise build 26300 Hyper-V VM (AMD EPYC
9V74, 4 guest cores / 8 logical processors, 32 GiB) ran Gitty's release history
benchmark on the 100,300-commit synthetic fixture. Three measured runs per
variant after one warm-up gave commit-graph-off → on medians of **2.44 → 2.01 s**
to keyboard readiness, **2.02 → 1.92 s** to page from 400 to 2,000 rows,
**31 → 31 ms** p95 scroll frame gap, and **1.61 → 1.23 s** from external ref
update to the new HEAD row. The results describe this fixture and VM, not
physical presentation, watcher debounce in isolation, or GitCraft.[^windows-history]

After batching spool writes and reducing client append work, a same-VM rerun
showed no consistent end-to-end gain to 2,000 rows (1.92 s off, 1.98 s on).
With the commit-graph on, paging to 10,000 took a median 5.92 s over three runs
after warm-up; median individual pages were 86–96 ms across depth bands. Idle
and deep-scroll p95 frame gaps both measured 31 ms. There was no pre-change
10,000-row baseline, and page durations include UI/IPC and automation overhead,
not just Git process time.[^windows-history]

Results are local observations for one machine and app version; record the
scope and date with any claim. See the README for invocation.[^readme]

On macOS/M1 Pro (2026-11-03), five-iteration back-to-back native benchmarks using
the pre-change release binary and the exit-notification/macOS-shim change measured
small-repository `open` 140 → 47 ms, `state` 46 → 15 ms, first history page
154 → 61 ms, and commit detail 343 → 106 ms, with unchanged launch counts.
`GITTY_TRACE_PROCESS=1` records program-only spawn/total times (not arguments or
credentials); across both repositories, median captured Git time fell 35.1 →
11.7 ms. These are loaded-machine observations, not universal floors: git/git's
first page regressed 716 → 1578 ms while its raw Git floor also rose to 1558 ms,
so long-walk wall times do not isolate launch overhead.[^backend][^harness][^process]

Related: [working changes at scale](working-changes-at-scale.md) and
[verification scope](demo-and-native-verification.md).

[^fixtures]: Fixture shapes and self-pointing `origin`.
[^backend]: Scenario table and result files.
[^harness]: `measure`, `bench_repository`, raw Git floors.
[^apps]: Launch, quit, isolated Gitty copy, memory and idle CPU sampling.
[^probe]: `related`, `usage` and `watch`.
[^launch]: `launch_path` and `app_launch_path`.
[^readme]: Performance benchmarks section under Checks.
[^process]: `native_git_program`, `ChildWait`, and program-only trace output.
[^windows]: Warm-ups, alternating runs, medians, machine specs, executable hashes, and raw JSON.
[^windows-probe]: Windows window sampling, process snapshots, and owned-app cleanup.
[^windows-history]: Disposable fixture, WebView attachment, scripted interactions, and timing.
[^windows-history-build]: Release configuration with a distinct binary and app identifier.
[^windows-history-test]: Pending history rows and the canvas layout row count.
[^experiments]: Large-diff workloads, comparisons, checks and decisions.
