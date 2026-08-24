# ADR-0002 — solver port and the kernel boundary

- Status: accepted (owner ruling 2026-08-23: "Do the code move, add the adr,
  implement it. We'll decide on the license later")
- Date: 2026-08-23
- Supersedes: nothing — operationalizes ADR-0000's boundary at today's code.

## Context

The solver and its pricing machinery (ex-agent-kernel `src/optimizer/`)
are generic to any harness that pays provider cache bills. The kernel
keeps the option surface, substrates, store, loop, and journaling; the
solve moves here.

## Decision

1. **Moved modules (byte-identical bodies, import heads unchanged —
   same-directory references):** `solver.ts`, `suffix.ts`, `horizon.ts`,
   `churn.ts`, `evidence.ts`, `cache-model.ts`, `params.ts`,
   `types.ts`. ~1,500 lines.
2. **Dependency edge:** stowage → `@connectotron/knapsack`
   (`file:vendor/knapsack`, the kernel's pin v0.1.1). knapsack stays
   pure integer MCKP; stowage never imports kernel code (acyclic).
3. **Kernel seam:** agent-kernel commits the stowage source tree at
   `vendor/stowage/` and its eight former modules become re-export
   shims over the relative source paths — all kernel import sites (16
   files, 871 tests at port time) unchanged. The kernel deliberately
   does **not** declare `@connectotron/stowage` as a package
   dependency: the vendored tree is the only loadable copy, so legacy
   shims and any package-root import cannot fork into two module
   graphs (review M1, PR #24).
4. **Contract:** the port is behavior-preserving. The kernel suite must
   stay green without editing a single kernel test — that is the
   acceptance test of the move.
5. **License:** deferred by owner ruling (package field `UNLICENSED`
   placeholder; decide before any external publication).

## Consequences

- Phase 3 (ADR-0001) now lands here: sequence model, move options,
  delta fragments as items, continuation-value DP, patch retirement.
- Dual vendoring (kernel → stowage → knapsack) is deliberate pin
  isolation; propagation is a ruled act, never opportunistic.
- The kernel deliberately omits a declared stowage package dependency:
  with the vendored tree as the only loadable copy, the dual-graph
  hazard (review M1) cannot arise. Re-vendoring is a copy operation;
  bun.lock is untouched by the seam.
- stowage's `bun test` also runs the vendored knapsack suite — a free
  upstream tripwire.
