# Graph layout performance experiments

Scope: `src/graph/layout.ts` (`appendHistory`, `layoutHistory`, `buildEdgeIndex`, `indexEdges`).
Date: 2026-11-20. Machine: Windows 11 Hyper-V VM, AMD EPYC 9V74, 8 logical CPUs, Node v26.13.1 (win32/x64).
The VM was shared with other concurrent work (CPU load reported 100% at times), so wall-clock
**medians are noisy (±10–40%)**. Decisions below use the **best-of-N minimum** and the size of the effect
relative to the measured self-comparison noise. These are pure-JS layout timings on Node/V8, not
WebView2, worker transfer, React, or canvas rendering.

## Reproduce

```
node --expose-gc scripts/bench-graph.mjs --runs 31 [--baseline <git-ref|path-to-layout.ts>] [--candidate <path>] [--json out.json] [--only substring] [--no-verify]
```

- The script bundles baseline and candidate `layout.ts` with esbuild, so no build step is required.
  Default baseline is `git show HEAD:src/graph/layout.ts`; default candidate is the working tree file.
- Before timing it verifies semantic equivalence (below) and exits non-zero on any mismatch.
- Baseline/candidate samples are interleaved per scenario, one warm-up each, then N timed runs
  with a forced GC before each when launched with `--expose-gc`. The small full-layout scenario runs 3N samples.
- Workloads are generated from fixed seeds/rules (SHA-1 ids), so they are identical on every run:

| Workload | Commits | Edges | Lanes | Shape |
| --- | ---: | ---: | ---: | --- |
| `linear-100k` | 100,000 | 99,999 | 1 | straight line |
| `fixture-100k-300open` | 100,300 | 104,298 | 302 | mirrors `scripts/bench/fixtures.mjs` `large-history` (merge topic every 25, 300 unmerged branches whose tips are newest) |
| `braided-50k-w16/w64/w256` | 50,000 | ~54,9xx | 16 / 64 / 41 | random fork/merge/octopus, max 16/64/256 active branches (w256 reaches 41 lanes) |
| `fixture-2k-small` | 2,010 | 2,048 | 12 | mirrors the `small` fixture |

Scenarios: `layoutHistory` (full layout including `buildEdgeIndex`), `paged append+index` (the worker path:
`appendHistory` of 200-row pages to 10,000 rows, with `buildEdgeIndex` after each page),
`buildEdgeIndex`, and `indexEdges` over 500 viewport queries of 30 rows.

### Semantic equivalence check

For every workload the script compares baseline and candidate with `util.isDeepStrictEqual` on `nodes`, `edges`,
`laneCount`, `edgeMaxTo` and `indexEdges` results over a sweep of viewports. It also replays the paged
workloads (and the small fixture in 37-row pages) and compares every page's returned layout, `lastResolved` and
`buildEdgeIndex` output, plus error behavior (self-parent, duplicate commit, parent before child, repeated
parent ids, missing parent, empty input). `npx vitest run src/graph src/components/HistoryGraph` passes (the
graph tests include a new slot-index consistency test) and `tsc --noEmit` is clean.

## Baseline noise (baseline vs identical candidate, 31 runs)

Identical code compared against itself differed by −20%…+20% in median and, for min, by up to +36% on
sub-100 ms scenarios (e.g. `braided-50k-w16` min 53.7 vs 73.1 ms). Effects below ~35% are not
distinguishable on this machine; the effects kept below are 40–93%.

Baseline (HEAD), minimum / median ms:

| Scenario | min | median |
| --- | ---: | ---: |
| layoutHistory linear-100k | 187.6* | 300.2* |
| layoutHistory fixture-100k-300open | 1030* | 1859* |
| layoutHistory braided-50k-w16 | 53.7 | 125.4 |
| layoutHistory braided-50k-w64 | 103.8* | 307.7* |
| paged fixture-100k-300open 10000x200 | 146.9* | 238.9* |

\* This run was under heavy external load (other processes), so absolute values are inflated; the quiet-machine
baselines are in the per-change tables below.

## Experiment 1: slot-index Map for lane lookup — KEPT

Hypothesis: `reserve()` and the parent-track search used `slots.indexOf(id)`, a linear scan of string compares
over every occupied lane for every commit and parent. Cost grows with lane count; histories with many open
branches (the 300-branch `large-history` fixture reaches 302 lanes at the newest rows) should be dominated by it.

Change: `LayoutState.slotOf: Map<string, number>` mirrors `slots`; maintained at the three places a slot is
assigned or freed. The free-lane search (`slots.indexOf(null)`, a cheap non-string scan) is unchanged, so lane
choice is identical.

Result (baseline HEAD vs experiment 1, 21 runs, min [median] ms):

