# agent-kernel

The harness **and agent-authored cells are TypeScript**. Bun strips types when
loading `.ts` modules but does not type-check and does not transpile strings
passed to `eval`. Every cell therefore passes through an in-process TypeScript
gate before execution:

```
TS source → strict static diagnostics → transpile → JSC eval → snapshot
```

Type errors return structured, cell-relative diagnostics and execute no code.
Successful source remains in a cumulative virtual TypeScript program, so types
survive between cells. Recovery rebuilds that static program from audit source
without replaying any cell. Repository CI separately runs `tsc --noEmit` before
the test suite.

In multi-agent mode the gate runs once on the coordinator thread; worker
agents execute pre-checked JavaScript and stay compiler-free (~6.7MB each).

A persistent TypeScript/JavaScript kernel for LLM agents. The agent executes code in a
long-lived kernel whose namespace persists across turns — trading context-window tokens
for addressable, queryable state. Concepts from [prime-agent](https://github.com/PrimeIntellectual-ai/prime-agent)'s
RLM kernel, jcode's session efficiency, implemented on [Bun](https://bun.sh) so host
and kernel share one language and the kernel boundary is a function call, not a
network protocol.

## The persistence contract

1. **Never replay.** No code path executes journal cells — not for recovery, not as
   fallback. Side effects fire exactly once. Amnesia is acceptable; duplication is not.
2. **The snapshot is the sole recovery source**, committed atomically every turn.
3. **The journal is an audit record** — a readable history of every cell, never run.

Non-serializable values become explicit tombstones the agent can see, never silent loss.

## Quick start

```bash
bun test            # 11 tests, including fresh-process crash recovery
bun bench/bench.ts  # 10 concurrent persistent sessions
```

Requires Bun ≥ 1.1.

## Layout

```
src/kernel.ts        The kernel: eval, journal, atomic snapshots, recovery
test/                bun:test suite + fresh-recovery.ts (child-process discipline)
bench/               runtime and session benchmarks
docs/design.md       Architecture, decision log, invariants
docs/benchmarks.md   Measured numbers and reproduction steps
docs/adr/            Accepted decision records (0000–0006; 0005 MCKP solver,
                     0006 evidence-priced properties, T* horizons, suffix accounting)
src/optimizer/       Context optimizer: MCKP solver, evidence/horizon/suffix
                     pricing, ledger + gauges corpus reports
bench/corpus/        s3 pressure corpus + gauges baseline runner
```

## Status

Mature prototype. Kernel, persistence, and agent loop are built, tested, and
live (Vercel AI SDK provider registry, PR #5). The remaining roadmap surface —
ops.* host caps (`rlm.*`/`memory.*` intents), rlm() child agents with usage
attribution, swarm hibernation, and bun:sqlite semantic session memory
(FTS5 + embedding blend, `/mem`, auto-index on save) — shipped. The context
optimizer implements ADR-0005 (per-turn MCKP) and ADR-0006 (evidence-priced
properties, turnover-capped horizons T* = (Λ−W)/a_t, exact suffix mass with
shared-bill and TTL free-window accounting), staged and each phase
falsifiable against the §7 gauges (gauges-baseline: believed-hit 75.4%,
re-expansions/eviction 12.9%); 134 tests green. Deliberately unbuilt: the
Rust/deno_core graduation path (kept open as the insurance policy). See
`docs/design.md` and `docs/adr/`.

Private repository of the Connectotron organization.
