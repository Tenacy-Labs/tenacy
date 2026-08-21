# ADR-0002c: The generic item interface — validity, horizons, placement

- **Status:** Accepted (guidelines subordinate to ADR-0002 / 0002b)
- **Date:** 2026-08-21
- **Deciders:** Daniel Eisner (rulings), Robby (analysis)
- **Parent:** ADR-0002b · **Siblings:** ADR-0002, ADR-0002a
- **Extended by:** ADR-0002d (the lens family populates the instance
  space — the directory lens is the subscribable instance, the namespace
  lens the in-process-observable one; the rate-limited API stress test
  remains unbuilt)
- **Input:** this session — multi-horizon worked examples (current-time
  component vs. file lens on an aged mtime) and the ruling that they are
  **example instances of a generic interface to be designed**, not the
  design itself.

---

**Summary.** The generic item interface: every context source — clock, file lens, remote API — is a point in a four-axis space (observability, forecastability, materialization cost, subscribability) behind one validity/horizon/placement protocol.

**Key points**

- Four orthogonal axes; instances are points in the space, not special cases — §1
- Validity interface: materialize / validate → fresh|stale|unknown / horizon → deterministic|distribution|stable — §2
- Placement is a pure decision function: re-derive per turn, cache-and-validate, or promote to stable — §3
- Load-bearing rules: horizon is a hint; forecast matters when validate is unknown; subscriptions retire forecasts — §4
- Derived items compose as a DAG; leaf validation covers the subtree — §5
- Worked instances: the clock (collapses to a stateless derivation) and the file lens (cache-and-validate) — §6

*An index of sections and key points, with line anchors, appears at the end of this file. If you edit this file, update that index to match.*

## Context

ADR-0002a §4 gave file lenses an mtime validation protocol; ADR-0002b §3
gave every item a change forecast. Both were motivated by two worked
examples: a current-time component (invalid by construction, horizon of
exactly one turn) and a file lens (stat-able, event-invalid, aged mtime).
Ruling this session: the examples are points in a space — **the deliverable
is the space**. A generic interface that the examples implement, chosen so
that the third implementation arrives without redesign.

## Decision

### 1. Four orthogonal axes — every instance is a point in this space

- **Observability** — can validity be probed cheaply? (`stat()`, etag,
  digest compare)
- **Forecastability** — can invalidation be predicted? Deterministic,
  statistical, or blind.
- **Materialization cost** — what does re-derivation of the value cost?
- **Subscribability** — can invalidation be *pushed* (watchers, webhooks)
  rather than polled?

The two worked examples sit at opposite corners: the clock is
fully forecastable, trivially materializable, unobservable-and-irrelevant;
the file lens is cheaply observable, statistically forecastable,
moderately materializable, subscribable where watchers exist.

### 2. The validity interface

```ts
interface ItemSource<T> {
  id: ItemId;
  materialize(): T;                                    // expensive: produce value
  validate(cached: T): "fresh" | "stale" | "unknown";  // cheap: probe
  horizon(cached: T): Horizon | null;                  // forecast: expected turns of life
}

type Horizon =
  | { deterministic: number }                     // clock → 1
  | { distribution: { p50: number; p95: number } } // file lens → heavy-tail on mtime age
  | { stable };                                   // archival
```

Naming note: ADR-0002's `ContextItem` remains the stored, rendered record;
an item *references* a source implementing this interface (exact field vs.
capability wiring is an implementation decision). The clock and file lens
become instantiations, not special cases.

### 3. Placement policy is a pure decision function

```
(validate result, horizon, materialization cost, validate cost)
  → re-derive per turn | cache-and-validate | promote to stable
```

This mechanizes the memory hierarchy of ADR-0002 §2 (volatile tail /
evolving middle / frozen head) as a decision function over interface
outputs, rather than an asserted layout. The deterministic case proves the
interface honest: an item whose `validate` is guaranteed `"stale"` and
whose `materialize` is trivial **collapses out of cached state entirely**
into a per-turn derivation, `f(turn)` — stateless — and the policy above
does that with no special case.

### 4. Load-bearing rules

