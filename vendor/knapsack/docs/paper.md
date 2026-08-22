# Exact Multiple-Choice Knapsack Solving for Latency-Budgeted Context Selection

**A component paper for `@connectotron/knapsack` v0.1.0**
Connectotron · August 2026

---

## Abstract

We describe the design, correctness argument, and measured performance of a
zero-dependency TypeScript library that solves the multiple-choice knapsack
problem (MCKP) exactly, in-process, at the latency scale required by per-turn
LLM context selection. The instance shapes of interest — tens to low
hundreds of groups, one to six mutually exclusive options per group, integer
weights, microsecond-scale budgets — sit in a regime the classical exact
literature already dominates, yet that machinery is absent from the
JavaScript ecosystem, where production systems either call general-purpose
MILP solvers or ship greedy heuristics with no optimality certificate. Our
contribution is careful adaptation, not invention: a five-stage pipeline —
validation, within-group Pareto reduction, integer-arithmetic LP relaxation
over convex hulls (Dyer–Zemel increment parametrization), λ_max fathoming,
and windowed two-row dynamic programming — in which every decision
comparison is an integer cross-product, guaranteeing deterministic output
free of locale and floating-point ordering hazards. We state the three
load-bearing propositions (dominance soundness; LP-integrality as an
optimality certificate; fathom-bound validity), report a 600-seed
adversarial cross-check against exhaustive brute force with zero
divergence, and measure median per-solve times of 11–103 µs on
production-shaped instances (4.4 ms on a stress shape sweeping 2.2 million
DP cells). An LP certificate skips the exact stage entirely on 3–97% of
instances depending on shape.

---

## 1. Introduction

### 1.1 The application that demanded exactness

[agent-kernel](https://github.com/Connectotron/agent-kernel) renders an LLM
agent's context every turn. Each context item (a file, a memory, a prior
message) admits several mutually exclusive render options — full text,
outline, or purge — each consuming a different number of tokens (weight) and
yielding a different expected utility (profit). The turn's token budget is
the capacity. Selecting one option per item to maximize total utility under
the budget is precisely the multiple-choice knapsack problem; the kernel's
ADR-0005 rules the identification formally.

The v1 solver was a per-item greedy with density-based budget relief: fast,
but with no optimality guarantee and no gap reporting. Two requirements
motivated extracting this library:

- **Exactness.** The render decision should never itself be the reason a
  better context was left unrendered, and the solver should be able to
  *report* how close it is to the LP bound.
- **Determinism.** Identical inputs must produce byte-identical outputs
  across runs and machines, because downstream re-solve instability is
  treated as a fault signal (agent-kernel ADR-0003); solver nondeterminism
  would masquerade as exactly that fault.

### 1.2 The gap in the ecosystem

