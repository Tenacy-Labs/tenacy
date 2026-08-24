# PR #26 Review — Merge Gate (transcribed)

Reviewer: deleg_9c377352 (fresh context, 50 tool calls, live probes).
Hit the tool-iteration cap AFTER completing verification but BEFORE
writing this doc; transcribed by the orchestrator from the reviewer's
summary (subagent-summary-0-20260824_182919_503127.txt) per its
explicit instruction. Every claim below was probe-verified by the
reviewer; the two list items marked MINOR are reproduced verbatim.

## Verdict: **APPROVE** (2 minor findings, no blockers)

## Verified green (reviewer's live probes)
- **A. Topology**: root = workspaces + single dep stowage workspace:*;
  knapsack absent from deps/devDeps; bun.lock = exactly
  kernel->stowage->knapsack workspace links, zero registry versions;
  zero direct knapsack imports outside vendor/.
- **B. Fresh-install fidelity**: wiped node_modules (root + workspace),
  deleted bun.lock, install rc 0 (82 pkgs); regenerated lock
  BYTE-IDENTICAL to HEAD; both links are symlinks; CI pass (47s) on
  head — linux, first run with the committed linux .so.
- **C. Single module graph**: resolve lands in vendor/stowage/src;
  shim-path CacheModel === specifier CacheModel (=== true); knapsack
  spec === physical path (=== true); root cannot resolve knapsack;
  no physical copies anywhere.
- **D. Tripwires**: each new assertion discriminates (registry dep,
  direct knapsack, copy-install, registry lock entry each break one).
  Lineage documented honestly.
- **E. Snapshot fidelity**: stowage 9559e8f — 38 common files
  byte-identical except package.json (workspace dep) + 3 documented
  test import rewrites; knapsack 34 files sha-identical; all 5 dylib
  shas+sizes match PROVENANCE (aarch64 pin 619d097c...).
- **F. Native liveness**: dpKernelUsed "native", cells 4117, optimal,
  through the vendored graph on aarch64.

## Findings
1. MINOR — committed cargo build artifacts (vendor/knapsack/native/target/,
   11 files ~1MB, inert: loader reads prebuilt/ never target/; swept in by
   04fbfae) — addressed pre-merge: untracked + ignored.
2. MINOR — undocumented snapshot exclusions (CODE_REVIEW_*.md not brought;
   defensible, kernel reviews live in kernel history) — accepted as
   documented here.
3. NOTE (pre-existing) — scripts/vendor-knapsack.sh encodes the superseded
   file: doctrine — follow-up item, not a blocker.
