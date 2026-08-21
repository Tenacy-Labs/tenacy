# ADR-0002b: Multi-horizon mean-variance context optimization

- **Status:** Accepted (guidelines subordinate to ADR-0002)
- **Date:** 2026-08-21
- **Deciders:** Daniel Eisner (rulings), Robby (analysis)
- **Parent:** ADR-0002 · **Sibling:** ADR-0002a
- **Extended by:** ADR-0002d (the lens family and live views); the
  decision audit of §6 and the calibration inputs of §2 are specified as
  the decision ledger and corpus by ADR-0002e; ADR-0002f declares per-kind
  value profiles — §2's power law is the default profile, not a law
  (goals are the first decay-exempt kind)

---

**Summary.** Context as a multi-horizon portfolio: power-law value decay, change forecasts, ordered (zonal) risk, a block-plus-delta copy-on-write representation, and a hysteresis-disciplined solver.

**Key points**

- Portfolio framing: items compete for the window under budget as assets compete for capital — §1
- Expected value: constant base μ₀ with power-law recency decay (1+Δt)^−α — §2
- Change forecasts: per-item hazard; the forecast is load-bearing when validation returns unknown — §3
- Risk is ordered, not pairwise — the zones (identity/foundational/episodic/transient) fall out of position — §4
- Block + deltas: copy-on-write prompt representation — append-cheap, rewrite-priced — §5
- Solver discipline: marginal moves with hysteresis margins — no thrash — §6

*An index of sections and key points, with line anchors, appears at the end of this file. If you edit this file, update that index to match.*

## Context

ADR-0002 §4 priced individual render decisions with a three-term utility.
Rulings this session generalize it: context construction is a **portfolio
optimization problem, solved repeatedly across horizons**. The previous
render is the portfolio we hold; every turn is a rebalancing under a
budget, with transaction costs (cache invalidation), risky assets (items
that may change), and a risk-free anchor (frozen identity, always held).

## Decision

### 1. Portfolio framing

| Finance | Context optimizer |
|---|---|
| Asset | ContextItem |
| Allocation weight | tokens / inclusion / position |
| Portfolio | previous render (the incumbent) |
| Rebalance | each turn's render |
| Expected return μᵢ | item's expected value (below) |
| Volatility | item's change forecast (hazard) |
| Transaction cost | invalidation / re-prefill $ |
| Budget | context token budget Λ |
| Risk aversion λ | rot-penalty weight |

Each render chooses inclusion, position, and representation per item to
maximize expected portfolio value net of transaction costs and risk, over
multiple horizons simultaneously: the immediate turn, the current task,
and the session.

### 2. Expected value: constant base with power-law recency decay

v1 model, per ruling: **vᵢ = μ₀ · (1 + Δtᵢ)^(-α)**, where Δtᵢ is turns
since the item was last modified or explicitly invoked, μ₀ a per-kind
constant, α ≈ 1 to start. Power law, not exponential, because reference
locality in real work is heavy-tailed: an item untouched for twenty turns
retains non-negligible re-reference probability, which exponential decay
gets structurally wrong. **Explicit research area** (flagged by ruling):
μ₀ estimation per kind, task-relevance weighting, and α fitting — all
calibratable from journal statistics, since the journal already records
every touch and re-reference (the calibration-loop theme of ADR-0002 §2).

### 3. Change forecasts

Each item carries a forecast of **time until expected change** (equivalently
a hazard rate hᵢ(Δt)). Priors come from kind (identity: never; notice:
this turn; goal: task-scale; lens: observed inter-touch intervals; external
signals such as file mtime feeds refine lens hazards). The velocity tiers
of ADR-0002 become priors; observation sharpens them. Forecasts feed both
the risk model (below) and cache-checkpoint placement.

### 4. Risk is ordered, not pairwise — zones fall out