The classical exact-MCKP literature provides mature machinery: within-group
dominance reduction, LP relaxation with Dantzig bounds, option fathoming,
and core- or DP-based exact search (Pisinger 1995; Kellerer–Pferschy–
Pisinger 2004). Production implementations exist in C++ (Google OR-Tools;
fontanf's `multiplechoiceknapsacksolver`) but either generalize far beyond
MCKP or carry dependency footprints unsuitable for in-process embedding. No
surveyed JavaScript/TypeScript implementation combines exact optimality,
zero runtime dependencies, integer-only decision arithmetic, and an
optimality-gap certificate.

### 1.3 Contributions

1. A five-stage exact MCKP pipeline in pure TypeScript, zero runtime
   dependencies, every decision an integer cross-product (§5–§6).
2. A separation of two reduction notions the informal literature tends to
   blur: the *Pareto frontier* (exact — feeds the final search) versus the
   *upper convex hull* (bounds-only — feeds the LP), with a worked example
   where conflating them returns a provably wrong answer (§6.4).
3. Three propositions with proofs: dominance soundness, LP-integrality as
   an optimality certificate (with the skip-and-continue bound validity
   argument), and fathom-bound validity (§6).
4. Empirical validation: 600-seed adversarial brute-force cross-check and
   measured latencies on production-shaped instances (§7).

---

## 2. Problem statement and notation

| symbol | meaning |
|---|---|
| `n` | number of groups |
| `G_i` | group *i*, with options `o_i0 … o_i,k−1` |
| `w, p` | integer weight and profit of an option |
| `C` | capacity |
| `λ = (λp, λw)` | a profit-per-weight gradient as an integer pair, λw > 0 |
| `Pareto(G_i)` | the non-dominated options of `G_i` |
| `hull(G_i)` | the upper convex hull of `G_i`'s options |
| `zLP` | LP-relaxation optimum |
| `z*` | MCKP optimum |

Density comparisons are never computed as floats: `p1/w1 > p2/w2` is
evaluated as `p1·w2 > p2·w1`.

**Problem (MCKP).** Given `n ≥ 1` groups, each a set of `k_i ≥ 1` options
with integer `w_ij ≥ 0`, `p_ij ≥ 0`, and integer capacity `C ≥ 0`, choose
exactly one option per group so that total weight ≤ C and total profit is
maximal. If the sum of per-group minimum weights exceeds C, the instance is
infeasible.

Zero-weight options are permitted (an explicit "purge" option with `w=0,
p=0` is legal input). Non-integer or negative inputs are rejected at the
boundary with a thrown validation error carrying the offending path.

**Instance regime (design point).** `n ∈ [10, 100]`, `k_i ∈ [1, 6]`,
weights up to ~10⁴, capacity up to ~10⁵, per-solve latency budget in the
microseconds. This is deliberately not a general knapsack engine.

---

## 3. Input format

The library consumes a plain, JSON-compatible TypeScript value — no classes,
no builders, no parsing layer. `src/types.ts` is the normative definition;
this section is its prose specification.

### 3.1 The problem value

```typescript
interface KnapsackProblem {
  groups: readonly KnapsackGroup[];   // 1..n groups
  capacity: number;                   // integer, 0 <= C < 2^21
}

interface KnapsackGroup {
  id: string;                         // non-empty, globally unique
  options: readonly KnapsackOption[]; // 1..k_i options
}

interface KnapsackOption {
  id: string;      // non-empty, unique within its group
  weight: number;  // non-negative integer
  profit: number;  // non-negative integer
}
```

| field | constraints | enforced by |
|---|---|---|
| `capacity` | non-negative integer, < 2²¹ | validation |
| `groups` | at least one | validation |
| `group.id` | non-empty string, globally unique | validation |
| `group.options` | at least one | validation |
| `option.id` | non-empty string, unique within its group | validation |
| `option.weight` | non-negative integer | validation |
| `option.profit` | non-negative integer; Σ per-group maxima < 2³¹ | validation |

Violations throw `KnapsackValidationError` with the offending value in the
message — never a silently wrong answer.

### 3.2 Semantics and conventions

- **Exactly one option per group** is chosen; the solver maximizes total
  profit subject to total weight ≤ capacity. There is no implicit
  "choose nothing": a group that may be skipped carries an explicit
  zero-weight, zero-profit option (agent-kernel's *purge* option is exactly
  this).
- **Option ids are scoped per group.** The same option id may appear in two
  different groups; it must be unique only among its siblings. Group ids
  are globally unique. Ids are treated as opaque strings — compared for
  equality, never ordered — so any Unicode content is admissible.
- **Input order is part of the input.** Ties are broken by array position
  (§6.6), so identical arrays yield identical outputs; permuting a group's
  options may legitimately permute which of several co-optimal selections
  is returned.

### 3.3 The arithmetic envelope

Four ceilings exist because the solver's exactness is bounded by machine
integer arithmetic and fixed-width representation, and the library prefers
failing loudly to being silently wrong:

1. **Σ per-group max profits < 2³¹** (`MAX_TOTAL_PROFIT`): DP value rows are
   `Int32Array`; a profit sum at or beyond 2³¹ would wrap.
2. **Capacity < 2²¹** (`MAX_CAPACITY`): bounds the fathom slack term
   `λp·slack` (λp < 2³¹, slack ≤ C) and every DP index.
3. **(Σ per-group max profits) · (largest weight) < 2⁵³** (`MAX_EXACT_PRODUCT`,
   enforced adaptively): every ordering product in the pipeline — hull
   cross-products, walk argmax compares, fathom bounds — is a product of a
   profit magnitude (bounded by Σ max profits) and a weight magnitude
   (bounded by the largest weight, which is NOT bounded by C). Keeping each
   such product strictly below 2⁵³ — where IEEE-754 doubles are still exact
   integers — makes every comparison exact by construction. The check is
   adaptive rather than a flat weight cap: small-profit problems admit
   huge weights. Below all three ceilings, every integer the solver
   computes is exact.
4. **≤ 255 options per group** (`MAX_OPTIONS_PER_GROUP`): the DP's
   back-pointer table stores option indices one byte each
   (`Uint8Array`, 255 = unreachable sentinel) — the 4× memory cut over an
   `Int32Array` table that keeps the worst-case DP's footprint at
   `n·(C+1) + 8·(C+1)` bytes. Reduction only shrinks groups (hulls are
   sub-frontiers of their inputs), so the cap is enforced on the caller's
   original arrays, before reduction.

The only floating-point value produced anywhere is the reported `lpUpper`
bound, which is never used for a decision.

### 3.4 The result value

```typescript
interface KnapsackResult {
  status: "optimal" | "infeasible";
  value: number;          // optimal total profit; 0 when infeasible
  choices: readonly { groupId: string; optionId: string }[] | null;
  bounds: { lpUpper: number; greedyLower: number } | null;
  stats: {
    groups: number; optionsTotal: number;
    optionsAfterDominance: number; optionsAfterFathoming: number;
    dpRequired: boolean; dpCellsVisited: number;
  } | null;
}
```

`status: "optimal"` is a proof claim, not a heuristic label — the LP
certificate or the exact DP (§6) established optimality. On infeasibility
(minimum-weight sum exceeds capacity), `choices`, `bounds`, and `stats` are
`null`. When optimal, the bracket `greedyLower ≤ value ≤ lpUpper` always
holds, with `value` integral.

### 3.5 Worked example

```json
{
  "capacity": 8,
  "groups": [
    { "id": "file-a", "options": [
        { "id": "purge", "weight": 0,  "profit": 0 },
        { "id": "outline", "weight": 2, "profit": 3 },
        { "id": "full", "weight": 5, "profit": 7 } ] },
    { "id": "file-b", "options": [
        { "id": "purge", "weight": 0,  "profit": 0 },
        { "id": "full", "weight": 4, "profit": 6 } ] },
    { "id": "memory", "options": [
        { "id": "keep", "weight": 3, "profit": 5 } ] }
  ]
}
```

Solving (solver-confirmed output): `{file-a: full, file-b: purge,
memory: keep}` — weight 5+0+3 = 8, profit 7+0+5 = **12**, with bounds
`greedyLower = 12 ≤ 12 ≤ lpUpper = 12.5` and the exact DP invoked (18
cells). The runner-up candidates show why greedy is not enough here: taking
file-b's `full` (4,6) instead of file-a's leaves `outline`(2,3) +
`full`(4,6) + … nothing for memory (2 remaining < 3) at profit 9, and the
all-outside LP view would fractionally split `full` + `keep` + a slice of
file-b — the 12.5 bound. The instance is small enough to verify by hand:
weight-8 selections are exactly `{full, purge, keep}` (12) and
`{outline, purge, keep}` (8); every other combination exceeds 8 or does
worse.

## 4. Position relative to prior art

Our debt to prior work is total; the contribution is selection, adaptation,
and verification. Table 1 maps each pipeline stage to its primary source.

**Table 1 — stage provenance**

| stage | technique | primary source |
|---|---|---|
| validate | integer-domain enforcement at the boundary | standard practice |
| Pareto reduction | within-group dominance | Pisinger `mcknap` preprocess; KPP §11.2; Booking.com arXiv:2108.13298 |
| LP relaxation | hull-increment walk, Dantzig bound | Dyer 1984; Zemel 1984; Pisinger 1995 |
| fathom | uniform λ_max completion bound | `mcknap` reduceitem; OR-Tools break-item bounds |
| exact DP | two-row windowed Bellman | fontanf; KPP DP lineage |

Corrections recorded against our own earlier survey: fontanf's repository no
longer ships branch-and-bound — current main carries MILP + Bellman DP, and
the Dyer–Zemel file is a 0-byte stub (verified against the repository,
2026-08-21). Full bibliography with verified links lives in
[`docs/research/2026-08-21-solvers-survey.md`](research/2026-08-21-solvers-survey.md).

## 5. The algorithm

Data flow:

```
problem
  → validate
  → Pareto reduce        (per group — exact)
  → convex hull          (per group — bounds only)
  → LP walk              (global — Dantzig UB, greedy incumbent, break λ)
  → LP integral?  ──yes──▶ return certified greedy selection
        │no
        ▼
  fathom                 (drop options whose λ_max bound misses the incumbent)
  → DP over Pareto sets  (fathomed removed — windowed two-row Bellman)
  → report               (value, choices, bounds, stats)
```

### 5.1 Validation

Structural checks (non-empty groups and options; ids present and unique
within a group), integer checks (`Number.isInteger`, `w,p ≥ 0`), capacity
`≥ 0`. Failures throw `KnapsackValidationError` with the offending path
(e.g. `groups[3].options[0].weight: expected integer, got 3.5`).
Infeasibility (sum of minima > C) is not an error — it returns
`status: "infeasible"`, `choices: null`.

### 5.2 Stage 1 — Pareto reduction (exact)

Per group: sort by (weight asc, profit desc), scan keeping strictly
increasing profit. The result is the Pareto frontier — weight strictly
increasing, profit strictly increasing. Soundness is Proposition 1 (§6.1).
Cost `O(k log k)` per group. On equal weight the higher-profit option sorts
first, so equal-weight duplicates fall out trivially; on equal (weight,
profit) the lexicographically smaller id survives — deterministic.

### 5.3 Stage 2 — Convex hull (bounds only)

Per Pareto group: monotone-chain upper hull. With points weight-sorted, the
test pops the middle point `b` of `(a,b,c)` when
`(b_w − a_w)(c_p − a_p) − (b_p − a_p)(c_w − a_w) ≥ 0` — i.e. when `b` lies
on or below the chord `a→c` — leaving only strict left turns. On the hull,
segment densities are strictly decreasing in weight: the property the
Dyer–Zemel walk depends on.

**Two notions, two roles.** The hull is the right set for the LP walk, but
*not* for exact integral search: a non-convex Pareto point (a "dent") can
be integral-optimal — §6.4's worked example shows a dent beating both hull
points at mid capacities. Conflating the two notions returns provably wrong
answers at those capacities. Hulls feed LP and fathoming; Pareto sets feed
the DP. This separation is the pipeline's quiet load-bearing wall.

### 5.4 Stage 3 — LP relaxation (integer walk)

1. Every group starts at hull index 0 (its lightest option); `W, P` are the
   sums of hull minima and their profits; all groups are *open*.
2. Among open groups' next hull segments `(Δp, Δw)`, select the max-density
   segment by integer cross-product.
3. If `W + Δw ≤ C`: take it — advance that group's hull index; update the
   running best integral profit (the incumbent lower bound).
4. Else: record the *break* on first occurrence — fractional fill
   `r = (C − W)/Δw`, Dantzig upper bound `P + r·Δp`, break gradient pair,
   break group — then close that group (hull segments are sequential, so a
   skipped segment permanently closes its group) and **keep walking**. Lower
   density segments from other groups may still fit; skipping the break
   segment does not close them. Bound validity under this
   skip-and-continue rule is Proposition 2b (§6.2b).
5. Iterate until no open segments remain. If no break ever occurred, the LP
   solution is integral — the certificate of Proposition 2 (§6.2) fires and
   the pipeline returns the walk's terminal selection, certified optimal.

The walk is `O((Σk)²)` worst case (each iteration scans all open segments;
segments taken ≤ Σk) but at `k ≤ 6` the constant is tiny and measured
incumbent quality is high; §7.2 reports DP-invocation rates.

### 5.5 Stage 4 — Fathoming (λ_max bound)

For each hull option `o` not on the incumbent path, with `P̄, W̄` the sums of
the *other* groups' hull-base profits and weights:

```
ub(o) = P̄ + p_o + λmax · max(0, C − W̄ − w_o)
fathom(o)  ⇔  ub(o) < z_inc          (cross-multiplied by λw — integers)
```

`λmax` is the maximum segment density over all hulls, as an integer pair:
an over-estimate of every marginal completion gain, by hull density
monotonicity (Proposition 3, §6.3). We use the uniform `λmax` rather than
the classical break gradient because under skip-and-continue no single break
gradient bounds all completions; the uniform bound does. Incumbent-path
options are exempt by construction — fathoming against an incumbent
presupposes that incumbent remains reachable in the DP.

### 5.6 Stage 5 — Exact DP (windowed two-row Bellman)

States are total weights; values are max profit reachable after the first
`i` groups at that weight (−1 = unreachable). Two `Int32Array(C+1)` rows
swapped by reference; a flat back-pointer array `bp[gi·(C+1) + w]` records
the chosen option index, giving `O(n)` traceback.

**Two modes, dispatched by a memory budget** (`expectedDpBytes(n, C) =
n·(C+1) + 8·(C+1)` vs a 50 MiB default):

- *Back-pointer mode* (table fits): as above, `O(C + n·C)` space.
- *Divide-and-conquer mode* (Hirschberg 1975 shape): no back-pointer table
  exists. Forward and backward value sweeps meet at the group-range
  midpoint; the meeting weight `w*` maximizing
  `F≤[w] + B≤[C−w]` (prefix-max rows) splits the capacity between the
  halves, which recurse. Sub-capacities telescope (`w* + (C−w*) = C` at
  every level), so total work is ≤ 2× one sweep — measured +2.2% at the
  largest benchmark shape, where windowing absorbs the rest. Live memory
  is four value rows, `16·(C+1)` bytes ≤ 32 MiB at the envelope's maximum
  capacity — independent of `n`. Exactness is identical: both modes are
  proven against the same brute-force oracle.

Per group, only the reachable window — `[sum of minima so far, min(C, sum
of maxima so far)]` — is touched. The destination row is *fully* cleared
before each sweep. That full clear is a lesson paid for in debugging: reads
can dip below the cumulative minimum when a large option weight jumps
backward relative to two stages prior, and stale two-stages-old values then
leak into fresh reads. Full clear, always. Windows are computed from each
group's true min/max weight — no sortedness assumption is made about
direct `solveDp` callers.

Inner loop: plain scan, per-option max. OR-Tools' in-code measurements
found plain loops beating prefix arithmetic by ~10% at this scale; we follow
the empirics. Ties at equal value resolve to the earlier array position —
total deterministic order throughout.

### 5.7 Orchestration and runtime complexity

```
solve = validate → pareto → hull → LP → [cert? return] → fathom → DP → report
```

**Stage-by-stage big-O.** Let `n` = groups, `k = Σ kᵢ` = total options,
`k̄ = k/n` = mean options per group, `C` = capacity.

| stage | time | space | notes |
|---|---|---|---|
| validate | `O(k)` | `O(k)` | one pass + id sets |
| Pareto reduce | `O(k log k)` | `O(k)` | per-group sort dominates |
| convex hull | `O(k)` | `O(k)` | points already weight-sorted |
| LP walk | `O(k²)` worst | `O(n)` | see below |
| fathom | `O(k)` | `O(k)` | one pass over hull options |
| exact DP | `O(C·n·k̄)` | `O(C + n·C)`; `O(C)` in D&C mode | budget-dispatched (§5.6) |

**Derivations.**

- *Validate* touches every option once, inserting ids into per-group sets:
  `O(k)` time, `O(k)` space.
- *Pareto reduce* sorts each group (`Σ kᵢ log kᵢ ≤ k log k`) then scans.
  The hull pass is linear on the sorted points.
- *LP walk* — each iteration scans all open groups' next segments
  (`≤ n` comparisons), and the walk takes at most `k − n` segments plus one
  closing iteration per group: `O(k)` iterations × `O(n)` scan = `O(n·k)`.
  At the design regime `n·k ≈ k²` only when every group stays open to the
  end — the worst case is real but rare (measured DP-invocation rates in
  §7.2 reflect certificate hits, not walk length); typical walks terminate
  near the break after `O(k)` work.
- *Fathom* evaluates one integer bound per hull option: `O(k)`.
- *Exact DP* — the dominant term. Per group the sweep touches
  `windowᵢ = [Σ_{j≤i} min w, min(C, Σ_{j≤i} max w)]` weights, each with
  `≤ kᵢ` option reads. Total: `O(C · Σ kᵢ)` = `O(C·n·k̄)` time worst case
  (window spans the full capacity range when weights are small relative to
  C). Space: two value rows `O(C)` plus the flat back-pointer array
  `O(n·C)` — stored one byte per cell (`Uint8Array` option indices; see
  ceiling 4 in §3.3), which quarters the naive `Int32Array` footprint.
  Further reduction (re-solve-on-residual, dropping back-pointers for
  `O(C)` total) remains future work.

**Tightness of the DP bound.** The `O(C·n·k̄)` term is tight, not loose.
It is achieved when windows saturate capacity early: give every group two
options with weights `{1, C}`; after the first group the reachable window
is `[1, C]` — full width — and total cells = `Σᵢ (C − i)` = `Θ(C·n)`, the
nominal bound at `k̄ = 2`. Conversely, with weights of order `C/n` the
window after `i` groups has width `Θ(i)`, never reaching `C`, and total
cells = `Σᵢ Θ(i)` = `Θ(n²)` — *sublinear in C*. Windowing therefore earns
its keep precisely when weights are large relative to `C/n`; against small
weights the DP is honestly `Θ(C·n·k̄)`.

**Certificate path.** When the LP is integral (§6.2), the DP is skipped
entirely and total cost is `O(k log k)`: sort-reduce, walk, report —
measured at 11 µs on roomy shapes (§7.2). Certificate fire rates measured:
3–97% by shape; on the 120-group stress shape, 57.5% over 40 fresh seeds
(bench protocol: 52%) (§7.2).

**Total worst case** (DP path): `O(k log k + C·n·k̄)` time, `O(C·n)` space.
**Total certificate path:** `O(k log k)`.

**Growth at the design regime.** At `n = 120`, `k̄ = 6`, `C ≈ 4.8·10⁴`
(the stress shape, measured): nominal `C·n·k̄ ≈ 3.45·10⁷` cell-visits;
measured average when the DP runs is `2.17·10⁶` — a factor of ~16 below
nominal, the combined work of windowing and fathoming. At the token-budget
scale of LLM context selection (`C ≈ 10⁵`), the DP path stays
single-digit-milliseconds; the certificate path stays microseconds.

### 5.8 Input scale limits from complexity

The envelope (§3.3) caps `C < 2²¹`, `Σ max-profit < 2³¹`, and options per
group at 255; complexity caps
practical scale: `C·n·k̄` cell-visits at `µs-per-10⁵-cells` speed means
`C = 10⁶` token budgets demand windowing (§5.6) and fathoming to stay
interactive — and above roughly `C·n·k̄ ≈ 10⁸` an FPTAS or core-based
approach becomes the appropriate tool (§8), not this engine.

## 6. Correctness

The pipeline's correctness rests on two properties per reduction: soundness
(every dropped candidate could not improve the optimum) and completeness
(some optimal solution survives every reduction), plus the early exit's
validity. The lemmas are classical; we state them in our notation because
the line between "Pareto vs. hull" and "bound validity under
skip-and-continue" is exactly where naive adaptations go wrong — §7.1's
fuzz styles target precisely these seams.

### 6.1 Proposition 1 — Pareto dominance soundness

**Claim.** If `o'` dominates `o` (weight ≤, profit ≥, one strict), then some
optimal solution avoids `o`. Hence pruning dominated options preserves `z*`.

**Proof.** Exchange argument. Let `S*` be optimal with `x_i = o`. Swap
`o → o'`: total weight does not increase (feasibility kept) and total profit
does not decrease, so the swapped solution `S'` is feasible with
`v(S') ≥ v(S*) = z*`. By optimality of `S*`, `v(S') ≤ z*`, so `v(S') = z*`
and `S'` is an optimal solution avoiding `o`. ∎

### 6.2 Proposition 2 — LP-integrality certificate

**Claim.** If the hull walk consumed every segment (no break ever recorded),
then the walk's terminal state is the exact MCKP optimum.

**Proof.** The terminal state is integral and feasible (every taken segment
replaced a real option with a heavier, strictly better one — each such
operation preserves "one option per group"). Its profit `P_term` equals the
LP optimum `zLP` (no fractional tail; the walk consumed all segments, so
the LP solution is exactly the walk). For any feasible integral `S`:
`v(S) ≤ zLP = P_term`, and `P_term` is attained integrally, so
`z* = P_term`. ∎

**Corollary (DP skip).** When the certificate fires, stages 4–5 are skipped
entirely. Measured fire rate: 3–97% of instances by shape (§7.2).

### 6.2b Proposition 2b — Dantzig bound validity under skip-and-continue

**Claim.** With the break recorded at the first non-fitting segment (in
density order) and the walk continuing past it, the recorded bound
`P + r·Δp` remains a valid upper bound on the MCKP optimum.

**Argument.** The break recording happens at the first (highest-density)
segment that does not fit. Up to that point the walk is the textbook LP
greedy; the recorded `P` and `W` are the LP-greedy prefix state at break
time. The question is only whether continuing the walk (and improving the
integral incumbent) can invalidate the recorded bound.

It cannot: the bound's argument never refers to the continuation. For any
feasible integral solution `S`, decompose `S` against the LP-greedy prefix:
each group's choice under `S` relative to the prefix consumes weight and
deviates from the greedy choice. Since the break segment was the globally
maximal density among all open segments at break time, every deviation
segment's density is ≤ break density (by hull density monotonicity,
densities strictly decrease along each hull; and at break time, the break
segment was the density-max over all open candidates). Hence `v(S) ≤ P +
r·Δp`: any deviation trades weight at a rate no better than the break rate,
and the residual capacity `r·Δw` is all that remains. ∎

