# Code Review — PR #4: native SIMD DP kernel (`dpKernel: "native"`) with TS fallback

- **PR:** perf/native-simd @ 667dd52 → main (+589/−4, 9 files)
- **Reviewer method:** fresh-context read of `native/src/lib.rs`, `src/native.ts`, `src/solve.ts`, `src/dp-soa.ts`, `src/dp.ts`, `src/validate.ts`, both test files; live execution of both native test files and full suites on this aarch64 host (dylib present); adversarial probes (profit-corruption sensitivity, infeasible rc −2, single-group, capacity 0, huge-weight inputs); `bun x --bun tsc --noEmit`; git hygiene inspection.
- **Verified locally:** stowage `bun test` 662/662 pass; vendor `bun test` 634/634 pass; 500-problem differential ran 500/500 with **0 mismatches** on BOTH test files (value, weight, choiceIndex, cellsVisited); root `tsc --noEmit` exit 0.

## Verdict: **REQUEST CHANGES**

One critical memory-safety defect reachable from validated public input. Everything else in the PR is solid — the fallback contract, dispatch, and differential harness are genuinely well built. Fix the loader/kernel input-range hole and document dylib provenance; the rest is minor.

---

## Critical

### C1. Validation-passing weights ≥ 2³¹ abort the process (and can corrupt memory) on dylib hosts

`validateProblem` bounds capacity (≤ 2²¹−1) and ΣmaxProfit (< 2³¹) but does **not** bound individual option weights — only the envelope ΣmaxProfit·maxWeight < 2⁵³. A weight of e.g. `2³¹+100` with small profits passes validation. `solveDpNative` flattens weights into an `Int32Array`, where it truncates to a **negative** i32. In `lib.rs`:

- **g0 seeding (line 115):** `if w <= cap as i32 && flat_p[i] > prev[w as usize]` — a negative `w` passes `w <= cap`, then `prev[w as usize]` sign-extends to ~1.8e19 → Vec bounds-check panic. With `panic = "abort"` (Cargo.toml) inside a cdylib, this is a **process abort**, not a catchable error.
- **gather path (lines 129–141):** a negative `wi` is not filtered by `if wi > hi`, and `gather_max` uses raw pointers with no bounds checks (`*cur.add(w)`, `*prev.add(w - sh)`, `*bp.add(bp_base + w)`). For single-huge-weight groups the window arithmetic happens to collapse `w_start ≥ w_end` (empirically survived — see below), but with multiple huge-weight options in a group the wrapped `lo/hi` arithmetic can produce `w_start < w_end` at wrapped-usize magnitudes → genuine out-of-bounds reads **and writes**. I did not deliberately trigger the wild-write variant (refused to corrupt the host process); the panic alone establishes the class.

**Reproduced** (this host, via the public API — not by calling the kernel directly):

```ts
import { solve } from "vendor/knapsack/src/solve.ts";
const big = 2147483748; // 2^31 + 100; envelope: 2·(2^31+100) < 2^53 → validation PASSES
solve({
  groups: [
    { id: "g0", options: [{ id: "zero", weight: 0, profit: 0 }, { id: "huge", weight: big, profit: 2 }] },
    { id: "g1", options: [{ id: "a", weight: 30, profit: 1 }, { id: "b", weight: 60, profit: 1 }] },
  ],
  capacity: 100,
}, { dpKernel: "native" });
// → dpKernel "reference": status "optimal", value 1 (correct)
// → dpKernel "native":  thread panicked at src/lib.rs:115:47:
//    index out of bounds: the len is 101 but the index is 18446744071562068068
//    process exits rc −6 (SIGABRT)
```

Placing the huge weight in g1 instead of g0 *survives* and agrees with the reference — the behavior is input-placement-dependent (crash vs. silently-lucky), which is the signature of unchecked truncation. All TS kernels handle the same input gracefully (typed-array OOB reads yield `undefined` → `NaN` compares false → option effectively ignored).

