# SPIKE 002: Rust DP via Bun FFI

## Question

Given the same back-pointer DP recurrence compiled as a Rust cdylib, when called from Bun via `bun:ffi`, does it run materially faster with byte-identical results?

## Approach

Exact mirror of stowage's `vendor/knapsack/src/dp-soa.ts` (same windowing, tie-breaking strict->/first-writer, g0 seeding, traceback) in Rust (`src/lib.rs`), exported C ABI, called via `bun:ffi`. Differential: 400 randomized problems (mixed shapes, tie-heavy subsets) vs the live TS kernel. Head-to-head at 30k / 150k (shared budget regime), 200k (memory-freedom regime), 5k×200k (the wall regime). Run: `bun bench.ts` (build first: `cargo build --release`).

## Results

| Regime | TS | Rust | Ratio |
|---|---|---|---|
| Differential (400 problems) | — | — | **0 mismatches** (value, weight, choices all byte-identical) |
| 30k shared regime | 9.2 ms | 6.6 ms | 1.4× |
| 150k budget edge | 12 ms | 9 ms | 1.3× |
| Tie-heavy 200k | 53 ms (D&C) | 6 ms (bp, 60 MB) | **9.6×** |
| Wall: 5k groups × 200k | 2.4 s (D&C) | 0.8 s (bp, **1 GB table**) | **3.1×** |

Key mechanics:
- Over-budget guard mirrors TS (returns −1 above budget; verified).
- `solve_dp_unbounded` lifts the 50 MiB cap — the regime TS structurally cannot reach without divide-and-conquer's 2× time.
- FFI overhead negligible (typed-array pointers pass through; no copies).
- Two real bugs found by the differential itself: my g0 seeding missed the back-pointer write (choices[0] garbage), and the harness mistranslated rc=−2. Both fixed; 0/400 after.

Honest caveats:
- The 1 GB table at the wall is a *spike instrument* — production design would port Hirschberg D&C into Rust too (O(C) memory), or cap the budget-free mode.
- The TS 42 s / 1.68 s walls were tie-heavy window-filling geometry; heterogeneous 200k D&C is only ~63 ms — geometry, not just capacity, gates the pain. My "1M" generator line was degenerate-narrow (labeled honestly in the bench output).
- Platform: dylib built for macOS arm64. CI (linux x64) needs a second build target.

## Verdict: VALIDATED

### What worked
- Byte-identical results across 400 randomized problems — FFI correctness is achievable and differentially provable.
- Material wins exactly where the measured walls live: 3–10× in the over-budget regimes.

### What didn't
- The shared-budget regime (≤50 MiB) only gains 1.3–1.4× — JSC's typed-array DP is genuinely good; Rust is not a blanket speedup.

### Surprises
- Memory freedom beats kernel speed: most of the 9.6× at tie-heavy 200k comes from skipping D&C entirely, not from Rust's inner loop.
- The differential harness caught a real seeding bug the eyeball missed — the oracle pattern pays for itself.

### Recommendation for the real build
- Land the kernel in the `knapsack` repo (sibling, not the stowage vendored copy), TS kernel stays as reference + differential oracle in CI.
- Production entry point: budget-free mode only above the 50 MiB TS budget (small cases stay TS — no FFI dependency on the common path), OR full Rust with Hirschberg port for O(C) memory at scale.
- CI: add linux x64 cdylib build; consider prebuilt artifacts to keep CI at ~13–16 s.
- Bun FFI verdict: dlopen/symbols works, typed-array ptr passing works, no struct-by-value (use out-buffers).
