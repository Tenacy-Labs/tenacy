# Independent Code Review — Phase 3 Sequence Position

**Reviewed:** `feature/sequence-position` at `59ed387c5e5908e675f4de1439b7791dec1717ec` against `main` at `0843ebf1afbad1d30c19695f53056fb1d21edf95`
**Scope:** 9 changed files, +778/-68
**Verdict:** ~~**NOT MERGE-READY**~~ → **RESOLVED 2026-08-24** (see Resolution below)
**Severity summary:** 0 critical, **4 major**, 3 minor

## Resolution (2026-08-24)

All four majors and MINOR-3 are fixed at commits `6e895d8` (RED tests) + `e8db71e` (fixes), verified live:

- **MAJOR-1** — `normalizeSequenceOrder` rebuilt single-pass O(n) bucket reassembly; `zoneOf` probed at most 2n times; regression pins `zoneCalls ≤ 4n`. **Fixed.**
- **MAJOR-2** — `capped` re-probed after the fifth accepted move via pure `hasAcceptableMove(entries)`; cascade test proves sixth-pending-move detection (5 accepted + capped:true; second call accepts it). **Fixed.**
- **MAJOR-3** — topological repair keyed by `(parentId, zone)`; cross-zone family can never write into another zone's slots; global ZONE_ORDER monotonicity held. Reviewer ZONE_REPRO output: `[delta@foundational, base@evolving]`. **Fixed.**
- **MAJOR-4** — per-block evidence semantics in `transactionCost`: block wall stamp wins for that block, absent stamp falls back to that block's turn stamp, snapshot expiry short-circuits. Reviewer TTL_REPRO: `partialWallCost 0.84 → 0.30 == noWallCost`. **Fixed.**
- **MINOR-3** — `precedenceOrder` iterative; 200k-member lineage completes (was `RangeError`). **Fixed.**
- **MINOR-1** — partial coverage added: option-over-item metadata override test. (Remaining listed gaps acknowledged as backlog.)
- **MINOR-2** — RED tests committed as a separate durable commit (`6e895d8`) before the fix commit; observed-RED evidence recorded in its message.

**Gates after fixes:** `bunx tsc --noEmit` exit 0 · `bun test` **648/648**, 8,139 expects, 5 files (642 pre-existing all passing) · reviewer repro scripts re-run green against fixed tree · `git diff --check` clean.

The core direction is sound: sequence metadata is optional, option metadata overrides item metadata, deltas remain independent items, the planner uses prefix differences for O(1) bill queries, tie-breaking is explicit, no random search was introduced, diagnostics and regret rows are present, and the exact MCKP engine has only one call site. However, four contract-affecting defects remain.

## Major findings

### MAJOR-1 — Accepted ADR's normalization complexity claim is false; the implementation is O(n²)

**Files/lines:**
- `src/sequence-position.ts:67-77`
- `docs/adr/0001-sequence-position-semantics.md:65-67`

`normalizeSequenceOrder()` removes each delta with `splice`, then for every delta scans the entire remaining array to locate its zone tail and inserts with another `splice`. With `d = Θ(n)`, both the nested scan and repeated array shifts are Θ(n²). This contradicts the accepted ADR's statement that canonical sorting and precedence normalization remain O(n log n).

The move-pass preprocessing itself is genuinely O(n) (`src/sequence-position.ts:159-185`) and each bill query is O(1) (`:196`), but candidate ranking sorts up to O(n) candidates (`:206-212`), and the preceding normalization is quadratic. Therefore the narrower “O(1) candidate pricing” claim is true; the overall placement-complexity narrative is not.

**Reproduction/inspection:**

```sh
git grep -nE 'for \(|\.splice\(' 59ed387 -- src/sequence-position.ts
```

Observe the per-delta loop at line 71 containing the full-array loop at line 74 plus `splice` at line 77; line 68 also repeatedly shifts the array.

**Required before merge:** Implement linear bucketing/reassembly (plus sorting only where required), or amend the accepted ADR and explicitly accept/test the quadratic bound. Given the phase-3 contract, the former is preferred.

---

### MAJOR-2 — `capped` can be false even though the five-pass cap leaves an immediately acceptable move pending

