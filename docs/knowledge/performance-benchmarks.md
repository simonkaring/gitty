---
type: Verification Guide
title: Performance benchmarks
description: Backend timing harness, Gitty-versus-GitKraken app comparison, and what each measurement can and cannot show.
status: draft
sources:
  - id: fixtures
    resource: ../../scripts/bench/fixtures.mjs
  - id: backend
    resource: ../../scripts/bench/backend.mjs
  - id: harness
    resource: ../../src-tauri/src/bench_tests.rs
  - id: apps
    resource: ../../scripts/bench/apps.mjs
  - id: probe
    resource: ../../scripts/bench/probe.swift
  - id: launch
    resource: ../../src-tauri/src/lib.rs
  - id: readme
    resource: ../../README.md
---

# Performance benchmarks

`npm run bench:fixtures` writes deterministic repositories with `git fast-import`
(small, 100k-commit/566-ref history, and 10,000 working entries) and, with
`--real`, clones git/git. Every fixture's `origin` fetches from itself, so
background fetches finish locally without changing what the apps draw.[^fixtures]

`npm run bench:backend` builds the ignored `bench_tests::backend_benchmark`
test in release mode. It calls the same `Service`/`Repository` methods as the
Tauri commands inside the per-request deadline, counts Git launches with the
test-only spawn counter, and records raw `git` floors for status and the first
200 history entries. It covers native reads only: no IPC, React rendering, WSL
or SSH.[^backend][^harness]

`npm run bench:apps` (macOS) quits both apps, launches each through
LaunchServices with the repository argument (`app_launch_path` for Gitty,
`-p` for GitKraken), and uses a Swift probe for window timing, pixel-based
visual completion, and process-family footprint and CPU (including reaped
children; WebKit/Electron helpers are found by macOS's responsible process).
By default Gitty runs from a re-identified copy so its WebKit tab storage is
empty; GitKraken uses the user's profile. Visual completion cannot distinguish
a finished graph from a static loading state.[^apps][^probe][^launch]

Results are local observations for one machine and app version; record the
scope and date with any claim. See the README for invocation.[^readme]

Related: [working changes at scale](working-changes-at-scale.md) and
[verification scope](demo-and-native-verification.md).

[^fixtures]: Fixture shapes and self-pointing `origin`.
[^backend]: Scenario table and result files.
[^harness]: `measure`, `bench_repository`, raw Git floors.
[^apps]: Launch, quit, isolated Gitty copy, memory and idle CPU sampling.
[^probe]: `related`, `usage` and `watch`.
[^launch]: `launch_path` and `app_launch_path`.
[^readme]: Performance benchmarks section under Checks.
