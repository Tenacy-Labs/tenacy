# Prebuilt native dylibs — provenance

Each `prebuilt/{triple}{ext}` (ext per platform: `.dylib`/`.so`/`.dll`)
source (`src/lib.rs`, `Cargo.toml`, `Cargo.lock`) with no external
dependencies. Rebuild recipe (verified on this host; the CI path is the
`ship-native` workflow, which builds all five triples on Actions
runners and emits SHA256SUMS):

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
| aarch64-apple-darwin | 349840 | 619d097cd6049964373dbce9e4799f8f8fd44b664f36466c1349364e31f26f1b | rustc 1.95.0 (local; pin retained — CI build size-identical, not bit-identical: Mach-O UUIDs, embedded build paths, code layout) |
| aarch64-unknown-linux-gnu | 356648 | ed995175a60dfe8d9a7beeeb9184a417fbfeef80140336c0519e84966a56a46a | rustc 1.95.0, cross: ubuntu-latest + gcc-aarch64-linux-gnu |
| x86_64-apple-darwin | 337816 | a501c5bf6d0558773b3244b951206a08a15d2451f95f40ad95d94582ebe63ebf | rustc 1.95.0, cross: macos-15 runner |
| x86_64-pc-windows-msvc | 102912 | ab748bf6a06a2d9d37aa6db6bffe1f16440d31aaf2d24aee0896438b741844f9 | rustc 1.95.0, native: windows-latest MSVC |
| x86_64-unknown-linux-gnu | 343064 | 29d224b715d8e7b0fc1a7ce254509e7d0b5277bf4c99dde07ba1096df36ab887 | rustc 1.95.0, native: ubuntu-latest runner |

## Verification

- Loader `src/native.ts` dlopens `prebuilt/{triple}{ext}` matching the
  host triple (`.dylib` darwin, `.so` linux, `.dll` windows — see
  `tripleFor`), `KNAPSACK_NATIVE_DYLIB` env override for testing.
- Correctness: 500-problem differential vs `solveDpSoa` (value, weight,
  choices, cellsVisited) wherever a dylib is present; ran>0 guard.
- rc conventions: 0 ok; −1 over budget; −2 infeasible; −3 invalid input
  (negative counts/capacity, negative weights/profits, bad group_start);
  −4 contained panic (catch_unwind at the FFI edge).