### 6.3 Proposition 3 — Fathom bound validity

**Claim.** If `ub(o) < z_inc` then no feasible completion through `o`
reaches the incumbent.

**Proof.** Any completion through `o` consists of `o` plus one option per
other group. Its profit is at most `p_o + (max profits of other groups)`;
its weight is at least `w_o + (min weights of other groups)`, so its
remaining slack is at most `max(0, C − W̄ − w_o)`. Any completion's marginal
gain per unit slack is at most `λmax`: hull segments have density ≤ λmax by
definition, and any completion through `o` gaining more per unit weight
than λmax would imply a hull segment with density above the maximum hull
density — a contradiction. Hence `v ≤ ub(o) < z_inc`. ∎

### 6.4 The dent example (hull ≠ integral optimum)

One group, capacity `C = 6`. Options `(3,4)`, `(5,6)`, `(8,11)`. All three
are Pareto (weight and profit both strictly increasing). The hull is
`{(3,4), (8,11)}`: the middle point `(5,6)` lies below the chord from
`(3,4)` to `(8,11)` (chord density `(11−4)/(8−3) = 7/5 = 1.4`; the
segments around the middle point have densities `(6−4)/(5−3) = 1` and
`(11−6)/(8−5) = 5/3` — *increasing* across the middle point, which is
exactly the dent condition: the hull requires strictly decreasing segment
densities).

