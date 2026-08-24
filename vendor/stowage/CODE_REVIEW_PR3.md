# CODE REVIEW — PR #3 (perf/relief-dp)

Reviewer: fresh-context verification subagent, 2026-08-24. Branch `perf/relief-dp` @ 17f5477, base main @ 28d0e1e. Production code untouched; all dynamic probes run on an instrumented copy in /tmp.

## Verdict: REQUEST CHANGES

Gates pass and the SoA kernel is correct, but the relief-quantum test is vacuous (never exercises `exactMckpRelief`), the PR's "~20ms realistic relief" claim does not survive a probe where relief actually fires (~37s), the "documented in bench/relief-dp.ts" 42s note does not exist in the committed file, and the dispatcher fails to forward `maxDpBytes` to the SoA kernel (reproduced throw on the opt-in path).

---

## Gates (reproduced)

- `tsc --noEmit`: **exit 0** (`bun ./node_modules/typescript/bin/tsc --noEmit` and `bunx --bun tsc --noEmit`). Note: plain `bunx tsc` crashes on this host with a node/libuv dyld error (`Library not loaded: libuv.1.dylib` from Homebrew node 26) — environmental, not a type error; same command via bun's runtime is clean.
- `bun test`: **654 pass / 0 fail, 9,201 expect() calls, 8 files** (66ms). Matches PR claims exactly.

## (1) dp-soa.ts vs dp.ts solveDpBackpointer — line-level equivalence: PASS

Side-by-side of `vendor/knapsack/src/dp-soa.ts:23-113` vs `solveDpBackpointer` in `vendor/knapsack/src/dp.ts`:

- **Recurrence**: identical — `pw = w − weight; if (pw<0) continue; pv = prev[pw]; if (pv<0) continue; v = pv + profit; if (v > best)` with strict `>`.
- **Tie-breaking**: equivalent. Reference: first writer wins (strict `>`, options scanned in array order → lowest index kept). SoA (dp-soa.ts:84-91): options scanned in the same order via flat arrays, strict `>`, `bestOpt = i - s0` — the earlier (lower) flat index wins ties, which is the same lowest-option-index choiceIndex as reference. Verified empirically: my all-ties adversarial case and the committed tied-profits geometry produce identical choiceIndex.
- **Windowing**: identical math — dp-soa.ts:77-78 `lo = min(cap, windowLo+gMin)`, `hi = min(cap, windowHi+gMax)`; dp-soa.ts:95 `windowLo += gMin; windowHi = hi` — same as reference. `cur.fill(-1)` full clear both. gMin/gMax precomputed in phase 0 (dp-soa.ts:35-44) with the same int-initialized min/max scan; g0 seeding (dp-soa.ts:62-73) is token-identical in behavior to dp.ts's stage 0 (int-init min/max, `weight <= capacity` guard, strict-`>` first-writer, row-0 bp dual use).
- **Traceback**: identical — `bp[gi*width + w]`, walk gi=n−1..1, `w -= options[optIdx].weight`, `choiceIndex[0] = bp[w]` (dp-soa.ts:106-111). Final-row scan ties→smallest weight, same.
- **Budget guard**: dp-soa.ts:29-31 throws above `maxDpBytes` (default 50 MiB).