| Scenario | Baseline | Exp. 1 | Change (min) |
| --- | ---: | ---: | ---: |
| layoutHistory linear-100k | 80.1 [129.6] | 89.1 [141.5] | within noise |
| layoutHistory fixture-100k-300open | 503.7 [652.7] | 75.6 [98.7] | **−85%** |
| layoutHistory braided-50k-w16 | 65.9 [87.1] | 64.4 [91.9] | within noise |
| layoutHistory braided-50k-w64 | 59.6 [87.2] | 54.2 [69.6] | −9% (noise-level) |
| layoutHistory braided-50k-w256 | 72.2 [85.5] | 59.6 [74.0] | −17% (noise-level) |
| layoutHistory fixture-2k-small | 2.92 [3.31] | 2.43 [2.96] | −17% (noise-level) |
| paged fixture-100k-300open 10000x200 | 102.0 [128.7] | 16.6 [28.9] | **−84%** |
| paged braided-50k-w64 10000x200 | 26.2 [37.7] | 20.3 [32.8] | −23% (noise-level) |

Equivalence check: passed. Decision: **keep**. The large effect is only on many-lane histories, which is the
primary real-world slow case; low-lane workloads are neutral.

## Experiment 2: remove per-commit allocations in the append loop — KEPT

Hypothesis: the loop built `[...new Set(commit.parents)]` (a Set plus an array) and ran a `forEach` closure
for every commit, and `state.pending.get(id) ?? []` allocated an array for every commit that nobody was waiting on.

Change (isolated, applied on top of experiment 1): plain `for…of`/indexed loops, no allocation on the
`pending` miss path, and dedupe only when a commit lists more than one parent (a single parent cannot repeat).
Semantics unchanged: the deduped parent order, the `index === 0` rule for the first parent's lane, and error
conditions are the same.

Result (baseline = experiment 1, 31 runs, min [median] ms):

| Scenario | Exp. 1 | Exp. 2 | Change (min) |
| --- | ---: | ---: | ---: |
| layoutHistory linear-100k | 58.1 [77.5] | 28.5 [45.4] | **−51%** |
| layoutHistory fixture-100k-300open | 57.2 [78.3] | 29.3 [46.9] | **−49%** |
| layoutHistory braided-50k-w16 | 44.9 [59.6] | 20.8 [33.2] | **−54%** |
| layoutHistory braided-50k-w64 | 45.8 [59.3] | 21.5 [32.3] | **−53%** |
| layoutHistory braided-50k-w256 | 45.2 [63.5] | 23.6 [32.9] | **−48%** |
| layoutHistory fixture-2k-small | 1.57 [2.74] | 0.53 [0.90] | −66% |
| paged fixture-100k-300open 10000x200 | 14.3 [23.0] | 10.1 [13.5] | −30% |
| paged braided-50k-w64 10000x200 | 16.9 [23.9] | 13.9 [19.4] | −18% (noise-level) |
| buildEdgeIndex / indexEdges (untouched code) | — | — | no change (noise ±15%) |

Equivalence check: passed. Decision: **keep**. Every layout scenario improved consistently in both min and
median, and the untouched scenarios (`buildEdgeIndex`, `indexEdges`) are the control showing noise stayed ±15%.

## Combined result (HEAD vs both changes, 31 runs, min [median] ms)

| Scenario | HEAD | Now | Change (min / median) |
| --- | ---: | ---: | ---: |
| layoutHistory linear-100k | 49.7 [68.4] | 28.7 [39.7] | −42% / −42% |
| layoutHistory fixture-100k-300open | 427.5 [461.0] | 28.5 [44.3] | **−93% / −90%** |
| layoutHistory braided-50k-w16 | 45.0 [69.9] | 22.5 [33.4] | −50% / −52% |
| layoutHistory braided-50k-w64 | 59.4 [82.5] | 22.9 [32.1] | −62% / −61% |
| layoutHistory braided-50k-w256 | 41.6 [76.1] | 22.1 [34.9] | −47% / −54% |
| layoutHistory fixture-2k-small | 1.74 [3.12] | 0.51 [0.90] | −71% / −71% |
| paged fixture-100k-300open 10000x200 | 71.2 [97.9] | 9.9 [21.2] | **−86% / −78%** |
| paged braided-50k-w64 10000x200 | 19.3 [35.0] | 13.1 [18.2] | −32% / −48% |
| buildEdgeIndex (control, unchanged) | 1.9–2.5 [6.4–6.8] | 3.0–3.1 [6.8–7.3] | noise |
| indexEdges 500 viewports (control, unchanged) | 1.95–5.1 [5.5–8.9] | 4.8–5.3 [6.3–9.0] | noise |

## Not attempted / observations

- `buildEdgeIndex` is O(edges) and runs after every page (3–7 ms at 100k edges) and `appendHistory` still copies
  `nodes`/`edges` containers each page, so deep paging is O(N²/page). At the 10,000-row depth measured by the
  Windows history benchmark the full paged layout workload took ~10 ms best-case. The separately measured
  86–96 ms/page includes Git, IPC, UI and automation, so it cannot isolate Git time. Reassess for
  much deeper walks. `useGraphLayout` also re-spreads prior arrays on the main thread per page (outside this scope of measurement).
- `slots.indexOf(null)` is still a linear scan over lanes; it is a cheap pointer compare and no longer visible
  in the 302-lane profile (that workload now matches the 1-lane one), so a free-lane heap was not worth the risk.
- No change to the `GraphLayout`, `LayoutState` consumers, or IPC/worker message shape except the additive
  `LayoutState.slotOf` field (worker-internal, never posted).
