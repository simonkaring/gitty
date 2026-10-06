---
type: Playbook
title: Knowledge maintenance
description: How to keep this small source-backed OKF bundle aligned with code and tests.
status: draft
sources:
  - id: spec
    resource: https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/ad30107c31c06aec8a7d5636e0d1058118604e6f/SPEC.md
  - id: guide
    resource: ../../agents.md
---

# Knowledge maintenance

## Format and scope

This pilot targets **OKF 0.2**, canonical spec revision
**ad30107c31c06aec8a7d5636e0d1058118604e6f**. Upgrade the pin deliberately after
reading the spec diff, then update this page and, for a version change, the
`okf_version` in [the index](index.md).
Every non-reserved Markdown file in this bundle is a concept with parseable
YAML and a nonempty string `type`. Root `index.md` is a directory listing with
only `okf_version` frontmatter and a body of headed sections of
`[Title](path) - description` entries (no guidance prose); entry descriptions
mirror each concept's `description`. Nested indexes have no frontmatter.
`log.md` is reserved for date-grouped history, never a concept.[^spec]

Concepts are draft navigation summaries; code and tests are authoritative.
Keep a small set of cross-cutting summaries and navigation links. Detailed IPC
contracts stay in [BACKEND.md](../../src-tauri/BACKEND.md); setup and user-facing
behavior stay in [README.md](../../README.md). Most sources live outside the
bundle, so use relative repository links (they resolve only in a repository
checkout), `sources` entries with `resource`, and stable source IDs for
attribution footnotes. Prefer named symbols/tests over fragile line-number links.

## Per-change workflow

1. At task start, inspect the index and relevant concepts, then verify claims
   against current implementation and tests. Historical milestone notes are
   context, not current authority.
2. Assess knowledge impact for **every code change**. Changes to behavior,
   contracts, invariants, platform boundaries, verification procedures, or
   architecture require affected knowledge updates in the **same patch**.
   Cosmetic or unrelated changes require no knowledge edits.
3. Correct stale discoveries. Code/tests are authoritative; reconcile concepts,
   backend contract, and README where affected, preserving unrelated user edits.
   If the evidence does not resolve a disagreement, record the unresolved point
   and its source links instead of silently choosing a claim.
4. Update source links and the index for added, moved, or retired concepts.
   Keep summaries short; avoid copying command catalogs or historical test totals.
5. Validate YAML, required `type`, reserved-file rules, source/footnote IDs,
   relative links (including heading fragments), and diff whitespace. Review
   both tracked diffs and new files. Use [verification guidance](demo-and-native-verification.md)
   for any accompanying application changes.
6. Report checks actually performed and unresolved coverage. Source inspection,
   syntax validation, mocked tests, real Git tests, and platform runtime checks
   are distinct evidence.[^guide]

## Freshness and review

Suggest a stale-content sweep **monthly or before a release**: revisit each
concept's linked code/tests, check platform limitations and verification commands,
repair moved links, and reconcile README/backend discrepancies. This is a review
cadence suggestion, not an automated job or completed review.

The initial concepts use `status: draft` and omit `generated`, `verified`, and
`stale_after`; git history records changes. Absence of `verified` means
unverified under OKF, even when sources were inspected. Do not add speculative
human-review metadata. If verification metadata is introduced, record the real
actor and event plus evidence of scope/platform/outcome in prose. Timestamps
must be ISO 8601 datetimes with an explicit UTC offset. Never bump freshness
dates without substantive source revalidation; a cosmetic edit is not renewal.
Keep authorship, content change, source revalidation, and test execution distinct.[^spec]

## Tooling decision

No persistent validator, dependency, generated index, or CI job is needed for
five concepts. Use an available YAML parser and a one-off local link/structure
check for this pilot, plus `git diff --check` (include new files in validation).
Reconsider a small repository validator if the bundle grows or repeated format
and link errors justify one. Syntax checks cannot establish semantic freshness.

[^spec]: OKF v0.2 sections 3–9, 11, and 12 at the pinned revision.
[^guide]: Repository agent knowledge-maintenance requirements.
