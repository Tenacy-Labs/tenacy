# ADR-0006: Amendment III — evidence-priced properties and turnover-capped horizons

- **Status:** Accepted (amendment — extends the property sheet and pricing semantics; never retro-edits accepted bodies)
- **Date:** 2026-08-22
- **Deciders:** Daniel Eisner (rulings), Robby (analysis)
- **Amends:** ADR-0002 (ContextItem property sheet, by extension) · ADR-0002b/0005 (variance pricing, activated at the value layer) · ADR-0004 (option surface, gains layout moves) · ADR-0002f (consolidation, gains recoverability classes)
- **Evidence:** solver-over-time design session, 2026-08-22, against `src/optimizer/solver.ts` at commit `5db5e29` (PR #5); pressure-corpus measurements of record (emergence pass, L3)

---

**Summary.** The Decider examined the solver against its founding problem — optimal use of the context window both per-turn and over many turns — and ruled on three matters: (1) the per-item property sheet is revised so that every property is option, evidence, or substrate — value is priced from each item's own observed re-reference evidence, not kind labels; (2) deliberate cache invalidation is an investment that the solver must be able to price, with deferral costs carried as a growing trend and the always-pave pathology excluded structurally; (3) all lookahead horizons are capped at the expected turnover of the context window itself (T\*), a decision-invariant quantity estimable from parameters already agreed here.

**Key points**

- Ruling: the solver is sequential in fact; properties, pricing, and horizons must let it decide over time, not just in time — §1
- The revised property sheet: four additions, two alterations, three removals; the admission test is "does the argmin change because this exists?" — §2
- Two-class recoverability: content-preserving consolidation is not discounted as lossy; the separate-views bias is a mispricing, not a preference — §3
- Early invalidation as investment: renewal framing, suffix-liability trend, anti-Zeno condition, TTL-window timing — §4
- The horizon cap T\*: decision-invariant, estimated from headroom and standing-mass drift; two caps because cache and value die at different times — §5
- Retired machinery: each addition names the patch or parameter it subsumes — §6
- Falsification: gauges wired before the properties; if the gauges do not move, the hypothesis is wrong and we revert — §7

*An index of sections and key points, with line anchors, appears at the end of this file. If you edit this file, update that index to match.*

## Context

The shipped solver is genuinely beyond myopic — future-value streams, the reservation price ρ, prefix-preserving disciplines are real multi-turn machinery (ADR-0005 §6). But it remains a patched myopic core: value priors are kind-level (every file lens prices identically to every other), fidelity ignores recoverability, FV conflates value decay with content churn, and the utility is mean-only. The four cache patches (keep-branch, prefix-preserving sort, tail relief, zoneOfDyn) are one insight implemented four times — the render is a sequence whose utility depends on the sequence as a whole, and nothing in the solver represents it that way. This amendment supplies the properties, pricing semantics, and horizon discipline under which that structure can be represented — and retires the patches it makes redundant.

## Decision

### 1. The ruling

Three theses, ruled together because they are inseparable:

1. **Evidence over labels.** The best predictor of an item's future value is its own observed access pattern. Kind profiles demote from value source to prior.
2. **Invalidation is an investment option.** Paying an uncached write now to stabilize a layout that harvests cached reads later must be priceable — including the trend cost of deferring it, and including protection against never harvesting what we pave.
3. **Horizons end at turnover.** All lookahead is capped at the expected context-window turnover T\*, because beyond it the current cache and layout are gone regardless of any decision made now.

### 2. The revised property sheet

Admission test for every field: *does the solver's argmin change because this exists?* Fields that fail are decoration.

**Additions (four):**

1. **`refEvidence`** — per-item access ledger: `{ hits: number[]; accessClass: "cited" | "distilledFrom" | "searchHit" | "reExpanded" }`. Update points already exist (intent touches, 0002h search hits, citations, re-expansions) and currently dead-end into the decay clock. Derived estimator: re-reference rate λᵢ, a posterior seeded from the kind prior and updated per observation (suggested family: Beta-Bernoulli per turn; exact family is open, §9). μ₀/α demote to priors; λᵢ becomes the value source. The keystone: unlocks calibration of (2) and estimation of (4).
2. **`recoverability`** — substrate presence (journal verbatim? re-readable?) plus recovery-cost class. Feeds fidelityPenalty (0002h already ruled fidelity disutility is discounted by retrieval availability) and qHandle. Two classes, not one — see §3.
3. **`churnProfile`** — content-renewal descriptor separating *value* decay (interest fading) from *content* decay (bytes changing). Already measured by TurnBoundaryWatcher; promoted from watcher-local to item property so the FV stream sees it: a high-churn item's FV decays as if stale (wrong — content renews) while hazardPremium prices k=0 change risk (right); over the FV horizon the two must be priced consistently.
4. **`forecastVariance`** — σᵢ² from posterior spread (1) plus realized-vs-expected divergence. Enters utility as mean-variance pricing at the value layer per ADR-0005 §4; retires `hysteresisMargin` as its principled replacement (hysteresis was unexpressed risk aversion).

**Alterations (two):**

- **`lastTouchTurn`** — demoted from "the value signal" to pure decay-clock input. Recency-equals-importance is the assumption being corrected.
- **`hazardOverride`** — same field, richer estimator: EWMA point estimate → posterior (prior + observation count), so it can feed variance, not just mean.

**Removals (three):**

- **`velocity`** — consumed nowhere in solver or renderer (verified by inspection at `5db5e29`). Duplicates hazard (hazard *is* velocity as a probability) and promises information the solver never receives; zoneOfDyn derives dynamism from observed state. Demote to derived debug view or delete.
- **Kind-profiles-as-value** — the definition retires: value comes from item evidence anchored by kind priors, never from kind alone.
- **`hysteresisMargin`** (param, listed here for completeness) — subsumed by `forecastVariance`.

**Classification (the invariant):** after this revision, every property is exactly one of — an **option** (carries policy; ADR-0004 center-piece principle holds), **evidence** (feeds a posterior), or **substrate** (digests, bytes, recovery paths). No labels.

### 3. Two-class recoverability

CONSOLIDATED-for-lenses and MERGED-with-journal-verbatim are content-*preserving*: the bytes are recoverable at known cost, so the FV discount is near zero and the choice is one suffix re-bill versus perpetually carrying dead delta bytes. True SUMMARY is content-*destroying* and keeps a real discount. The current q-table classes all lossy representations under qLossy — this over-penalizes consolidation and is precisely what makes separate base+delta views sticky.

Consequence (the Decider's example, made policy): with per-item λᵢ, the solver sees *which ranges* of an accumulated view remain alive; consolidation captures alive value at lower token cost while folding dead ranges. The representation ladder — separate deltas → consolidated → compact handle → purge — is walked in order, each rung crossed only when that view's remaining re-reference stream no longer covers its seat at that rung's token cost. Pressure relief (ρ rising under budget) is what moves items down the ladder; elimination of a hot view stays expensive because the tombstone forfeits q·λᵢ·μ every future turn.

This is the context-optimizer pattern (the accumulator keeps every chunk it ever read; the optimizer consolidates the understanding, releases the raw bytes, and keeps the handle to re-expand on evidence).

### 4. Cache amortization: early invalidation as investment

The shipped solver is harvest-only: every discipline biases against ever paying a write voluntarily, so a restructure that pays one uncached bill to stabilize a better layout cannot be priced — the solver can strand itself in a locally-stable, globally-inferior arrangement.

- **Layout moves as options.** Restructures join the option surface, priced against **continuation value** — never against an imagined static holding (the open-loop FV bias). A move's harvest counts only if the policy's own future realizes it.
- **Exact suffix mass.** The shipped approximation prices the suffix after a changed block as a proportional token share — exact only for uniform block sizes; a 2,000-token lens before fifty 40-token turns misprices both directions (solver review open thread #2, resolved here). Transition costs price the suffix from actual placement mass.
- **One cache break per position, not per item.** Per-item summation double-counts when multiple items restructure in one turn: the provider bills bytes after the *leftmost* changed block once, and a second restructure inside that already-invalidated region is free. The true bill is the cheapest break-set, never the sum over items. Greedy-plus-hysteresis rarely trips this today only because batching is unpriced; a correct implementation *wants* batched restructurings (one write, many moves) and must charge them as one write.
- **Position prices restructure exposure.** The same move strands a different suffix by locale — tail: nearly nothing; head: the whole render. As a transition cost this becomes a deliberate placement incentive (items likely to restructure drift tailward) rather than an emergent accident of zone order; STRESS-A measured the emergent version (mutating lens tail-parked, history locked), the DP prices it.
- **Suffix-liability trend.** Deferring an invalidation appends history after the eventual invalidation point; the same restructure grows monotonically dearer. `transactionCost`'s spot price becomes a trend: "later" stops being silently free.
- **Anti-Zeno condition.** In closed-loop (Bellman) pricing, a policy that always re-invests books harvests its own continuation cancels; under γ < 1 it loses to harvesting even once. Combined with the growing deferral liability, both pathologies (always-harvest, always-invest) are self-liquidating; what survives is a stationary threshold policy — restructure when transient salvage falls below reset-cost growth.
- **TTL-window timing.** Under believed TTL (`ttlTurns`, currently 6), restructuring inside an already-expired window destroys almost nothing — the prefix was dead regardless. Optimal policy concentrates restructures into post-expiry windows and lets fresh caches run their natural life.

### 5. The horizon cap: T\*

All lookahead horizons are capped at the expected turnover of the context window — the point at which the window turns over *regardless of the current decision*. The Decider's ruling, verbatim in substance: after that point we are throwing away the current cache regardless, and expected savings can never exceed it.

**Why decision-invariant (the property that makes it sound):** T\* is set by the workload's arrival process and the decay physics, not by any candidate layout. A cap derived from session age (2n) or from a candidate render's own growth would be self-referential — the solver would price its decisions against a future those decisions alter. This cap cannot bias the argmax.

**Estimator.** T\* = (Λ − W_t) / a_t, where:

- **Λ − W_t** — headroom: `budgetLambda` minus incumbent render tokens; both already ledgered every turn.
- **a_t** — net durable drift: expected growth of the non-sheddable prefix per turn. Empirical estimator (senior sessions): EWMA of Δ(standing mass) with restructures excluded — pure ledger arithmetic. Prior estimator (cold start): c̄ × ŝ, mean new-content tokens per turn times the survival fraction of arriving tokens into the long-lived set, computable from λᵢ, kind α, and ρ — all §2 properties.
- **Degenerate case:** a_t ≤ 0 (shedding faster than accruing) → T\* = ∞ → fixed-cap fallback. Stable sessions price the full horizon; filling sessions watch it shrink.

Corpus sanity check: at Λ = 2048, mid-L3 W ≈ 900t, a ≈ 150t/turn → T\* ≈ 7–8 turns, which is when the pressure actually landed. The estimator calls the L3 overflow in advance — consolidation fires *before* overflow rather than as recovery.

**Two caps, because two things die at turnover:**

- **Cache-amortization horizon:** H_cache = min(T\*, `ttlTurns`). Under short TTL the provider cache dies before the window does; an early write only needs to harvest ~`ttlTurns` turns.
- **Value-stream horizon (FV):** H_value = min(cap, T\*). Credit for today's representation choices stops when the layout they belong to is gone.

**Value does not stop at turnover — credit does.** Store items and their accumulated evidence survive into the next window; what dies is the cache and the arrangement. Decisions still earn post-turnover value through their effect on item states (what got consolidated, which evidence accumulated); the cap delimits only the layout-specific stream. Cross-window value flows through the Bellman state, not through this render's FV.

**Emergent schedule, not a guard:** T\* shrinks as the window fills, so late-window turns stop paving by arithmetic — as T\* → 0 the harvest an investment can book → 0. The invest-early/harvest-late non-stationarity is a theorem of the cap, and the always-pave pathology is excluded structurally. A session-history-derived cap was considered (2n doubling/Copernican) and withdrawn in favor of T\*; no session-length fitting ships.

**Reporting:** T\* is reported as a distribution, not a point. Investment decisions use the pessimile (wasted write = lump-sum loss; foregone reads = dribbles — the asymmetry ruled in session). Optional refinement once `churnProfile` exists: aggregate layout-hazard (a mutating foundational block forces a prefix rewrite) is a competing risk that shortens T\* — this finally prices the fifth open thread from the solver review (foundational items passing `zoneOfDyn` unchallenged).

### 6. Retired machinery

Each addition names what it subsumes; retirement happens at implementation, and this table is the contract:

| Addition | Retires |
| --- | --- |
| `refEvidence` (λᵢ) | kind-profiles-as-value; Δt as the sole value separator |
| `recoverability` (two-class) | flat fidelityPenalty; qLossy applied to content-preserving consolidation |
| `churnProfile` | conflated decay in the FV stream; watcher-local hazard monopoly |
| `forecastVariance` | `hysteresisMargin`; re-entry margins (as risk pricing) |
| layout moves + continuation pricing | keep-branch / prefix-preserving-sort / tail-relief / zoneOfDyn as *special cases* (they become provable properties of the sequence objective, not four patches) |
| suffix-liability trend | spot `transactionCost` on restructures |
| T\* caps | fixed `fv.horizon` constant; the 2n session-age proposal |

ALWAYS_HELD plus tombstone preference in solver code (noted in the solver review as policy-in-code) remains a standing violation of the option-space-carries-the-policy principle; the sequence objective is the occasion to move both into the option space.

### 7. Falsification

The efficiency thesis (better prices → fewer dead bytes, fewer wrong drops, legalized compaction, principled stickiness) is falsifiable and must be given the chance to fail. **Gauges first, properties second:** instrument the ledger before shipping §2, so the property work earns itself against numbers:

- flips per 100 turns (representation churn; expect down)
- re-expansions per eviction (wrong-drop detector; expect down)
- believed-hit ratio (baseline 77% from the emergence pass; expect up)
- tokens-at-delivered-value (dead-byte measure; expect down)
- write-to-harvest conversion: cached tokens actually read per deliberate invalidation (ADR-0003 report 5 extension; if invalidations continue while conversion trends to zero, §4's pathology is live and the refit pipeline is flagged)

Cold start is acknowledged: new items fall back to kind priors — no worse than today; gains accrue with session age, which is the over-time half of the founding problem. Calibration risk is acknowledged: confidently wrong posteriors would be worse than flat priors, which is why §2.4 (variance) ships with §2.1 (evidence), not after it.

### 8. Consequences

- `ContextItem` schema extension and `ParamSet` changes (ρ stays; `fv.horizon` becomes cap semantics) are implementation work under this amendment's contract.
- The per-item H-horizon DP over representation states (options × decay clock × hazard, coupled through ρ and the suffix) is the ruled implementation vehicle for §4–§5 pricing; the FV stream is the hold-forever value of that DP, which is why this decomposition is tractable. A formulation note accompanies implementation.
- Hibernation agrees by construction: turn count (hence horizon) survives restore while the cache is cold — a long-lived session waking with an empty cache and a long horizon chooses the long-run layout on its first forced write.
- Session-length survival fitting is explicitly **not** ruled out forever — it is ruled out *as the horizon mechanism*; if T\* proves systematically biased (windows turning over far from prediction), the ledger's turnover records are the corpus that would justify revisiting.
- **The punchline is the algorithm, not just the parameters.** The parameter/schema work of §2 and the caps of §5 are prerequisites, but the destination this amendment rules is the sequence objective itself: layout moves priced by continuation value with exact, position-indexed suffix accounting, replacing four patches with one represented structure (§6 table). The patched-myopic core is a transitional state, not a final one. Delivery is phased so each stage is independently falsifiable per §7 — gauges (phase 0) → properties, additive (phase 1) → pricing switch (phase 2) → sequence objective (phase 3) — but phase 3 is in scope by this ruling, not deferred indefinitely.

### 9. Open questions

- Exact posterior family for λᵢ (Beta-Bernoulli suggested; conjugacy vs. accessClass weighting trade-off).
- Whether `velocity`'s UI/debug value justifies a derived view or deletion outright.
- The pessimile's quantile for investment decisions (p20? calibrated from ledger turnover records once they exist).
- Exact computation of the cheapest break-set bill (§4): true suffix accounting over a chosen layout is a set-cover-like combinatorial object; what approximation (leftmost-break? iterative?) is honest enough at v1 scale.

---

## Amendment note (2026-08-23) — prior-0 evidence semantics, owner rulings

A-M5 was resolved by owner ruling in three parts, closing the defect where
`HAZARD_PRIORS_V1[kind] = 0` silently served two different claims (hazard
"never changes" vs re-reference prior "never referenced again"):

1. **Prior-0 kinds are evidence-NEUTRAL** at every pricing layer. Access
   evidence never rescales their value (the prior<=0 branch in
   `evidenceValueFactor` — dead subexpression `Math.max(KAPPA*0.05, 1)` —
   quartered value on first access) and never perturbs their hysteresis
   margin (`effectiveHysteresis` now returns the param margin for prior-0
   kinds unless a `forecastVariance` is deliberately stamped). Promotion
   stays deliberate: `ctx.promote` (0002g); searches journal, never
   auto-price (0002h).
2. **Identity is ANCHORED** — immune to recall AND age, structurally:
   `decayExempt: true` on the identity profile, not alpha-arithmetic, so a
   per-model refit cannot silently re-price the anchor.
3. **Errors are sticky-until-resolved** (state-based, not time-based):
   `floorWhileUnresolved` holds at any age while `resolvedTurn` is unset;
   `err.resolve` stamps it and the item glides out at episodic-speed decay.
4. **Episodic prior split deferred**: the re-reference prior stays 0 until
   B-5 live wiring supplies real access data for a deliberate calibration.

---

**Index** — line anchors as of this revision.

*Update this index whenever the file is edited.*

Sections:
- 1. The ruling — line 31
- 2. The revised property sheet — line 39
- 3. Two-class recoverability — line 63
- 4. Cache amortization: early invalidation as investment — line 71
- 5. The horizon cap: T* — line 83
- 6. Retired machinery — line 108
- 7. Falsification — line 124
- 8. Consequences — line 136
- 9. Open questions — line 144

Key points:
- Ruling: the solver is sequential in fact; properties, pricing, and horizons must let it decide over time — §1 — line 13
- Revised property sheet: four additions, two alterations, three removals; admission test stated — §2 — line 14
- Two-class recoverability: content-preserving consolidation is not discounted as lossy — §3 — line 15
- Early invalidation as investment: renewal framing, suffix-liability trend, anti-Zeno, TTL timing — §4 — line 16
- Horizon cap T*: decision-invariant; two caps; value flows through state, credit stops at turnover — §5 — line 17
- Retired machinery: each addition names the patch or parameter it subsumes — §6 — line 18
- Falsification: gauges wired before the properties; revert if the gauges do not move — §7 — line 19
