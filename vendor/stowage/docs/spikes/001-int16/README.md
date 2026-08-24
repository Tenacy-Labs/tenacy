# SPIKE 001: int16 representation for the MCKP DP

## Question

Given the relief DP's cell values (prev/cur arrays, option weights/profits), when represented as Int16Array instead of Int32Array, then memory halves and the inner loop speeds up — without silent overflow?

## Approach

Arithmetic probe at the live call site's scale (stowage src/solver.ts:644 `SCALE = 1000`, `keepP = round((utility + strand) * 1000)`), plus a rigged-best-case DP differential (300 groups, cap 30k, profits ≤ 990) with overflow instrumentation.

## Results

| Probe | Result |
|---|---|
| Single-option profit (utility 50 × 1000) | 50,000 — **overflows int16** (32,767); fits uint16 only |
| Accumulated value, 10k items mean util 10 | 100,000,000 — int16 catastrophically wrong; int32 fine |
| Accumulated worst case (10k × util 50) | 500,000,000 — int32 fine (reviewer's overflow flag is about *i32* at ~4× margin) |
| Capacity 900k / 200k-token lens option | exceeds int16 entirely — table *indices* don't fit |
| Rigged valid regime DP (profits ≤ 990) | **6,310,083 overflows, wrong value (32,736 vs 153,450)** |
| Speed in valid regime | Int16 **slower**: 48.3ms vs 28.8ms Int32 — element width doesn't gate the JIT loop |
| Memory | Value arrays halve (234KB → 117KB at cap 30k) but the Uint8Array back-pointer table (9MB) dominates DP memory — total saving ~2% |

## Verdict: INVALIDATED

### What worked
- The probe design: static arithmetic + instrumented differential answered in one run.

### What didn't
- int16 cannot hold per-option profits at the live call site (utility ≥ 32.767 overflows), cannot hold accumulated values at any real window, and cannot index capacities past 32k.
- Even rigged best-case: silent wrong answers, and no speed win (slower, in fact).

### Surprises
- Int16 was *slower* than Int32 in the JIT — halving element width buys nothing in the gather loop.

### Recommendation for the real build
- Do not pursue int16 anywhere in this DP. Int32 is the correctness floor at SCALE=1000; if int32 accumulation ever becomes a risk (reviewer's note: ~500M worst case vs 2.1B ceiling), the fix is i64/u64 accumulation *in the kernel*, not narrower cells.
- The real speed lever is the kernel itself (SoA, or native code — see spike 002).
