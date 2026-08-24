# @connectotron/stowage

**The context-layout solver: what to keep, how to render it, and where it
sits — decided jointly, priced honestly, deterministically.**

`stowage` plans an LLM context window the way a cargo officer plans a
hold: under a tonnage budget (the token window), each crate has
configurations (render options), *where* a crate sits determines
stability (provider cache-prefix continuity), shifting cargo mid-voyage
costs real money (transaction costs), and the plan is revised at each
port of call (every turn).

## What it is

A **price-coupled decomposition** over three axes with different
mathematical characters:

| Axis | Subproblem | Mechanism |
|---|---|---|
| Representation | pick one render option per item | exact MCKP via `@connectotron/knapsack` |
| Position | where each block sits in the sequence | tree-metric moves, prefix-sum priced, greedy tree-shaping |
| Timing | when to move / fuse / restructure | threshold policies with accumulated evidence (anti-Zeno) |

The axes are coupled by **prices**, not by a single monolithic paradigm:
the budget dual, the shared suffix bill, and continuation value. The
honesty check is an offline exact audit on small slices
(optimality-gap reporting), not a trust-me heuristic.

## Constitutional constraints

- **Deterministic** — identical inputs produce identical layouts; replays
  re-derive decisions. No stochastic search in the solve path.
- **Attribution-ready** — per-item margins and rejected moves are
  first-class outputs, not afterthoughts.
- **Provider-honest** — cache economics model billing geometry (prefix
  chains, billing quanta, dual-axis TTL), not wishful thinking.

## Repository boundary

| Repo | Owns |
|---|---|
| `knapsack` (sibling) | the pure integer MCKP engine (math contracts) |
| `stowage` (this repo) | the layout solver: selection × placement × timing |
| `agent-kernel` (private) | the option surface, value semantics, beliefs, ledger — the WHAT |

Extracted from agent-kernel's optimizer (ADR-0005 lineage) as the
phase-3 sequence axis made it a standalone component reusable by other
harnesses. Founding rulings: [ADR-0000](docs/adr/0000-charter.md).

## Status

**v0.1.0 — solver ported.** The full ex-agent-kernel solve core
(selection, suffix pricing, horizons, evidence, cache model, params,
contract types — ~1,500 lines) runs here, byte-identical, over the
vendored `@connectotron/knapsack`. agent-kernel consumes it via
`file:vendor/stowage` re-export shims; its 869-test suite is the port's
acceptance test. [ADR-0002](docs/adr/0002-solver-port.md) records the
move; [ADR-0001](docs/adr/0001-sequence-position-semantics.md) (the
phase-3 sequence axis) lands next. License: pending owner ruling.

## Development

Bun + strictest tsc (house pattern).

```sh
bun install
bunx tsc --noEmit
bun test
```
