# ADR-0002e: The decision ledger — forecasts, cache beliefs, and the calibration corpus

- **Status:** Accepted (guidelines subordinate to ADR-0002 / 0002b)
- **Date:** 2026-08-21
- **Deciders:** Daniel Eisner (rulings), Robby (analysis)
- **Parent:** ADR-0002 · **Ancestors:** ADR-0002b, ADR-0002d
- **Input:** this session — ruling that every render step records, in
  detail: per-component utility forecasts, the objective computation
  breakdown, cache beliefs, and expected-vs-realized cache hits and cost;
  and that these logs, collected across many runs, become the corpus used
  to tune forecasts and utility calculations.

## Context

The calibration loops were named but not specified: ADR-0002 §4's
InvalidationLedger (predicted vs. realized cost), ADR-0002 §2's
self-calibrating cache model, ADR-0002b §2's α/μ₀ fitting "from journal
statistics." Ruling this session makes the recording **explicit,
per-step, and detailed** — the ledger is a first-class design artifact,
not a byproduct. Purpose: collect ledgers from many runs over time;
tune forecasts (μ₀, α, hazards) and utility parameters (λ, rot curve,
cache model) against them.

## Decision

### 1. What each render step records

**Per turn (context + beliefs):**

```ts
interface TurnLedger {
  turn: number;
  layout: { id: ItemId; position: number; tokens: number; state:
            "FULL" | "BASE+DELTA" | "CONSOLIDATED" | "PURGED" }[];
  cacheBelief: {
    blockDigestChain: Digest[];          // what we believe is cached
    checkpoints: number[];               // where we believe they sit
    ttlAssumptions: Record<BlockId, number>;
    providerGranularity: number;         // block size assumed
  };
  budgetLambda: number;                  // rendered-token budget
  parameterSetVersion: string;           // pin (see §4)
}
```

**Per item per render (the forecast decomposition):**

```ts
interface ItemLedger {
  id: ItemId;
  forecast: { mu0: number; alpha: number; deltaT: number;   // value inputs
              hazard: number; basis: "prior" | "observed";  // change forecast
              expectedValue: number };
  utility: { benefit: number; cacheCost: number; rotShare: number;
             total: number };                               // three-term breakdown
  decision: "keep" | "drop" | "move" | "consolidate" | "promote" | "purge";
  accepted: boolean;
  marginVsHysteresis: number;         // negative for rejected near-misses
}
```

**Per model call (cache expectation vs. reality):**

```ts
interface CacheLedger {
  turn: number;
  expected: { hitTokens: number; price: number };   // from cacheBelief
  realized: { hitTokens: number; price: number } | null;  // usage report
  divergence: "none" | "believed-cached-rebilled"
            | "believed-evicted-hit" | "unreported";
  rawProviderReport: unknown;        // normalized belief + raw report both
}
```

**Outcome signals (realized value, journaled as observed):**
re-references per item (did the model use it later?), redo rate,
instruction misses — the rot-calibration inputs of ADR-0002 §4. Toggle
flips and watcher events (ADR-0002d §7, §5) join by `{itemId, turn}`.

### 2. Principles

- **Decomposition enables attribution.** Logging each term separately,
  at decision time, with the inputs used, lets an offline pass attribute
  error to the value forecast, the hazard, the cache model, or the rot
  curve — four independent tuning targets, four independent records. A
  ledger of final renders alone cannot answer "which belief was wrong."
- **Rejected moves are data.** The v2 solver's evaluated-and-rejected
  candidates are logged with their margins. Accepted-only logging is
  selection bias; near-miss rejections are where a miscalibrated
  hysteresis margin hides.
- **Honesty about missing labels.** Providers differ in usage reporting;
  when realized is unobservable, record `null` (`divergence:
  "unreported"`), never a fabricated estimate. Tuning must know which
  observations were never made.
- **The ledger is journal, not store.** Ledger entries never render and
  never enter the context store — they are truth-layer records
  (ADR-0002a §5's distinction: rendering is for the model, journaling is
  for truth). The ledger is append-only, written asynchronously, and
  never blocks render.

### 3. The corpus and the tuning loop

1. **Collect** — ledgers accumulate across runs; the corpus is the union,
   queryable by item kind, lens substrate, provider, task shape.
2. **Refit** — offline batch: α and μ₀ per kind from re-reference
   statistics; hazards from realized invalidation; cache-model parameters
   (effective TTL, granularity, eviction behavior) from the divergence
   records; λ and the rot curve from performance-vs-length outcomes.
3. **Version** — fitted parameters ship as versioned parameter sets;
   every ledger entry pins the version that produced it (§1). Renderer
   determinism means decisions are a pure function of (store, params);
   version pins keep old ledgers interpretable and recomputable under
   new parameters — forecast errors are measured, not lost to drift.
4. **Guard** — fitted-vs-prior divergence over the corpus gates adoption
   (the parameter-sparsity risk of ADR-0002b: early fits on thin or
   narrow workloads overfit; priors carry the load until the corpus
   disagrees with confidence).

### 4. Cost discipline

The detailed ledger lives on the hot path. Structured appends,
asynchronous flush, bounded per-turn volume (per-item records are small
by construction — the numbers the solver already computed). Retention:
full fidelity is the calibration corpus; compaction produces derived
views, never replaces the raw append.

## Consequences

- The InvalidationLedger of ADR-0002 §4 and the decision audit of
  ADR-0002b §6 are **subsumed**: both become sections of the per-turn
  decision ledger defined here.
- Three named closed loops, one lab notebook: the cache loop (expected
  vs. realized hits), the value loop (forecast vs. re-reference), the
  rot loop (predicted degradation vs. observed performance).
- The ledger doubles as the optimizer's debugger: "why was X dropped at
  turn 41?" is answered by replay — deterministic render + pinned
  parameters + journaled inputs.
- Parameter sets become versioned artifacts with a change history,
  reviewable like code (the ADR-0001 review discipline applies to
  anything that steers the optimizer).

## Risks / research areas

- **Ledger volume** — per-item-per-turn detail across long sessions is
  large; the corpus justifies it, but flush discipline and storage
  budgeting are operational concerns, not afterthoughts.
- **Forecast self-conditioning** — once parameters tuned on the corpus
  steer the optimizer that generates the next corpus, the loop can
  reinforce its own biases; version pins and prior-divergence guards are
  the audit trail for this.
- **Provider report heterogeneity** — normalization must not launder
  uncertainty; raw reports ride alongside normalized beliefs precisely
  so later analysis can re-derive.
