# Prebuilt native dylibs — provenance

Each `prebuilt/{triple}.dylib` is built from this directory's committed
source (`src/lib.rs`, `Cargo.toml`, `Cargo.lock`) with no external
dependencies. Rebuild recipe (verified on this host):

```
cd vendor/knapsack/native
cargo build --release            # rustc 1.95.0, default target aarch64-apple-darwin
cp target/release/libknapsack_native.dylib prebuilt/aarch64-apple-darwin.dylib
```

RUSTFLAGS must not add target-features (max-compat policy: the baseline
ISA decides vector width — NEON on aarch64, SSE2 auto-vectorization on
x86_64 — never AVX assumptions).

## Current prebuilts

| triple | size | sha256 | built with |
|---|---|---|---|
| aarch64-apple-darwin | 349840 | 619d097cd6049964373dbce9e4799f8f8fd44b664f36466c1349364e31f26f1b | rustc 1.95.0, cargo 1.95.0, profile release (opt 3, lto, codegen-units 1, unwind) |

## Verification

- Loader `src/native.ts` dlopens `prebuilt/{triple}.dylib` matching the
  host triple, `KNAPSACK_NATIVE_DYLIB` env override for testing.
- Correctness: 500-problem differential vs `solveDpSoa` (value, weight,
  choices, cellsVisited) wherever a dylib is present; ran>0 guard.
- rc conventions: 0 ok; −1 over budget; −2 infeasible; −3 invalid input
  (negative counts/capacity, negative weights/profits, bad group_start);
  −4 contained panic (catch_unwind at the FFI edge).