- **`horizon` is a hint, not a contract.** Sources that cannot forecast
  return `null` and fall back to validate-per-use or trust-until-touched.
  An interface that cannot degrade gracefully is not generic.
- **The forecast is load-bearing only when `validate` returns
  `"unknown"`.** When a cheap probe exists, the forecast is decorative;
  when flying blind, the forecast substitutes for a subscription we do not
  have.
- **Where subscription exists, the forecast retires.** Watchers and
  webhooks supersede statistical horizons without interface change — push
  simply answers `validate` before we ask.
- **mtime is a feature, not the answer.** Modification hazard is bursty:
  a file edited three minutes ago is probably mid-session (short horizon);
  the same file untouched for two years is archival (long horizon).
  Time-since-last-change under a heavy-tailed hazard (Weibull-shaped)
  captures the regime shift that raw age misses. This sharpens ADR-0002b
  §3's "external signals such as file mtime refine lens hazards."
- **Time-invalid vs. event-invalid is a first-class split.** Some items
  are invalidated by the clock (deterministic horizon), some by events we
  may or may not observe. The taxonomy feeds hazard priors per kind.

### 5. Derived items compose as a DAG

Lenses over sources, summaries over lenses, contributions derived from
calls (ADR-0002a §2) — each derived item declares its upstreams.
Validating the leaf covers the subtree; invalidation propagates upward
through declared edges. The cheap probe does the work of the whole chain;
correlated hazards (one file edit invalidating several dependent views)
fall out as the correlated-risk case of ADR-0002b §4.

### 6. Worked instances

- **Clock** — `validate` always `"stale"`, `materialize` trivial →
  per-turn derivation; zero cached state. The degenerate instance that
  tests interface honesty.
- **File lens** — `validate` = stat/etag (cheap, observable),
  `materialize` = re-read + transform, `horizon` = heavy-tail on age →
  cache-and-validate; exactly the mtime protocol of ADR-0002a §4.
- **The third instance (stress test, not yet designed)** — a polled
  remote API that *rate-limits `validate` itself*. The two examples agree
  too easily; an interface earns "generic" at implementation three, where
  the observability-cost axis actually bites. Candidates named in session:
  process state, issue-tracker queries, remote API responses, transcript
  tails.

## Consequences

- ADR-0002b §3's change forecasts gain an explicit input taxonomy
  (deterministic / statistical / blind × observable / unobservable).
- The renderer's placement policy and the 0002b solver consume
  `validate`/`horizon` outputs as their inputs — this interface sits
  upstream of the objective function, not inside it.
- `"unknown"` is a real answer with real policy (cost-aware choice between
  validate-per-use and trust-until-touched), not an exception path.
- Implementation sequencing unchanged: lenses (instance two) ship with the
  loop milestone; the third instance is selected when a real workload
  demands it, not before.

## Risks

- **Interface creep** — four axes and three methods invite accretion.
  Guard: every member must be exercised by at least two of the three
  worked instances, or it does not belong.
- **Forecast false confidence** — overconfident horizons are precisely how
  stale-file bugs happen; conservative defaults, calibrated from journal
  statistics (the closed-loop theme of ADR-0002 §2 and 0002b).
- **"Unknown" decay** — an unprobed `"unknown"` silently becomes
  trust-forever; the policy default must price validation against stale
  risk, not default to skipping the probe.


---

**Index** — line anchors as of this revision.

*Update this index whenever the file is edited.*

Sections:

- Context — line 31
- Decision — line 41
- Consequences — line 140
- Risks — line 153

Key points:

- Four orthogonal axes; instances are points in the space, not special cases — §1 — line 43
- Validity interface: materialize / validate → fresh|stale|unknown / horizon → deterministic|distribution|stable — §2 — line 58
- Placement is a pure decision function: re-derive per turn, cache-and-validate, or promote to stable — §3 — line 79
- Load-bearing rules: horizon is a hint; forecast matters when validate is unknown; subscriptions retire forecasts — §4 — line 94
- Derived items compose as a DAG; leaf validation covers the subtree — §5 — line 116
- Worked instances: the clock (collapses to a stateless derivation) and the file lens (cache-and-validate) — §6 — line 125