**File/lines:** `src/sequence-position.ts:229-234`

On pass five, `capped` is inferred from the number of candidates accepted **before** the fifth move. The planner does not recompute after that move. A fifth move can lower another candidate's intervening bill and make it acceptable; if only the selected candidate was acceptable before the move, line 233 reports `capped: false` even though a sixth move is ready.

**Reproduction:** An isolated review script at `/private/tmp/phase3-review-repros.ts` constructs six nested base/delta families where each accepted move removes 10 tokens from the next candidate's bill:

```sh
cd /private/tmp/stowage-phase3-review
bun /private/tmp/phase3-review-repros.ts
```

Observed output:

```text
CAP_REPRO {"first":{"movePasses":5,"capped":false,"acceptedMoves":5,...},
"second":{"movePasses":2,"capped":false,"acceptedMoves":1,...}}
```

Calling the planner again accepts the pending sixth move, proving the first result stopped because of the cap, not convergence.

**Impact:** `SolverResult.capped`, the primary convergence diagnostic, is false-negative. Operational cap-rate monitoring and defect detection are unreliable.

**Required before merge:** After the fifth accepted move, recompute whether any accepted candidate remains (or conservatively mark capped whenever pass five accepts and prove quiet convergence separately). Add the cascade regression test.

---

### MAJOR-3 — Topological repair can move entries out of their zone-tail/legal ordering

**File/lines:** `src/sequence-position.ts:81-95`

The topological repair records slots without their zones, sorts a family, then writes different family entries into those slots. Because each entry's zone comes from its own chosen option, swapping values across slots can invert global zone order and remove a delta from its own zone-tail branch point.

**Reproduction:** `/private/tmp/phase3-review-repros.ts` creates an evolving base and a foundational delta with `delta.predecessorId = base`:

```sh
cd /private/tmp/stowage-phase3-review
bun /private/tmp/phase3-review-repros.ts
```

Observed:

```text
ZONE_REPRO [{"id":"base","zone":"evolving"},{"id":"delta","zone":"foundational"}]
```

The final layout puts an evolving item before a foundational item. The foundational delta is not at the foundational zone tail. This contradicts ADR-0001 lines 42-45 and the implementation comment at `src/sequence-position.ts:52-55`.

**Impact:** Independent base/delta options may legally choose different zones, but precedence repair can produce a layout that is neither canonical by zone nor at the promised zone-tail branch point.

**Required before merge:** Define the precedence-versus-zone rule for cross-zone lineages and enforce it without assigning entries to slots belonging to another zone. Reject impossible metadata explicitly if precedence is not allowed to cross zones. Add a cross-zone test.

---

### MAJOR-4 — Partial wall-clock metadata disables valid turn-TTL fallback in solver suffix pricing

**File/lines:** `src/solver.ts:759-777`

`hasWallEvidence` becomes true whenever `blockWriteWallTimeMs` exists, even when the relevant suffix entries are `undefined`. That globally disables `turnExpired`. Meanwhile, `wallBlocksExpired` requires every relevant wall timestamp to be defined and expired. Thus an array with missing relevant stamps is treated as usable wall evidence but cannot establish expiration, and expired turn stamps are ignored.

This violates the contract: wall time should win when usable stamps exist; otherwise turns are the fallback.

**Reproduction:** `/private/tmp/phase3-review-repros.ts` prices a rewritten 100-token first block with a 200-token suffix. Turn stamps are expired. The relevant wall stamp is absent:

```sh
cd /private/tmp/stowage-phase3-review
bun /private/tmp/phase3-review-repros.ts
```

Observed:

```text
TTL_REPRO {"noWallCost":0.30000000000000004,"partialWallCost":0.8400000000000001}
```

The same expired suffix costs 0.30 (own rewrite only) without the partial wall array but 0.84 with `[0, undefined]`; the missing wall stamp suppresses the valid turn fallback and adds the suffix spread.

**Required before merge:** Decide wall/turn freshness per relevant block (or require complete usable wall evidence before suppressing turn fallback). Add solver-level tests for partial wall stamps and both transaction-cost/shared-credit paths.

## Minor findings

