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
2. **Dependency edge:** stowage → `@tenacy-labs/knapsack`
   (`file:vendor/knapsack`, the kernel's pin v0.1.1). knapsack stays
   pure integer MCKP; stowage never imports kernel code (acyclic).
3. **Kernel seam:** agent-kernel vendors stowage (`file:vendor/stowage`)
   and its eight former modules become re-export shims over the package
   root — all kernel import sites (16 files, 869 tests) unchanged.
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
- stowage's `bun test` also runs the vendored knapsack suite — a free
  upstream tripwire.