**BUT the task's premise "guard cannot be reached from solve.ts" is FALSE.** solve.ts:144 checks `expectedDpBytes(dpGroups.length, capacity) <= (options.maxDpBytes ?? DEFAULT_DP_BUDGET)` but line 145 calls `solveDpSoa(dpGroups, problem.capacity)` **without forwarding `options.maxDpBytes`**, so SoA's internal 50 MiB default applies. **Reproduced**: `solve({300 groups, capacity 200_000}, {dpKernel:"soa", maxDpBytes:100MiB})` — expectedDpBytes = 61,600,308 ∈ (50 MiB, 100 MiB), DP required → **throws** `solveDpSoa: use dp.ts solveDp ... above the memory budget`, while the reference kernel with identical options returns optimal (value 543335). Only bites the opt-in path with a custom budget > 50 MiB; default path unaffected. One-line fix: pass the resolved budget through (or drop SoA's internal guard and rely on the dispatcher).

## (2) Differential test strength: ADEQUATE BUT WITH A GAP (not blocking — kernel independently verified)

`test/dp-soa.test.ts` (350 problems): randomized shape draws weights 1–40 with cap ≥ 50, so **the seed-guard branch `weight <= capacity` (dp-soa.ts:69) is never false** — options heavier than the capacity are untested; weights spanning the full cap only marginally (n ≤ 13, cumulative ≤ ~520 vs cap up to 500). Single-option groups ARE covered (`k = 1 + floor(rng()*4)`); zero-weight options ARE covered but only in the tied-profits test (evict w=0).

I extended the differential on a copy: 500 randomized problems with weights 0–79 vs caps 5–65 (includes over-cap weights, zero weights/profits) plus 6 hand-built shapes (opt-exceeds-cap, all-exceed-cap→infeasible, zero-weight-mid, single-option-groups, weight==cap, all-tied): **0 mismatches** on value, weight, and choiceIndex. The kernel is correct; the committed suite is just weaker than it looks.

## (3) solve.ts dispatch: PASS (default byte-identical; one bug on the opt-in path)

Exact conditional (solve.ts:144-146): `options.dpKernel === "soa" && expectedDpBytes(dpGroups.length, problem.capacity) <= (options.maxDpBytes ?? DEFAULT_DP_BUDGET) ? solveDpSoa(dpGroups, problem.capacity) : solveDp(dpGroups, problem.capacity, options.maxDpBytes ?? DEFAULT_DP_BUDGET)`. With `dpKernel` unset, `undefined === "soa"` is false and the reference `solveDp` call is argument-identical to main — default path unchanged. No production caller sets `dpKernel` (grep: only a comment in test/relief-quantum.test.ts:7). No import cycle: solve.ts → dp-soa.ts → dp.ts → types.ts only. The maxDpBytes forwarding bug above is the sole defect.

## (4) relief-quantum test: VACUOUS — BLOCKING

`test/relief-quantum.test.ts` claims to pin "full-window (1M budget, 10k items) relief" <2s. Instrumented run (counter spliced into `exactMckpRelief` and the `solveMckp` call on a /tmp copy): **reliefCalls = 0**. All 10k items are `lastTouchTurn: 0` solved at turn 12 → reference profile, utility ≈ −4.93 each (reservation 0.002×1000 = 2 + rot ~1.5+ vs decayed value ~1.07) → phase-1 re-entry margin < 0 → every item rejected before budget relief. `totalTokens = 0 ≤ 900k`, so `exactMckpRelief` never runs; `placements = []`. The <2s assertion times a solve that does no relief work; the determinism check compares two empty arrays. The test also has **no tombstone option at all** (only full/trim), so the "tombstone shape forces DP not LP-integral" question is moot — nothing reaches the vendor solver.

Counterfactual probes (same 10k/1M-window geometry, items fresh so relief fires):
- Homogeneous fresh (committed geometry, `lastTouchTurn: 12`): relief fires, **dpCells = 12,887,405,914, 36.2s**.
- Heterogeneous fresh (tokens 100–2000, 5 kinds, keep/trim/tombstone): relief fires, **dpCells = 7,649,665,551, 37.8s**.

So the wall is **not** confined to a "degenerate all-tied geometry" — genuinely over-budget fresh content at this scale hits it with heterogeneous data too. The only fast 10k case I could construct (mixed ages 0–12, 28.5ms) is fast precisely because phase-1 pruning keeps the window under budget — relief never fires there either.

## (5) Bench honesty: MISMATCH vs committed files — BLOCKING

- `bench/relief-dp.ts` is 36 lines: build/run helpers + four `run(...)` lines. It contains **no** mention of 42s, 15.2B cells, "degenerate", or quantization (grep over the repo: the only mentions are `test/relief-quantum.test.ts:5-7`, which *claim* it is "documented in bench/relief-dp.ts"). The PR body repeats "Quantization is the documented answer for the degenerate shape (bench/relief-dp.ts)" — that documentation does not exist in the committed file, and the /tmp/dpbench.ts lineage is not in the repo.
- The committed bench's own win-1M line (1000 items × 1000 tok, budget 1M) also never fires relief (instrumented: relief=0, mckp=0 — stale items rejected in phase 1); only win-4k/win-30k exercise the exact path (85k / 4.7M cells).
- Kernel speedup claim "1.20x on the tie-heavy 30k shape": I measure **1.13x** (interleaved medians, 15 reps, ref 4.25ms vs soa 3.76ms) — same ballpark, not materially overstated.

---

## Required changes

1. **Fix or delete `test/relief-quantum.test.ts`** — it must actually reach `exactMckpRelief` (fresh items or incumbent-rendered items so utility > 0 and totalTokens > budgetLambda). As written it validates nothing about relief. Note: an honest version of this test at 10k/900k will take ~37s, which exposes finding 2.
2. **Correct the PR description** — "realistic relief at 1M window ~20ms because LP+fathom pre-resolve" only holds when relief does not fire; when over-budget relief genuinely fires at 10k items, measured cost is 7.6–12.9B DP cells / 36–38s on heterogeneous fresh content, not just the "degenerate all-tied" shape. Quantization is not merely a standing answer for a corner case; it is load-bearing for any genuinely over-budget full window.
3. **Add the promised 42s/15.2B documentation** to `bench/relief-dp.ts` (or repoint the test comment) — currently the citation is a dangling reference.
4. **solve.ts:144-146**: forward `options.maxDpBytes` to `solveDpSoa` (reproduced throw: soa + maxDpBytes=100MiB + expectedDpBytes∈(50MiB,100MiB] + DP-required).

## Non-blocking notes

- Differential gap: add over-capacity option weights to the randomized generator (weights up to ~1.5× cap) to cover the seed-guard branch; single-option groups and zero-weight options are already covered.
- Pre-existing (out of scope, worth an issue): with a fully-populated incumbent, relief utilities can exceed the vendor's Int32 profit ceiling (`sum of per-group max profits ... got 132396507963` throws out of `solve()`).
- SoA kernel itself: correct on 350 committed + 500 extended randomized + 6 adversarial shapes; ~1.13x on the tie-heavy shape.

---

## Resolution (author, 2026-08-24, round 2)

All four required changes addressed; head now includes bounded relief mode (item 1 landed, not deferred):

1. **relief-quantum test rebuilt** — engagement PROVEN by temporary instrumentation: `[RELIEF-FIRED groups=220]` (small-scale exact path) and `[RELIEF-FIRED groups=10000]` (full-window, 10k items / 1.5M content vs 900k budget). Key geometry the vacuous version missed: at 150 tokens/item utility > 0 so relief engages; at 1000 tokens/item reservation pricing rejects items in phase 1 (your −4.93 arithmetic, confirmed). 60s test timeout — the solve IS the measurement (bun's 5s default killed it on CI mid-run).
2. **Claims corrected everywhere** — PR body rewritten; the "~20ms" number measured a solve where relief never engaged. The wall is yours: 7.6–12.9B cells / 36–38s on heterogeneous fresh content. Bounded mode is the landed answer (below).
3. **bench/relief-dp.ts header** now documents the measured walls (27.6ms/8.6M → 1.68s/611M → 41.98s/15.2B; your 37s heterogeneous counterfactual) and the landed bounded-mode answer.
4. **maxDpBytes forwarded** via `resolvedDpBudget` in solve.ts:144-148 — your reproduced throw is structurally impossible now (one budget resolves once, flows to both kernels).

**Item 1 landed: bounded relief mode.** Above the 50 MiB DP budget the vendor returns the certified integral greedy incumbent (`greedyWalk` terminal state — feasible by construction, every hull index a real option) with honest `[greedyLower, lpUpper]` Dantzig bounds, status `"bounded"` — never claiming optimal. Stowage's `exactMckpRelief` passes `reliefMode: "bounded"`; below the budget the branch never engages (byte-identical exact path). Measured: ~1.6s (M4 Max) / ~10s (CI runner) at 10k groups / 900k capacity vs 37–42s+ exact. Bounded-mode engagement probe-verified: `[BOUNDED-FIRED groups=10000 cap=900000]`. Deterministic end to end (integer arithmetic; no floats in decisions).

**Your non-blocking notes, taken:** differential gap (weights never exceeded capacity) — noted for the next test-strength pass; Int32 profit ceiling — filed for follow-up.

**Operational finding worth the ledger:** `node_modules/@connectotron/knapsack` is a COPY, not a symlink — vendor edits require `bun install` to propagate. This silently invalidated the review round's small-window probe AND an intermediate test run on my side (tests passed against stale code). Countermeasure: `bun install` after every vendor edit, diff-verified.

Gates: 655/655 (9,207 expects), tsc clean, CI green (run 32754857411).

---

## Round 2 verdict (reviewer)

Fresh-context re-verification @ `ef05fcf` (bounded-mode commits + docs). Production code untouched; all probes spliced into `node_modules` copies or untracked scratch files, then reverted byte-identically (`diff -r vendor/knapsack node_modules/@connectotron/knapsack` → IDENTICAL after cleanup; final `git status` clean).

### Gates (reproduced, pristine tree)

- `bun install` first (the copy-sync hazard, item E): **node_modules ≡ vendor** (`diff -r` clean).
- `bunx tsc --noEmit`: **exit 0**.
- `bun test`: **655 pass / 0 fail, 9,207 expect() calls, 8 files** (3.4s). Matches PR claims exactly.
- Staleness tripwire (E, bonus): a stale `node_modules` would silently drop `reliefMode:"bounded"` → exact path → the 10k test blows its 15s assertion. The test now catches the failure mode that bit both of us in round 1.

### Round-1 required changes: all four genuinely resolved

1. **relief test rebuilt — VERIFIED by my own independent probe** (counters spliced into the `node_modules` vendor `solve.ts` bounded branch + `src/solver.ts:712`, run, reverted): 220-group test → `[RELIEF-ENTER chosen=220]` → exact DP (`status=optimal`, 2,379,847 cells, 5.47MB table < 50MiB so bounded correctly does NOT engage); 10k test → `[BOUNDED-FIRED groups=10000 cap=900000]` → `status=bounded, value=greedyLower=28,924,300, lpUpper=28,925,887.32`, ~1.7s/solve on this host. The author's `[RELIEF-FIRED]`/`[BOUNDED-FIRED]` claims reproduce exactly. Both `exactMckpRelief` AND the bounded branch are genuinely reached.
2. **Claims corrected** — PR body and comments now carry the 37–42s / 7.6–15.2B-cell walls; no ~20ms claim survives anywhere I looked.
3. **bench/relief-dp.ts header accurate** — the measured walls (27.6ms/8.6M → 1.68s/611M → 41.98s/15.2B) match round-1's lineage including my own counterfactual numbers (85k / 4.7M cells for win-4k/win-30k), and the header honestly flags the win-1M run as a phase-1 fast path that does NOT fire relief. The "~1.6s bounded at 10k/900k" claim matches my measurement (~1.7s).
4. **maxDpBytes forwarding — VERIFIED** (`vendor/knapsack/src/solve.ts:154`): `resolvedDpBudget` resolves once and flows to all three consumers — the bounded gate (:163), the SoA dispatch (:181), and `solveDp` (:183). Round-1's repro re-run on the fixed code: `solve(problem, {dpKernel:"soa", maxDpBytes:100MiB})` with expectedDpBytes ∈ (50MiB, 100MiB] now returns `optimal 623997` == reference kernel, no throw.

### NEW REQUIRED finding R2-1: bounded-mode `lpUpper` does NOT bracket OPT

`solve.ts:170` reports `bounds.lpUpper = walk.break.upperBound` from `greedyWalk(dpGroups, …)` — the **fathomed Pareto sets** — but the Dantzig break bound is only valid on **convex hulls**, where segment densities are strictly decreasing (the library's own `dominance.ts` `convexHull` doc states the walk depends on this). On a non-convex set, a below-the-chord "dent" segment is consumed early, the break lands with small slack on a low-density segment, and the reported "upper bound" falls **below OPT**.

- **Clean-tree repro**: groups `A{(0,0),(60,30),(100,98)}`, `B{(0,0),(70,69)}`, capacity 100. Exact: `optimal 98` (hull `lpUpper` 98.4). Bounded: `lpUpper = 84 < OPT`; the certified interval `[69, 84]` excludes 98.
- **Property probes** (5,000 random instances each, vendor API, `maxDpBytes:1` to force the branch):
  - stowage's **exact relief option shape** (keep/evict/tombstone): **49 / 3,758** bounded instances violate bracketing (e.g. OPT 77,482 vs `lpUpper` 73,949.6).
  - dent-heavy 3-option groups: **2,042 / 5,000** violations.
- **Stowage does hit this shape**: `evict(0,0) / tomb(h,fv) / keep(w,u)` is non-convex whenever `fv·w < u·h` — a cheap tombstone under the keep chord.
- **Impact today**: contained — `solver.ts:717`'s `reliefGap` is the only consumer of `bounds` and is itself a dead local (computed, never read), so no user-visible corruption in this PR. But the vendor contract is false as shipped: `types.ts:56-60` ("value is within the reported interval of OPT") and `solve.ts:159-162` ("The Dantzig lpUpper brackets OPT from above") — and honest certification is this mode's entire reason to exist.
- **Fix (verified)**: `solve.ts:170` → `lpUpper: Math.max(lp.upperBound, walk.break.upperBound)` — the hull-based Dantzig bound is already computed at `solve.ts:78`. I patched exactly this line in `node_modules` and re-ran both property probes: **0 / 8,758 violations**. One line, no behavior change otherwise.

### Bounded-mode correctness: everything else CHECKS OUT

- **Incumbent feasible by construction**: `greedyWalk` starts at all-min weights (feasible; the min-weight infeasible case returned earlier at :80-95) and advances only when `weight + dw ≤ capacity`. Verified empirically — every probed bounded selection was feasible.
- **`value` == the returned selection's profit**: Pareto-reduced groups are strictly increasing in weight AND profit, so walk profit is monotone; the final state IS the best-seen state (`lowerBound`). Verified.
- **`extractChoices` index mapping correct**: `walk.state.indices` are positions in the array passed to `greedyWalk`; the bounded branch passes `dpGroups` to both `greedyWalk` (:164) and `extractChoices` (:165) — same-array consistency holds (unlike a hull/pareto mismatch).
- **Status honest**: the branch returns `"bounded"`, never `"optimal"` (:167); `dpRequired:false`, `dpCellsVisited:0`.
- **Cannot engage ≤ budget**: gate at :163 requires `expectedDpBytes > resolvedDpBudget`; the 220-group bounded-mode call ran the exact DP (5.47MB < 50MiB). Default (`reliefMode` undefined) can never enter the branch — byte-identical default path confirmed structurally and by the 220-group probe.

### Non-blocking notes

- `reliefGap` (solver.ts:717) is dead — either journal it (it was clearly meant for the ledger) or drop it; after R2-1's fix it would actually be meaningful.
- 15s threshold: ~1.4× headroom over the author's CI measurement (10.4s) is thin for pooled runners; consider 20s or a documented skip env var if it flakes. The 60s test timeout is honest (the solve IS the measurement).
- Round-1 non-blocking items (differential over-cap weights; Int32 profit ceiling) remain open by author agreement — fine.

### Verdict: REQUEST CHANGES

One required change: **R2-1** (`solve.ts:170`, one line, fix verified by this review). All four round-1 findings are genuinely and verifiably resolved; the bounded mode's incumbent, status, budget gate, and forwarding are correct — only the `lpUpper` bound semantics are broken, and the proven one-liner closes it.

---

## Round 3 verdict (reviewer)

Fresh-context gate verification @ `52a0fac` (branch `perf/relief-dp`, in sync with origin). Scope check first: `git diff --stat ef05fcf..52a0fac` shows exactly three files — `vendor/knapsack/src/solve.ts` (1 line), `test/bounded-brackets.test.ts` (new, +29), `CODE_REVIEW_PR3.md` (this ledger). No other changes. Working tree clean at start and end.

### 1. Fix present at head

`solve.ts:170` (bounded branch) reads:

```ts
bounds: { lpUpper: Math.max(lp.upperBound, walk.break.upperBound), greedyLower: walk.lowerBound },
```

Exactly the described one-line fix. The hull LP (`lp.upperBound`, computed at solve.ts:78) now dominates the walk's break bound, so `lpUpper` can no longer fall below OPT on non-convex fathomed sets.

### 2. Regression test is genuinely discriminating

`bun install` first (copy-sync hazard, per ledger item E): `diff -r vendor/knapsack node_modules/@connectotron/knapsack` → IDENTICAL.

- **With fix:** `bun test test/bounded-brackets.test.ts` → **1 pass, 0 fail** (16 expects). The test forces the bounded branch (`maxDpBytes: 5`), solves the same instance exactly (`{}` → status optimal), and asserts `lpUpper ≥ OPT − 1e-9` across 4 machine-searched non-convex cases.
- **Fix temporarily reverted** (python string-replace in BOTH `vendor/knapsack/src/solve.ts` and the `node_modules` copy): test → **0 pass, 1 fail** with exactly the predicted signature — `Expected: >= 55.999999999, Received: 55.666666666666664` (lpUpper 55.667 < OPT 56; Dantzig break bound below OPT on a non-convex set).
- **Fix restored:** string-replaced back; `git diff` and `git status --porcelain` both empty (byte-identical restore); `diff -r vendor node_modules` → IDENTICAL; test → **1 pass** again.

The test fails on the bug and passes on the fix — it is not decorative.

### 3. Full gates @ `52a0fac`

- `bunx tsc --noEmit` → **exit 0** (via `bun x --bun tsc`; plain `bunx` shells to a homebrew node with a broken libuv in this sandbox, not a repo issue).
- `bun test` → **656 pass / 0 fail, 9,223 expect() calls, 9 files** (3.78s). Matches PR claims exactly (was 655/9,207/8 at round 2; +1 test/+16 expects/+1 file = the new regression file).

### Verdict: APPROVE

R2-1 is genuinely fixed with a discriminating regression test; full gates green; diff scope since round 2 is exactly the fix + the test + this ledger. No outstanding findings. **Merge-ready.**
