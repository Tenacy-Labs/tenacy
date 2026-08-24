# SPIKE 003: SIMD (NEON) inner loop for the Rust DP

## Question

Can SIMD vectorization (the modern descendant of MMX) of the DP inner loop make the validated Rust FFI kernel even faster — with byte-identical results?

## Context

This M4 Max is ARM; "MMX" (1997 x86) does not exist here — the target is NEON/SIMD. The user-facing answer: yes, and the mechanism is loop *interchange* (option-outer, w-inner), not raw intrinsics.

## Approach

Three Rust variants of the same dp-soa recurrence in `src/lib.rs`:
- **A** — spike-002 scalar (w-outer, budget-guarded): the baseline.
- **B** — loop-interchange (option-outer, w-inner), scalar: makes the w-loop a contiguous `cur[w] = max(cur[w], prev[w-wi]+pi)` scan.
- **C** — same as B with `#[target_feature(enable = "neon")]` on the gather loop: LLVM auto-vectorizes the max+add scan.

Run: `cargo build --release && bun bench.ts`. Oracle: the live TS `solveDpSoa` kernel; 400-problem randomized differential (mixed shapes + tie-heavy).

## Results

| Shape | A scalar | B interchange | C NEON | C vs A | C vs TS |
|---|---|---|---|---|---|
| 30k typical | 6.6 ms | 5.2 ms | **3.2 ms** | 2.1x | **4.2x** |
| 200k tie-heavy | refuses (rc −1) | 6.2 ms | **4.4 ms** | 1.4x | 4.4x vs 53 ms D&C |
| Wall: 5k×200k | refuses | 945 ms | **585 ms** | 1.6x | 6.9x vs 2.4 s D&C |

Differential: **0/0/0 mismatches** across 400 problems (value, weight, choices byte-identical to the TS oracle).

Kernels agree cross-shape where they overlap (30k).

**TS comparison note:** at 30k TS was 9.2 ms; NEON Rust 3.2 ms = **4.2× over TypeScript**. At the wall, TS D&C 2.4 s → NEON 585 ms = **6.9×**.

**Where the gain actually comes from** (honest attribution): the interchange alone is worth 1.3–1.5× (6.6→5.2 ms; 945 ms vs A unavailable — A cannot run there); NEON adds another 1.4–1.6× on top (5.2→3.2 ms). The 50 MiB budget-skip (B/C unbounded) is separate and unchanged from spike 002.

## Verdict: VALIDATED

### What worked
- Loop interchange → contiguous max-plus scan → auto-vectorization without intrinsics: 2.1× over spike-002 Rust, **4.2× over TypeScript** at typical shapes, 6.9× at the wall.
- The 400-problem differential against the live TS oracle — caught a real sentinel bug (below) the day it was written.

### What didn't
- First attempt used SENT = −1; unreachable prev cells produced `v = −1+pi ≥ 0` — bogus profit from unreachable states (inflated value 139054 vs 138035 + traceback panic). Fixed: `i32::MIN` sentinel. The differential caught it immediately.

### Surprises
- MMX era is over; auto-vectorization of interchanged loops is the modern form — no hand intrinsics needed.
- The sentineled-scan shape is subtle enough that the scalar reference and the SIMD variant shared the same bug — until the oracle disagreed.

## Recommendation for the real build
- Production form: variant C's approach in the `knapsack` repo — interchanged, auto-vectorized, i32::MIN sentinel, byte-identical via differential in CI. TS stays the oracle.
- Production memory form at the wall: Hirschberg D&C port (O(capacity) memory) — the 1 GB bp table was a spike instrument, not a design.
- stowage README (docs/spikes section) updated to record spike 003's numbers.
