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
- **Online multidimensional knapsack** — Yang et al., ToMPECS, <https://groups.cs.umass.edu/wp-content/uploads/sites/3/2021/11/V5pomacs30-yang1.pdf>. Linear and exponential *reservation policies* (admission thresholds as functions of utilization) with proven competitive ratios; a matching lower bound. Directly implementable threshold structure if we ever run dual budgets (tokens AND turns).
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
| [fontanf/multiplechoiceknapsacksolver](https://github.com/fontanf/multiplechoiceknapsacksolver) | C++ | 2 | MCKP branch-and-bound. |
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

*(This section integrates findings from the sources above with a direct read of `src/optimizer/solver.ts`; see the companion analysis in the commit series.)*

*Part II is being prepared — findings from the classical-technique, implementation, and online-policy reviews land here.*
