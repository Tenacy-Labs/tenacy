# agent-kernel

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
```

## Status

Prototype. Kernel and persistence layer are built and tested; the agent loop, ops
surface (`ops.rlm_spawn`, `ops.goal_set`), and rlm() child agents are roadmap items —
see `docs/design.md`.

Private repository of the Connectotron organization.