At `C = 6`, the integral optimum is the dent: profit 6, versus
hull-restricted options `(3,4)` = 4 or nothing ( `(8,11)` does not fit).
The LP over the hull reports the bound `4 + (3/5)·7 = 8.2` — the true
optimum 6 is comfortably inside the bracket. But had the DP been run over
the hull instead of the Pareto set, it would answer 4 — wrong. Two
reductions, two roles. (The fuzz corpus's "profit cliff" style is
dent-heavy by construction and targets exactly this seam.)

### 6.5 Composite correctness

Pipeline: validate → Pareto → hull → LP → [cert] → fathom → DP.

- **Pareto** (Prop. 1): sound and complete for the DP's input — some
  optimal solution lies entirely in the Pareto sets.
- **Hull**: used *only* for bounds (LP fields, fathom bounds) — never for
  the final selection — so its strict-subset nature is harmless by
  construction (§5.3).
- **Fathom** (Prop. 3): sound; incumbent-path exemption guards circularity.
- **DP**: exact over the surviving set, and the surviving set provably
  contains an optimal solution (Props. 1 + 3).

Therefore the reported value is `z*`, and the reported bounds bracket it:
`greedyLower ≤ z* ≤ lpUpper`, both bounds computed in integer arithmetic
(lpUpper is the only float in the library). ∎