One deliberate deviation from Markowitz: invalidation cost is positional.
If item i changes, everything rendered after it re-fills. Portfolio risk:

```
risk(render) = Σᵢ hᵢ · (tokens-after(positionᵢ))²
```

Minimizing this in the single-period case yields **stable items early,
hot items at the tail** — the velocity-zone layout of ADR-0002 derived
from first principles rather than asserted. Clustered hazards (one file
edit invalidating several dependent views) act as correlated risk; the
solver accounts for them jointly.

### 5. Block + deltas representation (copy-on-write for prompts)

A lens may render in one of four representation states:

- **FULL** — a single consolidated block.
- **BASE+DELTA** — an early, cache-immortal base block, with subsequent
  expands appended as delta entries near the tail. Append-only: prefix
  cache preserved across growth; deltas carry their own mtime meta
  (ADR-0002a §4).
- **CONSOLIDATED** — deltas folded into a fresh base block; a rewrite,
  paid only when an invalidation is already due or fragmentation cost
  exceeds consolidation cost.
- **PURGED** — evicted entirely; re-entry on demand at re-read cost.

Representation transitions are solver decisions, priced by the objective
function — including liquidation: a lens that has grown to dominate the
window is purged and restarted rather than subsidized, exactly as an
overweight position is cut.

### 6. Solver discipline

- **v1 (analytic):** zone ordering with hysteresis — the closed-form
  single-period solution. Ships with the loop.
- **v2 (marginal-exchange):** per-turn, evaluate candidate moves one at a
  time (move item across neighbor, consolidate lens, evict item); accept
  only when expected gain clears the hysteresis margin net of transaction
  cost. Bounded work per render; deterministic.
- **v3 (research):** global multi-horizon optimization — dynamic portfolio
  choice with horizons (turn / task / session), λ calibrated from realized
  outcomes. Research, not roadmap-blocking.

The solver runs inside render(), inheriting its contracts: pure,
deterministic, journaled, golden-tested. The InvalidationLedger gains a
decision audit — each accepted move with its expected-value rationale.

## Consequences

- ADR-0002 §4's utility is the single-decision special case; 2b embeds it
  in a repeated decision problem. No contradiction: benefit → μᵢ terms,
  cacheCost → transaction costs, rot(Λ) → the aggregate size penalty that
  disciplines total allocation.
- Re-reference statistics from the journal become a first-class calibration
  input, alongside cache-hit reports — two closed loops, one lab.
- Eviction stops being a threshold hack and becomes a priced position cut.

## Risks / research areas

- **Parameter sparsity** — early sessions have thin statistics for α and
  hᵢ; priors carry the load until observation accumulates. Honest
  defaults, calibratable later, never blocking.
- **Optimizer thrash** — marginal-exchange without hysteresis chases noise;
  the recompute-always/change-only-with-margin rule of ADR-0002 stands.
- **Solver cost budget** — renders are on the hot path; v1/v2 are bounded
  by construction, v3 must prove its per-turn cost before adoption.
- **Power-law fit** — assumed heavy tail is empirically motivated but
  unverified in our workload; the journal will confirm or correct it.


---

**Index** — line anchors as of this revision.

*Update this index whenever the file is edited.*

Sections:

- Context — line 28
- Decision — line 37
- Consequences — line 129
- Risks / research areas — line 139

Key points:

- Portfolio framing: items compete for the window under budget as assets compete for capital — §1 — line 39
- Expected value: constant base μ₀ with power-law recency decay (1+Δt)^−α — §2 — line 58
- Change forecasts: per-item hazard; the forecast is load-bearing when validation returns unknown — §3 — line 70
- Risk is ordered, not pairwise — the zones (identity/foundational/episodic/transient) fall out of position — §4 — line 79
- Block + deltas: copy-on-write prompt representation — append-cheap, rewrite-priced — §5 — line 94
- Solver discipline: marginal moves with hysteresis margins — no thrash — §6 — line 113
