# ADR-0005: Amendment II — the solver is a knapsack, not a portfolio

- **Status:** Accepted (amendment — re-characterizes the selection problem; never retro-edits accepted bodies)
- **Date:** 2026-08-21
- **Deciders:** Daniel Eisner (rulings), Robby (analysis)
- **Amends:** ADR-0002 (solver objective, by interpretation) · ADR-0002b (mean-variance framing, superseded in role)
- **Evidence:** `src/optimizer/solver.ts` as shipped at commit `266f93c` (PR #4); live-ledger analysis, 2026-08-21

---

**Summary.** The Decider ruled on the solver's true formal character: the per-turn selection problem is a **multiple-choice knapsack problem (MCKP)** over the option surface — not a mean-variance portfolio, and not gradient descent. Mean-variance is demoted from the selection layer to the value-estimation layer, pending calibration data. The ruling immediately confers one v1.1 refinement: budget relief must drop by worst **utility-per-token**, not lowest absolute utility.

**Key points**

- Ruling: the selection problem is a per-turn multiple-choice knapsack; greedy-with-hysteresis is the shipped heuristic — §1
- Formal statement: items are groups, render options are the choices, tokens are weight, Λ is capacity, utility is value — §2
- What v1 actually computes: per-item argmax, canonical zone layout, budget relief by lowest absolute utility — §3
- Disqualification of mean-variance at the selection layer: zero dispersion terms in the shipped solver; 0002b's framing was aspiration — §4
- Disqualification of gradient descent: decisions are discrete; no relaxation, no derivatives, no descent — §5
- Knapsack-plus: coupled costs (rot share, suffix re-pricing) and cross-turn linkage (hysteresis, transaction costs) violate classical independence — §6
- v1.1 refinement, ruled: density-aware budget relief — §7
- Consequences: optimality-gap reporting becomes available; thrash detection re-reads as re-solve instability — §8

*An index of sections and key points, with line anchors, appears at the end of this file. If you edit this file, update that index to match.*

## Context

After the loop milestone and the live wire (commit `266f93c`), the Decider examined the solver's actual selection logic against its ADR framing and observed: *"The solver problem we are trying to solve isn't really a mean variance analog; it's not a gradient descent even, right? It's really a knapsack problem?"*

Code inspection confirmed the observation in all three parts. This amendment records the ruling and its consequences. The house rule holds: accepted ADR bodies are never retro-edited; ADR-0002b's text stands as written, and its mean-variance framing is superseded **in role**, by this forward document.

## Decision

### 1. The ruling

The per-turn solver problem is re-characterized as a **multiple-choice knapsack problem** over the option surface. The shipped algorithm is the classic greedy heuristic for it, stabilized by hysteresis. Mean-variance optimization is demoted to the value-estimation layer, where it prices value *uncertainty* once calibration data exists; it does not describe the selection structure. Gradient descent does not apply at any layer of the selection problem.

### 2. Formal statement

Each context item is a **group**; the item's render options (ADR-0002d §4, ADR-0004 §5–6) are the mutually exclusive **choices** within that group. Choose at most one option per group. Each option has a **weight** (its token count) and a **value** (forecast item value net of cache transaction cost, fidelity penalty, and rot share). The budget Λ is the **capacity**. Maximize total utility of the chosen set subject to total tokens ≤ Λ, with ALWAYS_HELD kinds (identity, goal) as mandatory groups. This is MCKP, textbook (choice-structure knapsack; each group nonempty).

### 3. What v1 actually computes

Three phases, all greedy, all journaled:

1. **Per-item argmax** — every option scored (value − cache cost − fidelity − rot estimate); incumbent options held unless a challenger clears the hysteresis margin; new items must clear a re-entry margin unless ALWAYS_HELD.
2. **Zone layout** — canonical zone order; within zone, by value density then hazard; deterministic tie-breaking by id.
3. **Budget relief** — while total tokens exceed Λ, drop the lowest-absolute-utility droppable item. (Superseded for v1.1 by §7.)

Greedy MCKP heuristics do not guarantee optimality; that is accepted. Determinism, bounded cost, and full journaling were ruled more valuable than optimality at v1 scale.

### 4. Mean-variance: demoted, not deleted

The shipped solver contains **zero** variance, κ, or dispersion terms — every quantity is a point estimate (μ₀, α, hazard priors). ADR-0002b's portfolio framing described how value-estimate *uncertainty* should eventually be priced, not how selection is structured; that pricing belongs in the value layer (a risk penalty inside utility) and remains pending the calibration corpus that ADR-0003's reports are built to earn. When it arrives it will modify the **values** in the knapsack, never the selection structure.

### 5. Gradient descent: does not apply

The decision variables are discrete — render option X of item i, or not. There is no continuous relaxation anywhere in the loop, nothing to differentiate, no descent trajectory. Decay curves, rot curves, and cache pricing are continuous **inputs** to scoring, not objects of optimization.

### 6. Knapsack-plus: where the textbook model breaks

Two properties take the problem beyond classical MCKP, and both are load-bearing:

- **Coupled costs.** Rot share is computed from the *final* layout (suffix length, positional weights), and a rewrite re-prices the entire suffix after it. One item's utility depends on the whole chosen set and its arrangement — violating the independence of item values that classical knapsack assumes.
- **Cross-turn linkage.** Hysteresis margins and additive-vs-rewrite transaction costs (ADR-0004 §6) make each turn one stage of an **online** problem whose feasible region is constrained by the incumbent render. The per-turn knapsack is nested inside a sequential decision process.

The characterization is therefore: *per-turn MCKP with coupled costs and incumbent linkage, solved greedily with hysteresis.* The classical name remains the right anchor; the qualifiers are honest.

### 7. v1.1 refinement: density-aware budget relief

The ruling's immediate consequence. Current relief drops the lowest-absolute-utility item; two items with equal utility but 5 vs 500 tokens are treated alike, though dropping the 500-token item frees 100× the capacity for the same utility loss. **Ruled:** budget relief drops the droppable item with the worst **utility-per-token** (density). ALWAYS_HELD kinds remain exempt. The change is confined to the relief phase; phase-1 option selection and hysteresis are untouched.

**v1.2 amendment (2026-08-22, Daniel: "make the new solver library the default for the agent kernel").** Density relief is superseded as the default by exact-MCKP relief through `@connectotron/knapsack` (I1 Stage 2, PR #7). The same §7 formulation — one choice per droppable item: keep (current tokens, utility) / tombstone (handle tokens, 0) / evict (0, 0), capacity Λ minus held prefix — is solved exactly (Pareto dominance → LP bounds → fathoming → exact DP) instead of sequentially greedily. Exact dominates density by construction: the greedy sequence is a feasible point of the MCKP the solver optimizes over, so retained utility is ≥ greedy everywhere and strictly better on greedy-suboptimal instances (test-pinned). `"density"` remains selectable via `reliefMode` for A/B measurement and as fallback; the SCALE=1000 integer quantization on utilities (three decimals) is documented and ordering-stable at observed magnitudes.

### 8. Consequences

- The knapsack framing makes **optimality-gap reporting** available whenever wanted: the LP relaxation of MCKP gives an upper bound; the greedy result's gap to it is a journaled quality metric, reportable alongside ADR-0003's reports (a natural report 5 extension).
- ADR-0003 report 5's thrash detection re-reads cleanly as **re-solve instability** under incumbent linkage — accepted moves reversed within k turns. No change to the report; a sharper interpretation.
- ADR-0002b's title and body stand unchanged; documents that reference "mean-variance placement" should be read through this amendment (selection = knapsack; mean-variance = value-layer risk pricing, pending calibration).
- Refit (ADR-0003 §4) fits the *values* in the knapsack; it never restructures selection.
- Goal step-budgeting (max turns per goal) was discussed alongside this amendment and remains **open** — not ruled here; nothing ships until the Decider decides.
- **RESOLVED 2026-08-24 (Daniel ruling):** goals carry NO turn limit. Rationale: the solver already prices each turn's value; rot demotes dead ends; a hard cap would be an override in a signals-not-overrides architecture (ADR-0002g doctrine). A degenerate goal dies of unprofitability, not execution.

---

**Index** — line anchors as of this revision.

*Update this index whenever the file is edited.*

Sections:
- 1. The ruling — line 34
- 2. Formal statement (MCKP) — line 38
- 3. What v1 actually computes — line 42
- 4. Mean-variance: demoted, not deleted — line 52
- 5. Gradient descent: does not apply — line 56
- 6. Knapsack-plus: coupled costs and incumbent linkage — line 60
- 7. v1.1 refinement: density-aware budget relief — line 69
- 8. Consequences — line 73

Key points:
- Ruling: the selection problem is a per-turn multiple-choice knapsack; greedy-with-hysteresis is the shipped heuristic — §1 — line 15
- Formal statement: items are groups, options are choices, tokens are weight, Λ is capacity, utility is value — §2 — line 16
- What v1 computes: per-item argmax, canonical zone layout, relief by lowest absolute utility (§7 supersedes for v1.1) — §3 — line 17
- Mean-variance demoted to value layer; zero dispersion terms in shipped solver — §4 — line 18
- Gradient descent does not apply: discrete decisions, no relaxation — §5 — line 19
- Knapsack-plus: rot/suffix costs couple items; hysteresis links turns — §6 — line 20
- v1.1: budget relief drops worst utility-per-token — §7 — line 21
- Consequences: optimality-gap reporting available; goal step-budgeting remains open — §8 — line 22