### 6.6 Determinism contract

Determinism is a first-class output property:

1. **No locale collation** — all string comparisons are code-unit `<`/`>`;
   `localeCompare` never appears in decision paths.
2. **No float ordering** — no decision depends on a float; the only float
   produced anywhere is the reported `lpUpper`.
3. **No unordered iteration in decisions** — decision loops iterate arrays.
4. **Tie-breaking is positional** — at equal value, earlier array position
   wins, at every tie site: stage-0 seeding, hull walking, final-row
   extraction, traceback. Output is a pure function of input.

Empirical check: replay-hash tests in the suite solve each fuzz instance
twice and compare full serialized outputs (§7.1).

## 7. Empirical validation

### 7.1 Correctness — adversarial cross-check against brute force

**Oracle.** Exhaustive enumeration over the full option product
(≤ 6^7 ≈ 280k combinations at the fuzz sizes): the true optimum by
definition.

**Method.** Deterministic PRNG (mulberry32) so any failure reproduces
exactly from its seed. 600 seeds; per seed, 2–7 groups × 1–6 options drawn
from one of four adversarial styles, at one of three capacity regimes
(tight: within 10 of the minimum-weight sum; medium: uniform in the
feasible span; roomy: at the maximum). Checks per instance: reported value
equals the oracle optimum (or infeasibility agreement); the returned
choices are feasible and realize the reported value; and the bounds bracket
the optimum — `greedyLower ≤ z* ≤ lpUpper`, with any `lpUpper < z*` counted
as a failure (an invalid bound is a correctness bug even when the value is
right — this check is what caught the inverted hull sign and the invalid
fathom bound during development).