### MINOR-1 — The nine new tests discriminate as a suite, but not all nine are independently meaningful against pre-phase-3

**File/lines:** `test/sequence-position.test.ts:1-191`

Copying the exact test file to `0843ebf` and running it fails during module loading because `interveningMoveMass` is not exported:

```sh
cd /private/tmp/stowage-red
bun test test/sequence-position.test.ts
```

Observed: `Export named 'interveningMoveMass' not found`, 0 tests executed. Therefore the **suite** unquestionably fails on pre-phase-3, but this run does not prove all nine assertions independently discriminate.

By inspection, eight cases have phase-3-specific expectations and would fail or be unavailable on old code. The final turn-fallback test (`:184-190`) is not independently discriminating: it updates and checks in the same turn, so the legacy turn-only model also returns a hit. It does not test turn expiration. Coverage is also missing for:

- option metadata overriding item metadata;
- cross-zone precedence and precedence after multiple moves;
- deterministic surplus/id tie-breaking across insertion orders;
- the false-negative cap cascade above;
- partial wall-clock stamps and solver TTL pricing;
- direct evidence that exact relief calls MCKP no more than once;
- metadata-free placement equivalence, not merely two repeated feature solves.

The existing cap test (`:139-153`) catches only the case where more than one candidate is already acceptable before pass five, which is why MAJOR-2 passes unnoticed.

---

### MINOR-2 — No auditable RED-GREEN sequence exists in Git history

**Evidence:** `git log 0843ebf..59ed387` contains one commit that adds tests and production code together. The feature reflog shows branch creation followed by the single implementation commit. An exact copy of the new test exists untracked in `/private/tmp/stowage-red`, and running it red against the baseline proves test discrimination at review time, but its timestamp is after the implementation commit and it is not durable history evidence.

This does not prove TDD was not followed; it means RED-GREEN discipline cannot be verified from the submitted history. Preserve a red test commit/run artifact in future phase submissions.

---

### MINOR-3 — Sequence metadata has no validation; pathological precedence chains can exhaust the call stack

**File/lines:** `src/sequence-position.ts:98-119`

`precedenceOrder()` is recursive and accepts arbitrary producer edges. A 200,000-member lineage whose ascending members point to the next member throws `RangeError: Maximum call stack size exceeded` under Bun. Cycles are silently tolerated at line 107 rather than rejected, so malformed metadata can also produce an order that satisfies no meaningful precedence contract.

**Reproduction:**

```sh
cd /private/tmp/stowage-phase3-review
bun /private/tmp/phase3-stack-repro.ts
# STACK_REPRO RangeError: Maximum call stack size exceeded
```

Expected production sizes are far smaller and ADR-0001 explicitly leaves producer-side validation out of scope, so this is minor rather than a merge blocker/security critical. An iterative topological pass plus validation of finite ordinals, same-parent predecessors, missing predecessors, and cycles would harden this boundary.

## Contract verification

| Contract area | Result |
|---|---|
| Optional sequence metadata; independent delta items; option override | Implemented and backward-compatible at the type/API level. |
| Per-parent precedence | Implemented for normal same-zone acyclic lineages; cross-zone repair is defective (MAJOR-3). |
| O(n) move-pass preprocessing / O(1) mass query | Confirmed at `src/sequence-position.ts:159-196`. Overall normalization is O(n²) (MAJOR-1); candidate ranking is O(n log n). |
| Deterministic tie-breaking / no random search | Confirmed explicit surplus then code-unit id sort; no `Date.now`, `Math.random`, UUID, locale collation, network, or stochastic search in changed runtime code. |
| File-migration credit-vs-bill fuse | Implemented as `credit >= intervening bill`; exact-token threshold and regret rows pass. |
| Diagnostics / quiet path / ≤1 MCKP | Fields are present; quiet path is one pass; `solveMckp` has one call site and one conditional invocation. `capped` is defective (MAJOR-2). |
| Dual-axis TTL / helpers | CacheModel wall-vs-turn behavior and breakpoint helpers exist; solver fallback is defective for partial wall evidence (MAJOR-4). |
| Regret ledger / rejected moves / thrash | Implemented for evaluated threshold-rejected and selected accepted moves; reversal signal passes. |
| Backward compatibility | No original tests were modified. All 633 original tests pass on baseline and all 642 tests pass on the feature. New result fields are additive. |
| Security | No eval/process/network/filesystem additions; SHA-256 digest behavior unchanged; `bun audit` reports no vulnerabilities. Metadata validation/recursive availability risk noted in MINOR-3. |

