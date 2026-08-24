# ADR-0001 — sequence-position semantics (draft)

- Status: **proposed** — awaiting owner ruling; content lands with the
  solver port slice.
- Date: 2026-08-23 (drafted from the 2026-08-23 probe sessions)

## Problem

Two ruled suboptimalities (owner, 2026-08-23): (1) base+delta must be
placeable at very different sequence positions — deltas arrive much
later than their bases; (2) placement must live inside the solver
(order-aware), not as an n² re-solve search in the caller.

## Ruled direction (pending final ruling)

1. Delta fragments as independently placeable items; fusion = the priced
   decision to co-locate. Deltas of one base render in arrival order
   (explicit precedence edges).
2. Solver becomes joint representation × position optimization:
   select → price moves → re-place → re-price, converging (dual
   decomposition), hard-capped alternation, passes-per-solve journaled.
3. Algorithm class (probe verdict 2026-08-23): decomposition — exact
   MCKP for selection; tree-metric greedy for placement; threshold /
   optimal-stopping for timing. Gradient descent, Monte Carlo, and
   quantum annealing rejected for the solve path (determinism +
   attribution constraints); licensed in surrounding layers only.

## Sections this ADR must carry at acceptance

- Literature map: list update (2-competitive); file migration
  (3-competitive); reordering buffers (O(log k)); metrical task systems
  on tree metrics; Prompt Cache / PSM / SOLO radix-tree reuse;
  lost-in-the-middle position value.
- Complexity contract: ≤2 exact engine calls per turn; hard cap 3
  selection / 5 move passes; ~1–5 ms added at n=80.
- Approximation boundaries stated explicitly: representative orderings;
  independent move pricing (batching-corrected within a broken window);
  position-value uniform until position-regret data exists.
- Five additions (2026-08-23 probe): wall-clock TTL axis; provider
  billing quanta + explicit breakpoints; position-regret ledger column
  from day one; move-thrash defect signal; acceptance = gauges AND one
  live A/B (cost-counterfactual replay alone cannot validate
  effectiveness claims).
- Falsification gauges (§7 discipline): flips down, re-expansions down,
  cache-hit up, dead bytes down; delta-at-tail cheaper than
  delta-at-base by exactly the between-suffix mass.
- Retirement table: the four agent-kernel solver patches (keep-branch,
  true suffix pricing, cache-continuity zoning, tail relief) become
  provable special cases of move pricing.