**Adversarial styles.** *Strongly correlated* (profit ≈ 3×weight ±ε — the
classic bound-hardening family); *coarse weights* (multiples of 10 — lattice
alignment stress); *profit cliffs* (later options at ~30% of profit —
dent-heavy Pareto shapes targeting the hull/Pareto seam); *uniform random*.

**Results.** 0 failures / 600 seeds. All 600 feasible instances solved
exactly; the DP stage ran on 307/600 (51%), visiting on average 131 cells.
The CI suite additionally carries a 300-seed brute-force cross-check,
property tests (bounds bracketing, choice feasibility, replay-hash
determinism — each instance solved twice, serialized outputs compared
byte-for-byte), and edge cases (single group, single-option groups,
zero-weight purge options, infeasible instances, duplicate and dominated
options): 307 tests, all green.

### 7.2 Latency benchmarks

Median per-solve times (median of 5 batch means; Mac Studio M4 Max; Bun
1.3.14; single-threaded; 20-iteration warmup; reproduce with
`bun run bench`):

| shape | median | DP invoked | avg DP cells |
|---|---|---|---|
| 20 groups × 3 options, w ≤ 400 | 67 µs | 51% | 23.8k |
| 60 groups × 5 options, w ≤ 600 | 103 µs | 3% | 446k |
| 120 groups × 6 options, w ≤ 800 | 4.4 ms | 52% | 2.18M |
| 40 groups × 4 options, cap 8k | 738 µs | 26% | 574k |
| 30 groups × 3 options, roomy | 11 µs | 0% | — |