## Verification performed

All release commands were run from detached worktree `/private/tmp/stowage-phase3-review` at `59ed387` after `bun install --frozen-lockfile`:

```text
bunx tsc --noEmit
exit 0

bun test
642 pass, 0 fail, 6327 expect() calls, 4 files
```

Original tests only on `0843ebf`:

```text
bun test test/port.test.ts vendor/knapsack/test/solver.test.ts vendor/knapsack/test/validation.test.ts
633 pass, 0 fail, 6311 expect() calls, 3 files
```

Other checks:

```text
git diff --check 0843ebf..59ed387   # clean
bun audit                            # No vulnerabilities found
```

An initial feature-worktree test/typecheck attempt before dependency installation failed because the fresh detached worktree had no `node_modules`; after the lockfile-frozen install, both canonical gates passed as shown above.

## Merge readiness

**Do not merge `59ed387` as-is.** Resolve MAJOR-1 through MAJOR-4 and add regressions for the cap cascade, cross-zone legality, and partial-wall fallback. Then rerun strict TypeScript and all 642+ tests. The existing design can likely be retained; the blockers are localized to normalization, cap detection, and TTL evidence selection.

---

## Independent verification (fresh-context reviewer, 2026-08-24)

**Reviewed:** fixes at `6e895d8` (tests) + `e8db71e` (fixes) + `b0cc0c1` (docs), against `59ed387` (pre-fix) — **Verdict: APPROVE.** All four majors and MINOR-3 are genuinely fixed, discriminated by RED tests, and reproduce under the original review's own repro scripts. Findings below are minor follow-ups; none blocks merge.

### Gates reproduced (this tree, `b0cc0c1`)

```text
bunx tsc --noEmit        # exit 0
bun test                 # 648 pass, 0 fail, 8139 expects, 5 files
```

### Original repro scripts re-run against this tree (imports retargeted)

```text
CAP_REPRO   first {movePasses:5, capped:true, acceptedMoves:5} · second {movePasses:2, capped:false, acceptedMoves:1}  → MAJOR-2 fixed
ZONE_REPRO  [{delta,foundational},{base,evolving}]                                                                     → MAJOR-3 fixed (monotonic zone order, delta at foundational tail)
TTL_REPRO   noWallCost 0.30 · partialWallCost 0.30                                                                     → MAJOR-4 fixed (turn fallback not suppressed)
STACK_REPRO completed at n=200,000                                                                                     → MINOR-3 fixed (iterative precedenceOrder)
```

### RED discrimination re-verified on pre-fix `59ed387` (detached worktree)

`test/review-fixes.test.ts` copied verbatim onto `59ed387`: **4 fail / 2 pass** — the four major-fix tests fail (MAJOR-1 zone-call pin, MAJOR-2 cascade, MAJOR-3 cross-zone, MAJOR-4 partial wall); the two companion tests pass (same-zone precedence, option-override — not claimed RED). The suite genuinely discriminates the fixes.

### Fix-code scrutiny (new-defect hunt)

