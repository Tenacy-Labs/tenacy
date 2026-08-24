# ADR-0000 — stowage charter

- Status: accepted (owner ruling 2026-08-23: "Let's go with stowage")
- Date: 2026-08-23
- Lineage: extracted from agent-kernel. Its ADR-0005 ("the solver is a
  knapsack") governs the representation axis; its ADR-0006 §8 rules the
  phase-3 sequence objective this repo exists to implement.

## Context

agent-kernel's optimizer grew a solver whose scope outgrew the kernel:
once the sequence axis (where blocks sit, when they move) became a priced
part of the solve, the machinery became generic to any harness that pays
provider cache bills. The kernel keeps the WHAT (option surface, value
semantics, ledger); stowage is the HOW.

## Decision

1. **Scope:** joint representation × position × timing optimization for
   context layouts, as a price-coupled decomposition:
   - representation → exact MCKP (dependency: `@connectotron/knapsack`)
   - position → tree-metric moves, prefix-sum pricing, greedy tree-shaping
   - timing → threshold policies with accumulated evidence (anti-Zeno)
2. **Not in scope:** option surfaces, value/rot semantics, ledger
   journaling, substrates/lenses — consumer-side (agent-kernel).
   knapsack remains pure integer MCKP, unchanged.
3. **Constitutional constraints:** determinism (replay re-derives
   decisions), attribution (per-item margins, rejected-move logging),
   provider-honest cache economics (billing geometry, dual-axis TTL).
4. **Numbering note:** agent-kernel's planned "ADR-0007
   (sequence-position semantics)" is issued here as ADR-0001; this
   charter records the lineage mapping.
5. **License:** pending owner ruling (MIT if adoption is the goal, per
   the knapsack precedent; not decided at extraction time).

## Consequences

- agent-kernel vendors stowage (the knapsack vendoring pattern) once the
  port slice lands; knapsack becomes stowage's dependency rather than
  the kernel's direct one.
- ADR-0001 (proposed) carries the algorithm-class ruling: the monolithic
  "it's a knapsack" framing is superseded by the decomposition, which
  each rejected alternative (gradient descent, Monte Carlo, quantum
  annealing) failing a constitutional constraint for the solve path
  while remaining licensed in surrounding layers (offline refit,
  evaluation).