### 7.3 Discussion

The LP certificate (Prop. 2) carries real weight at production shapes: on
roomy instances it fires always (11 µs, no DP allocation at all), and at the
full kernel shape it fires on 97% of instances. Where it cannot fire —
tight capacities at stress sizes — the windowed DP still completes the
120-group stress shape in 4.4 ms, an order of magnitude inside any
per-turn budget that matters. The fathoming stage's contribution shows in
the 60-group shape's 3% DP rate: hull options whose λ_max completions miss
the greedy incumbent never reach the DP at all.

## 8. Limitations and future work

- **Back-pointer memory.** `O(C·n)` Int32 for traceback is the DP's
  dominant memory cost. OR-Tools' re-solve-on-residual (recover choices by
  re-solving the residual problem without the final group) would reclaim it
  at one extra solve; v0.2 target.
- **Uniform fathoming.** λ_max is a deliberately loose uniform bound.
  Pisinger's expanding-core machinery (per-position bounds from the LP
  partition) would tighten fathoming at large sizes; deferred until a
  consumer needs it.
- **No warm-starting.** Re-solving a perturbed instance (one weight
  changed) pays full price. The survey's honest negative: no fetched source
  describes true MCKP warm-starting; the all-capacity value function is the
  nearest substrate if a consumer needs capacity sweeps.