- **`normalizeSequenceOrder` bucket reassembly (`src/sequence-position.ts:87-124`)** — traced the zone-run flush logic through: empty buckets, buckets for zones with no kept entries (flushed by a later run's pre-flush or the final ZONE_ORDER sweep), trailing tail-deltas, all-delta input, and repeated non-contiguous runs. Sound and permutation-preserving for the solver's zone-sorted input (runs contiguous; kept order preserved; every entry emitted exactly once — bucket flushes are single-shot). For non-zone-sorted input neither old nor new code is zone-monotonic, with one behavioral nuance: the old splice code appended a zone's deltas after its **last** kept run, the new code after its **first**; unreachable from `solve` (stage-2 sorts by zone, `src/solver.ts:390`) and unpinned by ADR/tests either way. Spread `entries.push(...result)` verified safe at n=200,000 in Bun/JSC.
- **Zone-local repair keys (`:133-146`)** — `(parentId, "\0", zone)` families write values only into same-zone slots; a clean permutation per family (spine emission covers every value; `ordered.length === slots.length`). Global zone monotonicity survives by construction. NUL-in-item-id key collision is pathological-only.
- **`hasAcceptableMove` (`:302-307`) purity** — confirmed: builds local prefix + candidate scan, writes no ledgers, mutates nothing; runs once, only after the fifth accepted move; probe reflects post-move layout.
- **Iterative `precedenceOrder` (`:154-180`)** — output-equivalent to the recursive DFS on chains, cycles (A↔B emits [B,A] both ways), and self-loops; cross-family/missing predecessors stop the spine identically; 200k chain completes.
- **`transactionCost` per-block TTL loop (`src/solver.ts:766-797`)** — block indexing aligns exactly with `suffixMassAfter` (0-based stamp index = charged block); snapshot-expiry short-circuit precedes the loop (equivalent to the old union); missing-evidence default is warm/charge — conservative, and it *corrects* the old vacuous-`.every()` behavior that granted free restructure for positions beyond truncated arrays.

### Minor follow-ups (non-blocking)

1. **Dead code:** `deltas.sort(sequenceCompare)` at `src/sequence-position.ts:76` sorts an array whose order is never read — buckets are built by a separate index-order scan of `entries`. Misleading (suggests sorted bucket order; actual bucket order is stage-2 layout order). Harmless: the zone-local repair re-sorts per-family values, and the ADR pins no inter-family order. Remove or wire it up.
2. **Resolution overclaims "zoneOf probed exactly once per entry":** it is probed 2n times (`:65` and `:132`) — still O(n), and the test's `≤ 4n` pin is honest, but `zonesAfter` could be derived by permuting the cached `zones[]` instead of re-probing (also removes any dependency on `zoneOf` idempotence).
3. **Shared-credit path not harmonized (`src/solver.ts:478-494`):** the A-M9 credit discount still gates its turn fallback on `!hasSnapshotWall`, so (partial wall array + fresh snapshot + expired turn stamps) yields an undiscounted credit mass while `transactionCost` collapses the charge — an overstated `sharedBillCredit`. Journaled metric only (post-selection, not a selection input), so minor; but MAJOR-4's review *Required* asked for tests on both the transaction-cost and shared-credit paths, and only the former is covered.
4. **`git diff --check 0843ebf..b0cc0c1` is NOT clean** (contrary to the Resolution's gates line): trailing whitespace on `CODE_REVIEW_PHASE3.md:3-5`, introduced by the resolution commit itself. Cosmetic; fix the doc's markdown hard-breaks or drop the claim.
5. **Duplication:** `scanFuseCandidates` (`:309-341`) duplicates the pass-loop's predecessor/candidate logic (`:228-264`). Semantically identical today (verified line-by-line); extract a shared helper before the acceptance rule ever changes, or `capped` will drift again.
6. **`suffixCount` via `max()` of evidence-array lengths (`src/solver.ts:766-770`):** over-scans phantom blocks when evidence arrays outlength `blockMass`/`blockCount` (malformed incumbents only); effect is conservative (withholds the cold discount). `blockMass?.length ?? blockCount` would be the exact bound.

**Backlog resolution (2026-08-24, commits `28febf9` RED → fix commit):** items 3, 5, and 6 are now fixed on `feature/review-backlog`:
- **#3/#4** — shared-credit path harmonized with MAJOR-4 per-block evidence semantics: fresh-snapshot no longer suppresses turn expiry for blocks without wall stamps; snapshot acts only when expired (mirrors `transactionCost`). RED test observed a fabricated −0.81 credit; post-fix it is 0.
- **#5** — `scanFuseCandidates` is now the single candidate-scan implementation, shared by the pass loop and the post-cap probe (`previousMoves` wired for reversal detection). Invariant pinned by test: `capped === (a further call accepts a move)`.
- **#6** — `suffixCount` clamped by `Math.min(..., blockCount)`; phantom stamps past the real block count can no longer warm (or chill) a suffix. RED test observed 0.84 (phantom-warmed); post-fix 0.30 own-cost collapse.

### Independent verification of backlog fixes (fresh-context reviewer #2, 2026-08-24, `0c738bc`)

**Gates reproduced on `feature/review-backlog` @ `0c738bc` (clean tree):** `bunx tsc --noEmit` exit 0 · `bun test` **651/651 pass, 0 fail, 8,147 expects, 6 files** (4 repo + 2 vendored knapsack). Matches the commit's claim exactly (648→651 tests, 8,139→8,147 expects = the 3 new tests / 8 expects).

**RED discrimination re-run live:** detached worktree at `28febf9` (= base `f145c63` + RED tests only, no fix): `#4` FAILS — `sharedBillCredit` expected ≈0, received −0.81 (the fabricated credit); `#6` FAILS — cost expected 0.30, received 0.84 (phantom-warm). Both magnitudes match the commit message. `#5` passes at RED — by design: it is an invariant *pin* (`capped === (a further call accepts a move)`), not a discriminating regression; the commit message discloses this ("+ #5 invariant pin"), and no behavioral RED was possible for a pure dedup refactor.

**Fix-code scrutiny:**
- **#4** (`src/solver.ts:488-500`): `hasSnapshotWall` declaration and its `!hasSnapshotWall` term removed; `turnExpired = !hasBlockWall && turnWrite !== undefined && turn - turnWrite > ttlTurns` — per-block evidence, identical shape to `transactionCost`'s loop. The `snapshotWallExpired → mass = 0` whole-cache-cold path is intact (unchanged branch), so the 0-mass path is not broken; no double-discount — per-block subtraction runs only in the non-snapshot-expired branch and `mass = Math.max(0, mass)` (`:503`) still clamps. Blocks with no stamp on either axis count as warm — matching `transactionCost`'s conservative no-evidence default. Fresh-snapshot+expired-turns now yields credit 0 (RED−0.81 → GREEN ≈0), and the test's warm-equivalence assertion (fresh snapshot + fresh turns ≡ no snapshot + fresh turns) confirms the fresh-snapshot path is fully inert.
- **#5** (`src/sequence-position.ts:276-317`): `scanFuseCandidates` is the only candidate scan; called from the pass loop (`:228`, with `previousMoves`) and the post-cap probe (`:273`, with `undefined`). The reversal computation moved **verbatim** from the old pass-loop inline scan (char-identical lines in the diff); the probe's old copy hardcoded `reversal: false` but only ever read `.accepted`, so wiring is behavior-preserving. Rejected-ledger logging (`rejectedLogged` set + `moveLedger` pushes, `:239-243`) remains in the pass loop only; the probe is still pure (no ledger writes, no mutation).
- **#6** (`src/solver.ts:776-784`): `suffixCount = Math.min(Math.max(wallLen, turnLen, massLen), blockCount) - prev.position`. The clamp only tightens the scan when an evidence array exceeds `blockCount` (the malformed case); for arrays ≤ `blockCount` the bound is unchanged, so no legitimate suffix block is skipped. Indexing aligns with the charge side (`suffixMassAfter` sums `blockMass[position..blockMass.length)`; the scan reads stamps at the same 0-based indices) whenever `blockMass.length ≤ blockCount`. Phantom stamps can only be dropped, never re-weighted, so a suffix can neither phantom-warm nor phantom-chill.

**Non-blocking notes (no action required for merge):** (a) the doubled A-M9 comment block inside the restructures map (`src/solver.ts:466-483`) pre-exists at base `f145c63` — cosmetic, not introduced here; (b) if a malformed incumbent ever carries `blockMass.length > blockCount`, the charge side (`suffixMassAfter`) still uses `blockMass.length` while the expiry scan now uses `blockCount` — unreachable from the store's write-back today (placements produce equal-length arrays) and conservative, but worth aligning if `blockMass` ever becomes client-supplied.

**Verdict: APPROVE.** Follow-ups #4, #5, #6 are genuinely and completely fixed at `0c738bc`; gates reproduce; RED tests discriminate as claimed; no regressions found.

**Merge verdict: APPROVE.** Follow-ups 1, 4, and 5 are worth a tidy-up PR; 2, 3, 6 are recorded for the backlog.
