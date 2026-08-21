# Knapsack Solvers — Survey & Performance Review

- **Kind:** research survey + implementation review
- **Date:** 2026-08-21
- **Related ADRs:** ADR-0005 (primary — the solver is a knapsack), ADR-0002b (utility terms), ADR-0004 (transaction costs / suffix re-pricing)
- **Provenance:** all links below were returned by live search/API retrieval on 2026-08-21. Star counts and citation counts are as-of that date. Nothing here is reconstructed from memory; items not re-verified this session are marked *unverified*.

**Why this exists.** ADR-0005 rules the per-turn solve a multiple-choice knapsack problem (MCKP): items are groups, render options are mutually-exclusive choices, tokens are weight, Λ is capacity, utility is value — with two deliberate deviations from classical independence: coupled costs (rot share from final layout, suffix re-pricing) and cross-turn linkage (hysteresis, transaction costs). This survey maps the literature and implementations onto that ruling, then (Part II) extracts the algorithmic and implementation efficiencies worth porting into `src/optimizer/solver.ts`.

---

## Part I — The Landscape

### 1. Foundational canon

- **Martello & Toth, *Knapsack Problems: Algorithms and Computer Implementations* (Wiley 1990)** — the classic text (6,500+ citations per Martello's own page, Dec 2024). **Free download** from Silvano Martello's site: <https://silvano333.github.io>. FORTRAN listings included; the DP and branch-and-bound cores every later solver descends from.
- **Kellerer, Pferschy & Pisinger, *Knapsack Problems* (Springer 2004)** — the modern reference; chapter PDFs (ToC at <https://hjemmesider.diku.dk/~pisinger/knapsack/toc.pdf>) are hosted on Pisinger's DIKU page. Covers MCKP, core algorithms, FPTAS theory in one place.
- **Pisinger's code archive** — <https://hjemmesider.diku.dk/~pisinger/codes.html>. The canonical C implementations:
  - `mcknap` — exact MCKP ("A minimal algorithm for the multiple-choice knapsack problem," EJOR 83:394–410, 1995). First core-based MCKP solver: LP relaxation solved by median search, upper/lower bounds from the LP solution, then DP over an expanding core if bounds don't meet.
  - `minknap` — minimal 0-1 solver (Oper. Res. 45:758–767, 1997); DP with enumerative bounds fathoming unpromising states; enumerates the smallest possible core.
  - `combo` — Martello–Pisinger–Toth hybrid (Mgmt. Sci. 45:414–424, 1999): valid inequalities from MTH + minknap's DP recursion, surrogate-relaxed back into the original problem.
- **Timothy M. Chan, "Approximation Schemes for 0-1 Knapsack"** — <https://tmc.web.engr.illinois.edu/knapsack_sosa.pdf>. The simplified modern FPTAS lineage via (min,+) function composition; the (1/ε)^2.4 variant. The lesson: the FPTAS machinery reduces to repeated `min{f ⊕ fᵢ, b}` compositions with rounding — implementable in a page of code.

### 2. MCKP-specific literature

- **Pisinger 1995** (above) — *the* MCKP paper for us: core concept, LP-guided bounds.
- **Core-based exact algorithm for the multidimensional MCKP** — INFORMS Journal on Computing 2020, <https://doi.org/10.1287/ijoc.2019.0909> (14 cites). MMKP = multiple choice AND multiple capacity dimensions.
- **Best-first search exact MMKP** — J. Combinatorial Optimization 2007, <https://doi.org/10.1007/s10878-006-9035-3> (87 cites). The most-cited exact MMKP branch-and-bound.
- **MCKP with setups** — Computers & Industrial Engineering 2023, <https://doi.org/10.1016/j.cie.2023.109818>. Fixed charge per *chosen class* — structurally adjacent to our per-kind overheads.
- **Chance-constrained MCKP (CCMCKP)** — random weights, distributionally robust reformulations: <https://arxiv.org/abs/2306.14690>. Directly relevant when token estimates are uncertain (they are — `estTokens` is an estimate).
- **Γ-robust discrete pricing as MCKP** — <https://arxiv.org/abs/2603.18653>. "Coupled robust constraint equivalent to a finite family of fixed-threshold MCKPs" — a reduction pattern for coupled variants like ours.
- **Multiobjectivization approaches** — <https://arxiv.org/abs/2311.08839> (2023), <https://arxiv.org/abs/1712.06723> (2017). Solve MCKP approximately by decomposing into subproblems — relevant if utility stays vector-valued pre-calibration (ADR-0005's demoted mean-variance layer).

### 3. Coupled & cross-turn variants (the ADR-0005 deviations)

- **Survey: online knapsack** — Böckenhauer et al., Discrete Applied Mathematics 2026, <https://www.sciencedirect.com/science/article/pii/S0166218X25004470> (9 cites). The entry point for everything below.
- **Generalized incremental knapsack** — Faenza et al., <https://arxiv.org/abs/2009.07248> (18 cites). Multi-period, non-decreasing capacities W₁≤…≤W_T, profit p_it depends on insertion time, items persist. The formal shape of "capacity grows across turns; holding has time structure."
- **Incremental knapsack approximation** — Della Croce, Pferschy et al., DAM 2019, <https://www.sciencedirect.com/science/article/pii/S0166218X1930099X> (19 cites). PTAS for IKP and restricted variants.
- **Pack, Remove, Reserve** — <https://arxiv.org/abs/2607.13955> (July 2026). Online proportional knapsack with *paid* recourse: reserve at cost αx, remove at cost βy. This is our hysteresis/transaction-cost structure analyzed as an online problem. Closest single paper to ADR-0005's cross-turn linkage.
- **Removable online knapsack + advice** — STACS 2024, <https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.STACS.2024.18> (9 cites); journal extension with limited recourse: <https://www.sciencedirect.com/science/article/pii/S0022000025000790>. How many advice bits buy what competitive ratio — a theory of "how much forecast quality the solver needs."
- **Online multidimensional knapsack** — Yang et al., ToMPECS/POMACS, <https://ali-zeynali.github.io/CompetitiveAlgorithmsforOnlineMultidimensionalKnapsackProblems.pdf> (the UMass hosting 404s as of 2026-08-21; co-author mirror verified identical). Linear and exponential *reservation policies* (admission thresholds as functions of utilization) with proven competitive ratios; a matching lower bound. Directly implementable threshold structure if we ever run dual budgets (tokens AND turns).
- **Secretary/random-order knapsack** — Babaioff et al.'s 1/(10e) original; improved by Albers & Godau (Algorithmica 2021, 43 cites, <https://pmc.ncbi.nlm.nih.gov/articles/PMC8550732>); 2026 hardness: knapsack secretary is *not* 1/e-competitive (<https://arxiv.org/abs/2607.24198>) and strictly harder than the secretary problem (<https://arxiv.org/abs/2607.22840>).
- **Optimal online multiple knapsack (removable)** — Bieńkowski et al., <https://d-nb.info/1366617762/34> (5 cites). Constant-competitive with removals — the "removal is cheap" end of the spectrum our transaction costs interpolate.
- **Learning-augmented online knapsack** — <https://arxiv.org/abs/2406.18752> (6 cites): consistency/robustness trade-offs when a prediction (read: our μ₀ estimates) guides a robust fallback; also AAAI 2025 "total weight information" variant, <https://doi.org/10.1609/aaai.v39i25.34875>. The principled frame for "utilities are model estimates, not oracles."

### 4. Knapsack × LLM inference (independent corroboration of ADR-0005)

- **ROI-Reasoning** — <https://arxiv.org/abs/2601.03822> (Jan 2026). Formalizes budgeted inference-time reasoning across tasks under a global token constraint as an **Ordered Stochastic MCKP**. Independent arrival at our exact framing; required reading for ADR-0005's related-work section.
- **Online constrained MCKP for promotions** — <https://arxiv.org/abs/2108.13298>. MCKP proper in an online budgeted setting.
- **SEER: knapsack exemplar selection for in-context QA** — <https://arxiv.org/abs/2310.06675>.
- **MMKP context selection for RAG** — <https://arxiv.org/abs/2604.10734> ("Self-Correcting RAG… MMKP Context Selection"). Multidimensional *multiple-choice* knapsack for context assembly — same family, different objective.
- **Bi-objective quality-cost for LM ensembles** — <https://arxiv.org/abs/2312.16119>; **budget-aware routing for long clinical text** — <https://arxiv.org/abs/2605.00336>.

### 5. Neural & learning-based solvers

- **Hertrich & Skutella, "Provably Good Solutions to the Knapsack Problem via Neural Networks of Bounded Size"** (AAAI 2021) — <https://researchonline.lse.ac.uk/id/eprint/123502/1/Provably_Good_Solutions_to_the_Knapsack_Problem_via_Neural_Networks_of_Bounded_Size.pdf>. Expressivity results: small networks can encode DP-quality knapsack solutions. The bridge between our DP and a learned value model.
- **RL for knapsack survey** (CMC 2025) — <https://www.techscience.com/cmc/v84n1/61726/html>. DQN/attention/transformer variants; honest about when they beat DP (rarely at our scale) and when they do not.
- Neural combinatorial optimization lineage (Bello et al. 2016, pointer networks) solved knapsack-to-optimal as a demo; modern implementations e.g. <https://github.com/rubensolozabal/BinPacking_Neural_Combinatorial_Optimization> (112★).

### 6. Open-source implementations (verified 2026-08-21)

**Industrial:**

| Project | Lang | Stars | What it is |
|---|---|---|---|
| [google/or-tools `KnapsackSolver`](https://developers.google.com/optimization/pack/knapsack) | C++ (+Python/Java/C#) | — | 0-1 & multidimensional; solver types: branch-and-bound (multidim B&B), DP, divide-and-conquer, plus MIP-backed (SCIP/XPRESS/CPLEX) variants. Source: <https://github.com/google/or-tools/blob/stable/ortools/algorithms/knapsack_solver.h>. MCKP itself is modeled via CP-SAT/MIP ([guide](https://developers.google.com/optimization/pack/multiple_knapsack)). |

**MCKP-specific (small but real):**

| Project | Lang | Stars | Notes |
|---|---|---|---|
| [jmyrberg/mknapsack](https://github.com/jmyrberg/mknapsack) | Fortran/Python | 49 | Classic knapsack routines wrapped for Python. |
| [tmarinkovic/multiple-choice-knapsack-problem](https://github.com/tmarinkovic/multiple-choice-knapsack-problem) | Java | 11 | MCKP implementations. |
| [podkop/MO-MC-knapsack](https://github.com/podkop/MO-MC-knapsack) | Python | 6 | *Multi-objective* MCKP via MILP solvers. |
| [compsust/KP-NILM](https://github.com/compsust/KP-NILM) | Python | 5 | Supervised NILM via MCKP. |
| [fontanf/multiplechoiceknapsacksolver](https://github.com/fontanf/multiplechoiceknapsacksolver) | C++ | 2 | MCKP via MILP + Bellman DP (branch-and-bound and the Dyer–Zemel route are no longer on main — `dyer_zemel.cpp` is an empty stub; corrected in Part II). |
| [chiara-volonnino/mckp](https://github.com/chiara-volonnino/mckp) | C++ | 2 | MCKP implementations. |

**Adjacent:** [merschformann/sardine-can](https://github.com/merschformann/sardine-can) (C#, 111★, 3D knapsack/bin packing), [dvdoug/BoxPacker](https://github.com/dvdoug/BoxPacker) (PHP, 658★, 4D packing), [dwave-examples/knapsack](https://github.com/dwave-examples/knapsack) (41★, quantum annealing), [je-suis-tm/recursion-and-dynamic-programming](https://github.com/je-suis-tm/recursion-and-dynamic-programming) (65★, includes multiple-choice KP in Julia/Python among many DP classics).

**Ecosystem trivia:** the most-starred GitHub repos named "knapsack" (550–658★) are CI test-suites splitters (KnapsackPro) and a PHP collection-pipeline library — the name has outlived its naming rights. *Unverified this session:* HiGHS/SCIP as MCKP-via-MIP engines (well-established, but not re-checked today); Rosetta Code has knapsack in many languages (per Wikipedia's link list).

### 7. Reading map for the ADR-0005 gaps

1. **Coupled costs (rot share, suffix re-pricing)** → Γ-robust MCKP's fixed-threshold family reduction (§2) is the closest reduction pattern; quadratic knapsack (QKP) is the classical home of value-coupling.
2. **Cross-turn linkage (hysteresis, transaction costs)** → Pack-Remove-Reserve (§3) prices exactly this structure; removable/advice results bound what forecasts are worth.
3. **Estimated (non-oracle) utilities** → learning-augmented frame (§3): consistency when the estimate is right, robustness when it is wrong.
4. **Token-weight uncertainty** → CCMCKP (§2).
5. **Budget growth across turns** → generalized incremental knapsack (§3).

---

## Part II — Performance Review: What to Steal

*Method: three parallel deep-read reviews (classical exact MCKP lineage incl. the full `mcknap.c` source; production implementations incl. the complete 1,460-line or-tools `knapsack_solver.cc` and fontanf's source tree; online-policy papers in full text) plus a direct line-level read of `src/optimizer/solver.ts`. Subagent reports preserved under `~/.hermes/profiles/robby/cache/delegation/subagent-summary-{0,1,2}-20260821_191353_*.txt`. All claims trace to fetched sources; negative results are reported as such.*

### II.1 Classical exact MCKP machinery (the `mcknap` lineage)

The payoff of Pisinger's line is that **exactness is cheap at our scale** — the machinery exists to make enumeration microscopic.

1. **Integer-determinant comparisons everywhere** — `mcknap.c` (`https://hjemmesider.diku.dk/~pisinger/mcknap.c`). Replace every slope/division comparison with `DET(p,w,dp,dw) = p·dw − w·dp ≥ 0`. Zero divisions, zero floating point: deterministic and exact by construction. *Port: trivially, everywhere we currently compare float densities.*
2. **O(n) LP relaxation via gradient-median partitioning** — Pisinger, EJOR 1995 (abstract: `https://www.sciencedirect.com/science/article/pii/037722179500015I`); Dyer '84/Zemel '84 prior art. Sample ≤15 classes (`MEDIMAX=15`), take the median gradient where each class's gradient pair is (max-profit item − min-weight item); project every option by determinant; if capacity lies between the extreme weight sums the direction is LP-optimal, else fix extremes, delete LP-dominated options, repeat. Yields the Dantzig upper bound, the break gradient, and the optimality gap — the exact quantities ADR-0005 wants reported. *Port: replaces sort+greedy bounding entirely.*
3. **Within-group dominance = upper convex-hull pruning** — `mcknap.c` `preprocess`/`domiitem`; book §11.2. Per class: find min-weight and max-profit options, delete any option dominated (weight ≥ but profit ≤), fix singleton classes and subtract their weight from capacity; keep only the strictly profit-increasing hull. During LP iterations: underfull ⇒ delete options with p ≤ LP-choice's p; overfull ⇒ delete w ≥ LP-choice's w. *Port: direct; at 1–6 options per group the hull pass is nearly free and shrinks everything downstream.* (Independently validated: the Booking.com production system, II.3 #5, opens with the identical hull transform.)
4. **Expanding core, lazily partially sorted** — `mcknap.c` `defineedges`/`partsort`/`checkinterval`. Each class contributes only its two edge gradients relative to the LP choice; two stacks sorted lazily — an interval is sorted only when the DP actually steps into it. Classes outside the core are never enumerated. At tens of groups the LP bound frequently equals the incumbent and the DP never starts at all.
5. **Pareto-list DP with merge-time dominance + two-sided gradient fathoming** — `mcknap.c` `multiply`/`merge`/`reduceset`/`findvect`; the `minknap` lineage ("enumerative bounds used to fathom unpromising states"). Merge each class's options into the partial-vector list dropping non-improving (p,w) *during* merge; sentinel max-weight entries replace bounds checks; fathom states with two-sided determinant bounds (`DET(p−z, w−c, pt, wt) ≥ 0`); binary search switching to linear scan under ~5 entries.
6. **Per-option reduction before the DP** — `mcknap.c` `reduceitem`: an option whose LP-completion bound (itself + break gradient) cannot beat the incumbent is cut before its class enters enumeration.
7. **Mixed-radix solution encoding** — `mcknap.c` `rotatesol`/`definesol`. The solution is one integer in mixed base (class sizes as radices); traceback by div/mod, no parent pointers. With core ≤ ~32 classes the product of radices stays far under 2⁵³ — safe in a plain JS number, no BigInt.
8. **All-capacity value function** — Furini/Ljubić/Sinnl MCMKP (`https://msinnl.github.io/pdfs/MCMKP-techreport.pdf`, Alg. 1) and Chan's f_I step-function view (`https://tmc.web.engr.illinois.edu/knapsack_sosa.pdf`): one DP sweep computes the value function for **every** capacity. Re-solves under perturbed Λ (or hysteresis-shifted utilities) then become lookups, not re-runs — the natural substrate for cross-turn structure and the still-open per-goal step-budget question. *Honest negative: none of the fetched sources describes true warm-starting of MCKP after small perturbations; the closest sourced facts are mcknap's `used`-flag re-solve rounds with tightened incumbent, and this value-function view.*

### II.2 Production-implementation tricks

**google/or-tools `knapsack_solver.cc`** (`https://raw.githubusercontent.com/google/or-tools/stable/ortools/algorithms/knapsack_solver.cc`):

- **Propagator per dimension**, each holding its own efficiency-sorted list and `consumed_capacity`; `IncrementalUpdate` applies/reverts an assignment to ALL propagators atomically and never stops mid-failure — state stays incremental and consistent. *Port: with one dimension this is just a small state object; the pattern matters if tokens + layout ever become two budgets — then aggregate bound = min over propagators.*
- **Greedy-break incumbent**: greedy fill in efficiency order yields lower bound + feasible snapshot for free at every node.
- **Integer-arithmetic break-item upper bound**: `max(rem·p/w, break_profit − overused·p_prev/w_prev)` in exact int arithmetic, overflow-checked (double fallback only past 61 MSBs). *Port: keep every bound integer; ceil form `(rem*p + w − 1)/w`.*
- **Prune before allocate**: compute bounds on a scratch node; only heap-allocate survivors. Best-first queue keyed on UB, tie-break to higher current profit.
- **Reduction pass**: per-item bound tests fix items outright; easy instances return without any search. *Port: per-group pairwise dominance is the even cheaper MCKP analogue.*
- **Measured in their comments** (worth trusting): bound caching wasn't worth it (~1/7 reuse); an O(depth) incremental loop beat O(1) prefix arithmetic by 10% in C++. Plain loops win — good news for JS.
- **DP solver**: 1-D array, descending capacity loop, **solution recovery by re-solving on the residual** instead of a parent table; D&C variant is Kellerer/Pferschy/Pisinger DP-2 — O(cap·n) time, O(cap+n) space, two rolling arrays.

**fontanf/multiplechoiceknapsacksolver** (`https://github.com/fontanf/multiplechoiceknapsacksolver`) — *correction to Part I §6: main no longer ships branch-and-bound; it ships MILP + Bellman DP, and `dyer_zemel.cpp` is an empty stub:*

- **Two-row Bellman DP over groups with reachable-weight windowing**: `values_prev`/`values_next`, each capacity+1 wide; per group iterate only weights in `[weight_min, min(cap, weight_sum)]` where `weight_sum` accumulates group maxima — unreachable states are never touched. *Port: this is our exact problem shape. `Int32Array(cap+1)` × 2, swap references not copies, inner loop `for w desc, for option: next[w] = max(next[w], prev[w−w_j]+p_j)`. Comfortably sub-millisecond at 100 groups × 6 options, allocation-free after setup, deterministic.*
- "-all" variant: full table with `state_id = (g+1)·(cap+1) + w` for backtracking — or skip the table with or-tools' re-solve-on-residual.

**jmyrberg/mknapsack** — wraps Martello–Toth FORTRAN 77 (MT1/MT2/MT1R/MTB2/MTU/MTM/MTHM/MTC2/MTCB/MTG/MTHG/MTP/MTSL); no MCKP routine, no performance notes. Literature pointer only; nothing in-loop for us.

**podkop/MO-MC-knapsack** — scalarization over CBC/Gurobi MILP; auto-creates per-class Σx=1 constraints; supports non-rectangular classes; normalizes coefficients to avoid numerical issues. Only crumb for us: *keep integers instead*.

### II.3 Online-policy structure (the ADR-0005 deviations)

1. **Pack, Remove, Reserve** (`https://arxiv.org/abs/2607.13955`) — online proportional knapsack with paid reservation (αx) and paid removal (βy). Full characterization: three regimes in the (α,β) plane; `Symb` = reserve-while-small then pack-with-eviction-check. Quoted formulas: safety threshold `p_safe(r) = (f² − (1−α−αf)·r)/(1−βf)`; early-win test `f + αr + β(p−p′) ≤ p′ + r′ + x ≤ 1`; target fill `f(α,β) = min{ f̂, 1/2, 1−α }` with `f̂ = [−(1+β)+√((1+β)²+4(1+α−β))]/(2(1+α−β))`; removal-only competitive ratio `c(β) = φ` if `β=0`, `2` if `0<β≤1/2`, `(1+β+√(β²+2β+5))/2` if `β>1/2`. *Relevance: β is our switch price and α our holding price — these formulas price recourse principledly where we currently use an ad-hoc hysteresis margin.*
2. **OMdKP reservation policies** (Yang, Zeynali, et al., POMACS/ToMPECS; the UMass URL 404s — identical paper at `https://ali-zeynali.github.io/CompetitiveAlgorithmsforOnlineMultidimensionalKnapsackProblems.pdf`) — admission cost rising with utilization. Quoted: LinRP `z_{i,j} = (u_{i,j}/C_j)·√(θm)`, admit iff `v_i ≥ max_j z_{i−1,j}·√(2α_j/m)·w_{i,j}`, CR O(√(θα)); **ExpRP** `z_{i,j} = (u_{i,j}/C_j)·log(θα_j)`, admit iff `v_i ≥ Σ_j (2^{z_{i−1,j}} − 1)·w_{i,j}`, CR ≤ max{12, 4·log(θα)}+1, matching the Ω(log θα) lower bound. *Port: closed-form, O(1)/item, deterministic admission prices; the scarce dimension gets exponentially rising prices — a principled budget-pressure term if tokens+layout become dual budgets.*
3. **Learning-augmented OKP** (`https://arxiv.org/abs/2406.18752`) — predictions of only the *critical threshold* v̂ (not per-item utilities); robust floor = ZCL threshold algorithm, CR ln(U/L)+1; MIX blending gives `c/λ`-consistent and `(ln(U/L)+1)/(1−λ)`-robust, λ ∈ (0,1) the trust knob. *Relevance: exactly our estimated-utility situation — follow μ₀ estimates with weight λ, keep the worst-case threshold as floor; degradation is smooth as estimates worsen.*
4. **Generalized incremental knapsack** (`https://arxiv.org/abs/2009.07248`) — sequencing reduction `ϕ_π(i) = max{p_{i,t} : W_t ≥ C_π(i)}`; heavy/light split → DP + LP → (1/2−ε)-approx, QPTAS; strongly NP-hard even simplified. *Lesson: do not attempt exact multi-turn optimization per turn — approximates within-turn. Independent validation of ADR-0005's per-turn decomposition.*
5. **Booking.com online constrained MCKP** (`https://arxiv.org/abs/2108.13298`) — per-class dominance (upper-left convex hull, O(|K| log |K|)), then the **incremental transform**: sort by weight, convert adjacent dominant options to (Δv, Δw) increments with monotonically decreasing efficiency; efficiency angle `θ = atan2(v,w)` with quadrant fixes for negatives; admission threshold calibrated from cumulative history. >99.7% of optimal at production scale. *Port: the dominance + incremental transform is the cheap per-turn preprocessing, and the angle formulation handles negative utility estimates — which ours can be.*
6. **ROI-Reasoning / OS-MCKP** (`https://arxiv.org/abs/2601.03822`) — their solver is *learned* (meta-cognitive fine-tuning + Dr. GRPO over trajectories), not a threshold/DP algorithm; the portable part is the predict-then-optimize baseline (levels → centroid costs, sort ascending, retain while Σĉ ≤ B) and the design point that each class needs an explicit abstention option (our purge/no-option already models this).

### II.4 Direct code-level findings in `src/optimizer/solver.ts`

From a line-level read of the shipped v1.1 solver (branch `feature/loop-milestone`):

1. **O(n²) ledger lookup** — `itemLedgers.find(...)` inside the placement loop (L149). Replace with a `Map` keyed at push time. At 100 items that is ~10⁴ comparisons per turn; the fix is free.
2. **`indexOf` in the sort comparator** — `ZONE_ORDER.indexOf(zoneOf(a))` (L108) re-evaluated O(n log n) times. Hoist with decorate-sort-undecorate (precompute zoneIndex per entry). Same for `zoneOf` re-calls.
3. **Full sort where a max scan would do** — `scored.sort()` (L72) only needs argmax + the incumbent option; a single O(k) pass suffices. Minor at k ≤ 6, but free.
4. **`localeCompare` tie-breaks (L72, L112) are a determinism hazard** — collation order varies by locale/ICU build; the repo's own ADR-0003 treats re-solve instability as a detection signal, and locale drift would masquerade as exactly that. Replace with code-unit `<`/`>` comparison.
5. **Budget-relief scan is O(n) per drop** (`worstDensityDroppable`) — fine at tens of items; a min-heap only earns its keep past ~10³ items. Leave as is; note for scale.
6. **Suffix-cost approximation** (L195): `incumbent.totalTokens − prev.position * 0` — the `·0` makes the "suffix" equal the entire incumbent total for every rewrite; conservative (over-bills rewrites early in the layout). A v1.2 refinement: carry token prefix-sums per position in the incumbent so `suffix = total − prefix[position−1]`, giving the PRR β-price a real per-item basis.
7. **Structural: the shipped solver is per-item greedy + hysteresis, not a joint MCKP solve** — each item independently argmaxes utility, then relief drops by density. The II.1/II.2 machinery (dominance prefilter → integer-determinant LP bound → two-row windowed DP) is the upgrade path to exact-with-gap-reporting: no dependencies, deterministic, sub-millisecond at our instance sizes.

### II.5 Ranked port list (effort → payoff)

1. **Within-group convex-hull dominance prefilter** (`mcknap` preprocess; Booking.com hull) — ~20 lines; shrinks every downstream step; also deletes dominated options before hysteresis even looks at them.
2. **Integer-determinant comparisons** replacing float density ratios — determinism and speed, no algorithmic change.
3. **Two-row `Int32Array` windowed Bellman DP** (fontanf shape, optionally + mcknap fathoming) — the exactness upgrade; report the gap against the Dantzig UB.
4. **O(n) median-partition LP relaxation** — supplies bound, gap, and break gradient in one pass; replaces sort-based greedy.
5. **Mechanical solver.ts fixes** — ledger `Map`, comparator hoisting, `localeCompare` purge, argmax scan (II.4 #1–4).
6. **All-capacity value function** — one sweep serves Λ-perturbation re-solves and any future per-goal step budget as lookups.
7. **ExpRP / MIX thresholds** — only if dual budgets or a trust knob on estimates get ruled in; formulas quoted in II.3.

**Honest negatives:** no fetched source describes true MCKP warm-starting after perturbations (value-function sweep + `used`-flag re-solve rounds are the closest); GIKP's hardness says exact multi-turn optimization is out of reach per turn; or-tools' own measurements say bound caching is not worth the complexity at small scale.