**Fix (small, one place):** in `native.ts` `solveDpNative`, when flattening, reject any weight or profit outside a safe i32 range (weight not in `0..2³¹−1`, profit not in `0..2³¹−1`) → return `null` → existing chain falls back to `solveDpSoa`, which already handles these inputs. Belt-and-braces: in `lib.rs`, validate `flat_w`/`flat_p` values and `capacity ≥ 0` up front and return an error rc instead of trusting the FFI edge (also protects direct callers; note `capacity < 0` → `width` wraps → giant `vec!` allocation abort). Add a regression test: the repro above must equal the reference result, not die.

## Major

### M1. Committed prebuilt dylib has no documented provenance
`vendor/knapsack/native/prebuilt/aarch64-apple-darwin.dylib` (348 KB Mach-O arm64, exports `_knapsack_dp`) is committed with zero accompanying documentation: no build recipe, no rustc/cargo version or platform pin (no `rust-toolchain.toml`), no checksum, and no mention of `native/` or `prebuilt/` anywhere in `vendor/knapsack/README.md` (grep: zero hits). The loader supports four triples but only one dylib ships, and how to produce the others (or rebuild the shipped one from `lib.rs`) is undocumented. Spike READMEs under `docs/spikes/` contain a generic `cargo build --release`, not tied to this artifact. For a binary committed into the repo, provenance is a hygiene requirement (this review's scope E) and a supply-chain baseline. Add a short `native/README.md`: exact build command, toolchain version, release flags used, sha256 of the committed dylib, and the policy for adding new triples.

## Minor

1. **Vendor typecheck broken by the new test.** `cd vendor/knapsack && bun x --bun tsc --noEmit` fails: `test/native.test.ts(39,17): TS2345 — Property 'originalCount' is missing in type '...ReducedGroup'` (the generator omits `originalCount`; the stowage-side twin includes it). Root `tsc` and CI are unaffected (root tsconfig includes only root `src`/`test`), but the vendor package's own `bun run typecheck` script now fails. One-line fix: add `originalCount: options.length` in the vendor generator.
2. **Kernel ignores caller's `maxDpBytes`.** `solveDpNative(reduced, capacity, maxDpBytes)` accepts a budget but the Rust gate hardcodes `DEFAULT_DP_BUDGET` (50 MiB). With `solve(..., { dpKernel: "native", maxDpBytes: 100MiB })` a 60 MiB table passes the TS gate, gets rc −1 from the kernel, and silently falls back to SoA — correct but surprising. Pass the budget through (extra FFI arg) or document the 50 MiB native hard cap in `SolveOptions`.
3. **CI never exercises the native path.** CI is linux x86_64 with no dylib → the differential skips (honest: logs + `ran > 0` guard) and only the fallback contract is tested. Acceptable trade-off, but it means kernel regressions are caught only on dev Macs. Worth a line in the PR description acknowledging this coverage gap (or a macos CI job later).
4. **`countCells` is a simulation, not a measurement.** `cellsVisited` for native results is recomputed by re-deriving the SoA window arithmetic rather than counting actual kernel work. It's documented as such in `native.ts` and keeps stats comparable — fine — but a one-word comment on the returned field ("mirror of soa's counter, not kernel work") would prevent future misreading.
5. **`DEFAULT_DP_BUDGET` now lives in three places** (dp.ts, lib.rs, native.ts import). Each carries a "keep in sync" comment; acceptable at this size, just noting the triplication.
6. **`panic = "abort"` in the cdylib profile** converts any future in-kernel panic into a host-process abort with no recovery. Once C1's in-kernel validation lands this becomes defensive posture rather than a live risk; consider `panic = "unwind"` + a `catch_unwind` at the FFI edge returning an error rc so a kernel bug can never take down the host.

---

## What was verified and found correct

- **Kernel ↔ oracle equivalence (validated-input domain):** recurrence, windowing (`lo/hi` formulas, `window_lo += g_min`, `window_hi = hi`), g0 seeding (min/max from data, first-writer-wins in option order), tie-break identity (option-outer gather with strict `>` ≡ oracle's per-cell argmax with strict `>` over options in index order — first max wins in both), `i32::MIN` sentinel semantics (phantom values provably stay < 0 given ΣmaxProfit < 2³¹, so they can never win the final scan; `SENT + pi` cannot overflow for validated profits), traceback (`bp` u8 indices, `≤ 255` options enforced by validation and preserved by reduction), infeasible rc −2 → `{value:-1, weight:-1, choiceIndex:[]}` ≡ oracle. 500/500 differential clean on both test files, including tie-heavy seeds.
- **Differential is non-vacuous:** adversarial probe — bumping one chosen option's profit on the native input only — produced an immediate mismatch catch (56590 vs 56611). The harness can fail; it isn't structurally incapable of failing. `ran > 0` guard present in both differentials.
- **Loader (`native.ts`):** dlopen fully contained in try/catch → `null`; env override (`KNAPSACK_NATIVE_DYLIB`) honored with empty-string treated as unset; cache (`cached` set to `null` *before* the attempt, so a throw can't leave `undefined` looping) and `_resetNativeCache` correct; corrupt-path test restores env and cache in `finally`.
- **Dispatch (`solve.ts`):** bounded-mode-over-budget branch keeps precedence; native under budget → null → SoA under budget → reference/D&C; default options (`dpKernel` absent/`"reference"`) behaviorally unchanged (diff is purely additive around the dispatch); `n === 0` guard protects direct callers.
- **Test honesty (D):** fallback tests are dylib-independent (forced-absent via env); asserts use the real `KnapsackResult` shape (`status`/`value`/`choices[].optionId` — no phantom `.weight` field).
- **Hygiene:** no `target/` tracked (`.gitignore` gains `vendor/knapsack/native/target/`; the stray working-tree `target/` is untracked and ignored); `Cargo.lock` committed (zero-dep crate); working tree clean at 667dd52; `node_modules/@connectotron/knapsack` byte-identical to `vendor/` for all touched files; dylib is Mach-O arm64 exporting `_knapsack_dp`.

## Required before merge

1. C1: i32-range guard in `solveDpNative` (fallback on out-of-range weight/profit) + in-kernel input validation returning an error rc + regression test with the 2³¹-weight repro.
2. M1: `native/README.md` with dylib build recipe, toolchain pin, and checksum.

Recommended (non-blocking): minors 1, 2, 6.

## Round 2 resolution (author, 2026-08-24)

**C1 (critical) — fixed at the root, beyond the reviewer's suggested shape.**
Reviewer reproduced: out-of-i32 weight (2^31+100) passes validateProblem,
truncates negative in the Int32Array flatten, SIGABRTs via panic=abort
(g0 placement) or corrupts silently (g1). Suggested fix (native guard ->
null -> soa fallback) turned out to be INSUFFICIENT on live probe: SoA
itself truncates the same input class (Int32Array flatW/groupMax, dp-soa.ts
lines 33-60) and returns value:-1 "infeasible" where reference D&C returns
5. Root fix: exact scale filter in solve.ts before the DP — options with
weight > capacity are dropped (provably never in a feasible selection;
capacity validated <= 2^21-1, so survivors fit i32; profits already bounded
< 2^31 by MAX_TOTAL_PROFIT). All three kernels now agree on the C1 shapes:
ref 5 = soa 5 = native 5, ids match; 300-problem junk-option sweep 0
mismatches. Defense in depth retained: in-kernel validation (rc -3:
negative n/capacity/weights/profits, non-monotone group_start) + panic
containment (unwind + catch_unwind at the FFI edge, rc -4) + rebuilt
prebuilt dylib (349840 B). Discrimination proof: old dylib vs g0 input
SIGABRTs (exit -6, "index out of bounds" at lib.rs:115); new dylib returns
rc -3. Regression tests in BOTH suites: C1 g1-placement and g0-placement
(reference-vs-native identity).

**M1 — fixed.** native/prebuilt/PROVENANCE.md: rebuild recipe, toolchain
(rustc 1.95.0), sha256 checksum (619d097cd604...f26f1b), rc conventions,
RUSTFLAGS policy.

**Minors:** vendor tsc originalCount fixed (both generators); kernel
50 MiB backstop documented in lib.rs (TS loader enforces caller budget;
C ABI carries no byte param — the triplicated constant is now 3 documented
sights, not silent drift); countCells parity note stands as documented.
CI-native-path and x86_64 prebuilt remain follow-ups (unchanged).


---

## Round 3 — fresh-context verification gate (reviewer, 2026-08-24, HEAD dcc8262)

Scope: `git diff 667dd52..dcc8262` (9 files, +316/−4). Method: fresh read of the
round-2 code (solve.ts scale filter, lib.rs wrapper + validation, native.ts,
PROVENANCE.md, both test files, plus validate.ts/dominance.ts/lp.ts/fathom.ts/
dp-soa.ts for the invariants the filter depends on); live gates; independent
adversarial probes (three-kernel C1 agreement, own 300-problem junk sweep,
filter-revert discrimination in /tmp copies, old-vs-new dylib ABI probes in
isolated children, catch_unwind containment, infeasible-path reachability,
bit-for-bit rebuild). No production code modified; nothing committed; tree
verified clean at HEAD dcc8262 after probing (only this file changed).

## Verdict: **APPROVE**

### A. Three-kernel agreement on C1 shapes — VERIFIED

Independent probe (not the suite's code): weight 2^31+100 at BOTH placements,
capacity 10. reference = soa = native: status "optimal", value 5, identical
choice ids (`g0:b, g1:b`) for both placements. dylib present
(nativeAvailable true). Matches the author's claim exactly.

### B. 300-problem junk sweep — VERIFIED (own generator, not the author's)

Own xorshift generator (seed 0xC0FFEE + i·7919, different construction from
the suite's): 300 problems, 2–9 groups, cap 20–419, junk options (weight
2^31+1..2^31+5000) seeded at 12.0% (579/4820 options). All three kernels
compared on status, value, and full choice id lists: **0 mismatches**,
300/300 ran, 5 problems legitimately infeasible (min-weight sum > capacity,
all three kernels agreed "infeasible" on those).

### C. Scale filter exactness and index consistency — VERIFIED

- **Exactness argument holds**: exactly one option per group, total weight ≤
  capacity ⇒ no selection can contain an option with weight > capacity;
  dropping them cannot change the optimum. Survivors have weight ≤ capacity ≤
  2^21−1 < 2^31 (MAX_CAPACITY) → i32-safe. Profits < 2^31 individually
  (validateProblem bounds Σ per-group max profits < 2^31). The silent-
  truncation class is closed for BOTH SoA's Int32Array flatten and the FFI
  flatten, at the single correct layer.
- **Placement correct**: applied to `dpGroups` after the fathom mapping and
  before kernel dispatch/bounded-mode (soa/native/reference all see filtered
  groups; bounded mode's greedyWalk also runs on filtered groups).
- **Index consistency**: filtered arrays are new objects but reassigned to
  `dpGroups` before dispatch; `extractChoices(dpGroups, dp.choiceIndex)` at
  line 221 receives the same arrays the DP saw; choiceIndex indexes the
  filtered arrays' options. Verified behaviorally by A/B (identical ids).
- **The `keep.length === 0 ? … : g` fallback is unreachable** (adversarial
  trace + empirical): Pareto groups are weight-sorted so `options[0]` is the
  group min; the `minWeightSum > capacity` early return guarantees each
  group's `options[0].weight ≤ capacity`; convexHull preserves `pts[0]`;
  fathom always keeps the incumbent option, whose per-group weight is ≤ the
  walk total ≤ capacity. So every group retains ≥1 in-capacity option and the
  filter can never empty one (defensive branch only, mirroring the fathom
  guard's style). Tight-feasible probe (minWeightSum == capacity, junk
  present) stays optimal/5 on all three kernels — the filter cannot flip
  feasibility.

### D. Discrimination — VERIFIED, with the honest nuance recorded

Committed dylib sha256 = size = PROVENANCE.md row
(`619d097c…f26f1b`, 349840 B) ✓. Full 2×2 matrix, all cells run empirically
(reverted filter tested in a /tmp copy of the vendor tree — repo untouched —
verified byte-identical to HEAD except the filter hunk):

| state | g1-placement test | g0-placement test |
|---|---|---|
| committed (filter + new dylib) | PASS (5/5) | PASS (5/5) |
| filter reverted, NEW dylib | **FAILS** — native returns value −1, choices [] vs ref 5 | passes (rc −3 → SoA fallback; SoA's g0 window uses untruncated JS numbers → correct 5 by luck) |
| filter PRESENT, OLD dylib (667dd52) | PASS (filter removes junk pre-kernel → 5) | PASS (same) |
| filter reverted, OLD dylib | passes (g1 silently-lucky — the round-1 finding) | **SIGABRT**: child exits −6, "index out of bounds: len 11, index 18446744071562068068" at lib.rs:115 |

Conclusion: the suite is non-vacuous — reverting the root fix turns the
g1 test red (value/choices assertions violated), and the pre-fix world
(filter absent + old dylib) kills the process on the g0 shape. Honest nuance,
not a blocker: neither test alone discriminates every single-component
regression (g0 survives filter-revert via the SoA-lucky path; both survive
old-dylib-with-filter). The pair as a whole catches the real-world reverts.

Old-dylib SIGABRT vs new-dylib rc −3 on the raw truncated-negative-weight
input: verified via direct `bun:ffi` ABI calls in isolated children (old:
exit −6 at lib.rs:115; new: clean rc −3). ✓

### E. Differential honesty — VERIFIED

Both differentials ran 500/500 problems, 0 mismatches, `expect(ran) > 0`
guard present and satisfied (dylib present on this host). Forced-absent runs
(`KNAPSACK_NATIVE_DYLIB=/nonexistent/...`, whole test files in isolation):
5/5 pass on BOTH trees, differentials log the honest skip message and the
fallback/C1 tests pass on the pure-TS path. ✓

### F. Gates — ALL GREEN (run this round, this host)

- vendor suite: **636/636** pass (0 fail, 6323 expects)
- stowage suite: **666/666** pass (0 fail, 9259 expects)
- `bun x --bun tsc --noEmit`: exit 0 in BOTH trees (the round-1 vendor tsc
  break from the missing `originalCount` is fixed)

### G. Hygiene — CLEAN

Diff contains exactly the 9 expected files; no build artifacts (`target/`
gitignored, untracked); `Cargo.lock` byte-unchanged in range (zero-dep
crate, consistent with Cargo.toml whose only change is the panic-strategy
comment/removal); no stray files beyond this review doc (expected).
PROVENANCE.md is accurate — see the rebuild check below.

### H. Kernel wrapper correctness — VERIFIED, one best-effort note

- `catch_unwind(AssertUnwindSafe(...))` + `unwrap_or(-4)` at the FFI edge;
  `panic = "abort"` removed; **containment empirically proven**: a
  deterministic in-kernel panic path (n_groups=0 with length-1 group_start →
  gs[1] slice index at the g0-seed read) returns rc −4 cleanly on the new
  dylib where the old dylib SIGABRTs (exit −6). Unreachable from TS (loader
  guards `n === 0`), reachable only by direct C misuse — exactly what
  belt-and-braces is for. Panic payloads print to stderr (noise, not a leak);
  Rust unwinding runs destructors, so no allocation leak into the rc path
  beyond inherent panic semantics. Best-effort acceptable.
- Validation ordering: n_groups/capacity ≥ 0 checked before any deref;
  `gs[0] != 0`, monotone `gs[1..=n]`, non-negative weights/profits all
  checked after slice construction and BEFORE any DP allocation or gather
  arithmetic. Slices are built from caller-declared lengths (`gs[n]`) — the
  standard C-ABI trust boundary, unchanged from round 1; within that
  contract all validation reads are in-bounds.
- Direct ABI probes on the new dylib: rc 0 + correct value 5/choices on a
  valid problem; rc −3 on negative n, negative capacity, gs[0]≠0,
  non-monotone gs, negative weight, negative profit, and the C1
  truncated-negative weight; rc −1 over budget; rc −2 infeasible. All
  conventions match PROVENANCE.md. ✓
- Capacity upper bound in-kernel correctly absent (TS budget gate is the
  enforcement point; `capacity < 0` rc −3 is the ABI-level defense).

### H2. Infeasibility semantics — UNCHANGED, REACHABLE WHERE IT MATTERS

- solve-level: min-weight sum > capacity (with junk options mixed in) → all
  three kernels return the infeasible shape (`status "infeasible"`, value 0,
  choices null) via the pre-DP early return, exactly as pre-PR.
- kernel-level: genuinely infeasible DP input (min-weight sum > capacity,
  all weights ≤ cap) still hits `bestVal < 0`: solveDpSoa/solveDp return
  `{value: −1, weight: −1, choiceIndex: []}` and solveDpNative maps rc −2 to
  the identical shape. The `: g`/filter cannot make a feasible problem
  infeasible (incumbent and each group's `options[0]` always survive), so
  solve() reaching the DP with infeasible groups remains as unreachable as
  it was pre-PR (the early return catches it first) — behavior preserved.

### Rebuild reproducibility (bonus check)

PROVENANCE.md's recipe executed verbatim in-repo (`cargo build --release`,
rustc/cargo 1.95.0 — matches the pin): the rebuilt dylib is **bit-for-bit
identical** to the committed artifact (sha256 `619d097c…f26f1b`). A /tmp-path
build differs only in embedded DWARF paths/code-signature (size-identical,
same export `_knapsack_dp`) — the recipe's in-place requirement is inherent
to reproducibility here, worth a one-line note in PROVENANCE.md someday but
the doc's `cd vendor/knapsack/native` already implies it. Tracked tree stayed
clean throughout (target/ ignored).

### Non-blocking observations

1. **Stale `node_modules/@connectotron/knapsack` copy in this workspace**
   (pre-round-2 solve.ts + old dylib). Not a repo defect: node_modules is
   gitignored and synced by `bun install`; all tests import the vendor path
   directly. No live risk either: the only app consumer
   (src/solver.ts:712) calls `solveMckp(..., { reliefMode: "bounded" })`
   with default dpKernel "reference" — it never loads a dylib. A `bun
   install` on merge syncs the copy.
2. `stats.optionsAfterFathoming` now also reflects the scale filter (name
   slightly understates what it counts). Cosmetic.
3. The C1 regression tests' first comment still says "The TS i32 guard must
   reject -> null -> soa fallback" — describes the round-1 fix shape that
   was replaced by the root filter; the assertions themselves are
   fix-agnostic (reference-vs-native identity). Cosmetic.
4. g0-test discrimination nuance recorded under D — if future edits make
   SoA's g0 window truncation-prone, that test could pass vacuously again;
   the g1 test is the load-bearing one for the filter.

### Round-2 claims vs reality

Every author claim (A–H2) reproduced or verified against the tree; no
overstatement found. Round-1 C1 is closed at the correct layer with defense
in depth behind it; M1 provenance is complete and accurate (including the
checksum); the round-1 vendor-tsc minor is fixed; the panic=abort minor (6)
is resolved by the unwind+catch_unwind design.

**Final: APPROVE.**
