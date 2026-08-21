# ADR-0002g: The context API — the model's self-reflection surface

- **Status:** Accepted (guidelines subordinate to ADR-0002 / 0002a / 0002d)
- **Date:** 2026-08-21
- **Deciders:** Daniel Eisner (rulings), Robby (analysis)
- **Parent:** ADR-0002 (§6 — kernel as medium, kernel as tool)
- **Ancestors:** ADR-0002a §2, ADR-0002d §7, ADR-0002e, ADR-0002f
- **Extended by:** ADR-0002h (search — the discovery half: regex and
  semantic retrieval over store and journal, making locate-then-promote
  usable; journal search is the recovery path from summarization)

## Context

Ruling this session ties the 0002 family together: the kernel exposes a
`ctx` API allowing the model to **explore its own context object** and
**manipulate it** — explicitly promoting lens values to bring items back
into or out of the rendered context, and turning auto-refresh on or off
per lens. Framing on record: this is **not necessary for the agent to
work correctly** — the optimizer runs autonomously — but is available
**in the spirit of the RLM functionality**: the kernel as a tool the
agent may use on itself.

## Decision

### 1. The `ctx` surface

A typed, materialized module in the kernel namespace (the ADR-0002 §5
pattern; declarations review-gated like all surfaces):

**Exploration (read-only):**

```ts
ctx.inspect(): ContextOverview
//   items present in render: id, kind, representation, zone, tokens,
//   refresh state (live | polled | frozen), unchanged-stamp
//   items NOT rendered: dropped/purged items with the turn they left
//   and their current forecast state — the invisible context
ctx.item(id): ContextItemDetail
//   value inputs (mu0, alpha-effective, deltaT), hazard, toggle state,
//   lastRenderedTurn, representation, upstreams
ctx.why(id): DecisionTrace
//   the ledger answer: recent decisions affecting id, accepted and
//   rejected, margins vs. hysteresis (ADR-0002e records, model-facing)
```

**Manipulation (declarative requests):**

```ts
ctx.promote(id, opts?: { until?: "task" | "session" }): Effect
//   model-authored value bump — raise effective value, bring the item
//   back toward render; priced and re-solved (§2)
ctx.demote(id): Effect
//   value suppression — push the item out of render (the model's
//   "out of the rendered context")
ctx.watch(id, mode: "live" | "polled" | "frozen"): Effect
//   the auto-refresh toggle of ADR-0002d §7 — this API is its
//   model-facing surface
```

`Effect` reports what the solver did (entered render / evicted-elsewhere
/ refused-over-budget), rendered as a one-line tail notice.

### 2. Signals, not overrides — the solver stays the single writer

`ctx.*` mutations write **store-level signals** (value bumps, toggle
flips); render remains the solver's alone. Consequences:

- **Determinism and replay survive** (ADR-0002e): a session with ctx.*
  calls replays exactly — the calls are journaled store inputs, not
  render patches.
- **The budget is honored, not bypassed**: promote re-prices; the
  solver re-solves; the honest outcome may evict something else to pay
  for the promotion. The model sees the outcome, including the refusal.
- **The toggle's authorship rule extends**: model-authored promote /
  demote / watch flips are declarative journal signals (the class of
  ADR-0002d §7 and the goals.* surface of ADR-0002f) — they feed α, Δt,
  and hazard calibration; optimizer-authored flips still never do.

### 3. What inspection is for

The model already sees its rendered context; it cannot see the store
behind the render. `inspect` exposes the context-behind-the-context:
what exists but is unrendered, what is frozen and since when, what is
summarized versus verbatim, what the forecasts say. `why` is the
ledger's explanation surface — the same audit trail the offline
analyst queries in ADR-0003, served to the model at handle policy.
One ledger, three audiences: the model, the analyst, the tuner.

### 4. Standing constraints

- **Coordinator-side, capability-scoped** (ADR-0002a §2 unchanged):
  cells never hold mutable context objects; ctx.* is RPC over the
  single `{surface, method, args}` envelope like every plugin call.
- **Autonomous default**: an agent that never calls ctx.* behaves
  identically to one that cannot — the optimizer is complete without
  it. The compat skin (0002a §1) is unaffected; ctx.* is additive.
- **No self-flooding**: exploration results are values under the
  handle policy (summary + digest to context, full structure to
  namespace); the API must not cost more context than it explains.
- **Revocable**: the surface is granted per-agent and can be withheld
  (sandboxed/child agents) without touching core operation.

## Consequences

- The declarative-signal surface is unified: `goals.*` (0002f),
  `ctx.watch` (0002d §7), and `ctx.promote/demote` are one class —
  model-authored intent, journaled, calibration-feeding, never
  optimizer-authored.
- The RLM symmetry completes: `rlm.*` operates children; `ctx.*`
  operates the self. Both are kernel-as-tool at boundaries; neither is
  required for the inner loop to function.
- ADR-0003's thrash detector gains a subject: promote/demote cycles
  are model-authored thrash and show up in the decision audit like any
  other.
- The ledger gains its third reader on day one of the loop milestone
  (ctx.why), not just at corpus time.

## Risks / research areas

- **Micro-management** — a model that livelocks on promote/demote
  cycles; hysteresis applies to model requests too (a promote that
  reverses a demote within the margin is refused with the trace).
- **Introspection cost** — inspection invites navel-gazing; the token
  cost of self-exploration is itself visible in the ledger, and the
  optimizer prices notices accordingly.
- **Explanations as prompts** — ctx.why exposes forecast internals to
  the model; wording must inform, not persuade (the model should not
  optimize for the optimizer).