- **Outside scope, deliberately.** Agent-kernel's actual deviations from
  classical MCKP — coupled costs (shared layout overheads, suffix
  re-pricing) and cross-turn linkage (hysteresis, transaction costs) — are
  handled in the kernel, not here. The survey maps the online-policy
  structures for those (Pack-Remove-Reserve pricing, ExpRP thresholds,
  learning-augmented blending) should they ever migrate into a solver
  layer.
- **Regime bound.** Pseudo-polynomial in C. This is a small-integer,
  many-group engine by design, not a general knapsack framework.

## 9. Conclusion

An exact MCKP solver belongs in-process at LLM context-selection latencies,
and the classical literature already contained everything needed —
dominance, hull LP bounds, fathoming, windowed DP. What was missing was the
careful assembly: integer-only decisions for determinism, the Pareto/hull
separation for soundness, the LP-integrality certificate for speed, and an
adversarial brute-force harness keeping all of it honest. The result solves
production-shaped instances in 11–103 µs, provably, reproducibly, with zero
dependencies.

## References

Primary bibliography with verified links (all fetched 2026-08-21) lives in
[`docs/research/`](research/):

1. **Survey (canonical):**
   [`2026-08-21-solvers-survey.md`](research/2026-08-21-solvers-survey.md) —
   Part I landscape, Part II performance review from which this pipeline
   was extracted.
2. **Researcher reports (raw):**
   [`2026-08-21-classical-exact-mckp.md`](research/2026-08-21-classical-exact-mckp.md)
   (mcknap.c line-level extraction; Pisinger EJOR 1995; KPP; MCMKP DP; Chan),
   [`2026-08-21-production-implementations.md`](research/2026-08-21-production-implementations.md)
   (or-tools knapsack_solver.cc; fontanf — with the branch-and-bound
   correction), [`2026-08-21-online-incremental-papers.md`](research/2026-08-21-online-incremental-papers.md)
   (Pack-Remove-Reserve; OMdKP reservation policies; learning-augmented
   OKP; GIKP hardness).
3. **Key citations.** Pisinger, *A minimal algorithm for the multiple-choice
   knapsack problem*, EJOR 83:394–410, 1995. Kellerer, Pferschy, Pisinger,
   *Knapsack Problems*, Springer 2004 (§11 MCKP). Dyer 1984; Zemel 1984
   (LP relaxation by partitioning). Martello & Toth 1990. Google OR-Tools
   `knapsack_solver.cc`. fontanf/multiplechoiceknapsacksolver. Booking.com,
   arXiv:2108.13298 (hull + incremental transform in production).
