# Optimization goal and decision log

**Goal:** Reduce the cost of navigating large Git histories and reviewing large diffs. Try one change at a time against the last kept implementation. Keep a change when its target workload improves, the results justify the added complexity, and correctness checks pass. Revert inconclusive changes. Record the workload, baseline, result, scope and decision even for rejected experiments.

## History graph — 2026-11-20

**Kept both experiments:** index reserved lanes by commit ID, then avoid temporary parent sets/arrays for the common zero- or one-parent commit. On the synthetic 100,300-commit, 300-open-branch workload, median full layout fell from **461.0 to 44.3 ms** and median paged layout to 10,000 rows fell from **97.9 to 21.2 ms**. These are Node layout timings; they exclude Git, worker transfer and browser rendering. See the [graph experiment log](perf-graph-experiments.md) for isolated results, workload equivalence checks and the noise control. Reproduce the combined comparison with `node --expose-gc scripts/bench-graph.mjs --baseline ab3d690 --runs 31`.

## Diff review — 2026-11-20

Starting revision `ab3d690`, Windows 11 Enterprise build 26300, Node 26.13.1, headless Edge 157.0.4341.60. Numbers are local medians; lower is better.

| Experiment | Baseline → candidate | Decision |
| --- | --- | --- |
| D1. Size the split line-number gutter once per hunk-list/layout change; skip the scan in unified view. | ms per key update: unified **4.245 → 1.995**, split **7.030 → 4.930** | **Keep.** Both layouts benefit and the expensive scan now depends only on its inputs. |
| D2. Build paired rows in place using one cursor per side, instead of buffering additions/removals and flushing on every context line. | ms per model: sparse **1.564 → 1.060**, replacement **1.006 → 0.630** in isolated runs. | **Reverted after replication.** Initially promising, but the sparse result reversed on a rotated repeat. Full row data matched, including original selection indices. |
| D3. Preallocate one row slot per input line on top of D2; trim unused slots at the end of the hunk. | Sparse/replacement: D2 **1.060/0.630**; D3 **1.946/1.569**, repeat **2.309/0.802**, revert to D2 **4.877/2.195** ms. | **Reverted.** Changing machine load swamped the isolated timings. The rotated run favored preallocation, but the gain was inconsistent across runs; insufficient evidence for reserving surplus slots and tracking another counter. |

**D1 replication:** after restoring the original pairing code, removed the gutter change, measured, reapplied and measured again. Unified **4.615 → 2.008** and split **9.195 → 4.785** ms/key; the improvement repeated in both layouts.

**Load cross-check:** ran D2, the original, and D3 in one process, rotating timing order every batch. Sparse medians were **4.677 / 6.953 / 3.390** ms respectively; replacement medians were **2.574 / 7.736 / 2.369** ms. Some batches exceeded 30 ms per model. Repeating the rotated comparison produced **4.779 / 3.287 / 2.479** ms sparse and **2.217 / 2.679 / 2.453** ms replacement. D2 lost to the original on sparse input and D3 lost to D2 on replacements in that repeat. With this much variation, neither rewrite earned its place.

### Reproduce

- **D1:** `node src/components/split-diff.smoke.mjs --bench-navigation` with Playwright Chromium installed (`npx playwright install chromium`), or set `CHROMIUM_EXECUTABLE_PATH` to a Chromium executable. Run with the same harness on each revision. The Vite dev fixture uses 20,000 input lines. Two warm-up and seven measured batches alternate 40 ArrowDown/ArrowUp events between the same two visible lines; every key must commit the expected active row. Measures event dispatch through React commit in a browser, excluding paint, startup and Git.
- **D2/D3:** `node scripts/bench/diff-pairing.mjs` on Node with TypeScript stripping (tested on 26). Each deterministic shape has 20 hunks × 1,000 lines; sparse changes yield 19,820 rows, dense unequal replacements with metadata yield 10,420. Median of nine measured batches of 40 model builds after three warm-up batches. No React or DOM. For a rotated comparison, pass paths to additional `splitDiff.ts` source versions; the script deep-compares the row lists before timing. For example in PowerShell:

  ```powershell
  $baseline = Join-Path $env:TEMP "gitty-splitDiff-$([guid]::NewGuid()).mts"
  git show ab3d690:src/model/splitDiff.ts | Set-Content -Encoding utf8 $baseline
  node scripts/bench/diff-pairing.mjs $baseline
  ```

- **Correctness:** The Edge smoke test passed with D1 and D2 in place, including paired column alignment, six-digit line fixture, original staging indices, virtualized scrolling, wrapping and keyboard focus in both layouts. After restoring the original pairing code, two smoke runs raced font measurement or the scroll update. Replaced the fixed initial scroll delay with waits for the measured scrollbar and deep virtual window; both layouts passed with D1 alone. The row-model benchmark deep-compared both fixtures across all three implementations. These checks use synthetic diffs.
- **Tests:** `WorkingChanges.test.ts` and `splitDiff.test.ts` passed (67 tests), including a same-path diff refresh that widens the gutter from four to six digits. The full frontend run during the experiment had one unrelated failure: this host's `en-DK` locale formats the date as `6 Nov`, while `dates.test.ts` expects `Nov 6`.
