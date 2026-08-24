# Code Review — PR #25: vendor refresh (stowage + knapsack snapshots)

- **PR:** #25 `chore: vendor refresh — stowage + knapsack current (native SIMD line)`
- **Branch:** `chore/vendor-refresh` (single commit `9d7ae94`) → `main` (`e223239`)
- **Reviewer:** fresh-context merge gate (Hermes subagent), 2026-08-24
- **Method:** all in-repo operations via python subprocess (terminal lifecycle-guard is poisoned by committed dylibs — "embedded null byte" on any vendor/ path in the command string); probes in /tmp only.

## Verdict: **APPROVE**

---

## Gate results

| Check | Result |
|---|---|
| A. Snapshot fidelity vs upstream `9416fa1` | ✅ exact (see below) |
| B. No stray changes outside `vendor/` | ✅ clean |
| C. Adaptation minimality (2 recorded classes only) | ✅ confirmed (1 nit) |
| D. Gates: install / suite / tsc / native liveness | ✅ 912/912, tsc clean, `dpKernelUsed: "native"` live |
| E. Dylib sha256 integrity | ✅ `619d097c…f1b` (matches PROVENANCE.md + upstream) |
| F. Root package.json topology unchanged | ✅ still `file:vendor/knapsack` direct dep |

---

## A. Fidelity vs upstream stowage `9416fa1`

Upstream tree is clean at `9416fa1` (`docs: refresh stale kernel-default comments + README perf intro`).

**File sets — exact match, zero discrepancies:**
- `vendor/stowage`: 43 tracked files vs upstream's 43 non-`vendor/` tracked files — set difference empty both directions. Upstream's own nested `vendor/` is excluded from the snapshot (as specified). Upstream `@9416fa1` tracks **no** `.github/` and **does** track `CODE_REVIEW_PHASE3.md`, `CODE_REVIEW_PR3/4/5.md`, `docs/review/*.md` at root — all are included in the snapshot, as they should be under "mirror `git ls-files`".
- `vendor/knapsack`: 30 tracked files vs upstream `vendor/knapsack/`'s 30 — set difference empty both directions.

**Byte-level content (git blob-hash comparison of every file):**
- All 30 `vendor/knapsack` files: **byte-identical** to upstream — no exceptions, including the dylib (binary), `PROVENANCE.md`, `Cargo.toml/lock`, `lib.rs`, `native.ts`, `dp-soa.ts`, `solve.ts`, `types.ts`, `native.test.ts`, `README.md`, `package.json`.
- 39 of 43 `vendor/stowage` files byte-identical. The 4 that differ are exactly the recorded-adaptation files (see C).

## B. No stray changes

`git diff e223239..HEAD` touches **only** `vendor/stowage/*` (24 paths) and `vendor/knapsack/*` (23 paths) — 47 files, 14 M / 33 A, matching the PR's `changedFiles: 47`. Diff filtered to `:(exclude)vendor` is empty: nothing in agent-kernel's own `src/`, `test/`, `docs/`, root `package.json`, or `bun.lock`. Working tree clean vs HEAD (blob-hash verified, not just `git status`).

## C. Adaptation minimality

Exactly **4 files** differ from upstream, covering exactly the **2 recorded adaptation classes:

1. **`vendor/stowage/package.json`** — `@connectotron/knapsack`: `file:vendor/knapsack` → `file:../knapsack` ✅ (recorded; the established sibling-snapshot fix)
2. **`test/bounded-brackets.test.ts`**, **`test/dp-soa.test.ts`**, **`test/native-kernel.test.ts`** — `../vendor/knapsack/src/*` imports → `../../knapsack/src/*` ✅ (recorded; same resolution class, all occurrences, nothing else touched)

No other text differences vs upstream anywhere in either snapshot.

## D. Gates re-run (this host, full PATH)

- `bun install --frozen-lockfile` → rc 0 (`@connectotron/knapsack@vendor/knapsack`, 1 package, lock untouched).
- `bun test` → **912 pass / 0 fail across 40 files** (9,724 expect calls, 14.8s). Composition reconciles with the commit message: 29 agent-kernel test files + 11 vendored test files; 874 own + 38 vendored test cases. Both vendored 500-problem native-vs-SoA differentials **ran** (not skipped) on this aarch64 host: knapsack side `differential ran 500 of 500 problems; mismatches 0`; stowage side `[native-kernel] differential ran 500 problems; mismatches 0`.
- `bun x --bun tsc --noEmit` → rc 0, zero diagnostics.
- **Native liveness probe** (fresh /tmp script against the vendored graph): `nativeAvailable() === true`; scan over the vendored generator's seeds found DP-required instances (e.g. seed 1253, nG=24, cap=903) where `solve()` reports `stats.dpKernelUsed: "native"` with `dpCellsVisited > 0`, `status: "optimal"` — the committed dylib is genuinely exercised through the default native-first policy, not just the fallback path.

## E. Dylib integrity

`vendor/knapsack/native/prebuilt/aarch64-apple-darwin.dylib`
sha256 `619d097cd6049964373dbce9e4799f8f8fd44b664f36466c1349364e31f26f1b`
= PROVENANCE.md's recorded value = upstream stowage's committed dylib (byte-identical blob).

## F. Root topology

Root `package.json` unchanged by the PR (empty diff vs base); still declares `@connectotron/knapsack: file:vendor/knapsack` as a direct dependency. Topology cleanup remains out of scope as stated. The existing seam tripwires (no stowage package dep, specifier must not resolve, lock carries no stowage entry) all still pass.

---

## Findings

### Critical
None.

### Major
None.

### Minor
None.

### Nits (non-blocking, informational)

1. **`vendor/stowage/package.json` `description` field is unicode-escaped** vs upstream (`—`→`\u2014`, `×`→`\u00d7`). This is a byte-level third hunk in the one adaptation file beyond the recorded dep rewrite — almost certainly bun's package.json writer normalizing escapes when the dep edit was made. Semantically identical JSON (same decoded string), zero behavioral impact. If future refreshes want a strict "one-line diff" invariant on this file, re-apply the dep edit without letting bun rewrite the file, or record the normalization in the adaptation note.
2. **`vendor/stowage/bun.lock` is snapshotted** from upstream. It is upstream-faithful (so fidelity-correct) but references `file:vendor/knapsack` inside stowage's own topology; it is inert for agent-kernel installs (root lock governs). No action needed — just noting it will churn on every refresh.

## Tree state after review

Clean vs HEAD; only untracked artifact is this file (`CODE_REVIEW_PR25.md`). No production code touched, nothing committed.

**Recommendation: merge.**
