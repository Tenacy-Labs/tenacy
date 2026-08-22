All seven sources read successfully (the UMass PDF is dead — 404, no Wayback snapshot — but I retrieved the identical paper from co-author Zeynali's mirror). Below is the extraction.

---

**1. ROI-Reasoning (OS-MCKP)** — https://arxiv.org/abs/2601.03822
**Variant:** Ordered Stochastic MCKP (budgeted LLM reasoning).
**Idea:** Each problem = a class; reasoning-effort levels = items; token budget = capacity. "Stochastic" = reward and cost unknown at decision time (reward revealed only after evaluation); "ordered" = problems processed in fixed order, so early decisions irreversibly constrain remaining budget. Their solution is *learned*, not a threshold/DP solver: Meta-Cognitive Fine-Tuning (predict a discrete cost level `<predicted_level>Level-k` before reasoning, with a Level-3 "skip, answer NA" refusal action) + Rationality-Aware RL (Dr. GRPO over whole exam trajectories under hard budget truncation).
**Implementable rule:** their predict-then-optimize baseline maps levels to centroid costs "ĉ(k): 128 if k=0, 384 if k=1, 768 if k=2," then sorts by ĉ ascending and "retains p_π(j) if Σ ĉ ≤ B."
**Relevance:** validates MCKP as the right formalism for token budgets; confirms model cost/utility estimates (our setting) need explicit abstention options per class; no closed-form allocator — the greedy-skip baseline is the portable part.

**2. Pack, Remove, Reserve (KnapResRem)** — https://arxiv.org/abs/2607.13955
**Variant:** online proportional knapsack; reserve item x at cost αx, remove packed y at cost βy.
**Idea:** Full characterization: three regimes in the (α,β) plane — reservation-dominant, removal-dominant, and a symbiosis region where combining both beats either alone. Optimal algorithm `Symb` = Phase 1 reserve everything while arrivals are small; Phase 2 pack greedily with an early-win eviction check.
**Implementable rules (quoted):** safety threshold "p_safe(r) := (f² − (1−α−αf)·r)/(1−βf)" (reserve while x < p_safe(r)); early-win test: pack x iff ∃P′⊆P, R′⊆R with "f + αr + β·(p−p′) ≤ p′ + r′ + x ≤ 1"; target fill "f(α,β) = min{ f̂, 1/2, 1−α }" where f̂ = [−(1+β)+√((1+β)²+4(1+α−β))]/(2(1+α−β)). Removal-only ratio: c(β) = φ if β=0; 2 if 0<β≤1/2; (1+β+√(β²+2β+5))/2 if β>1/2. Reservation-only: c(α)=2 for 0<α≤1/4, then (1+√(5−4α))/(2(1−α)), etc.
**Relevance:** exact formalization of switching costs (β = removal/eviction price) vs. holding costs (α = reservation): our hysteresis bonus is structurally the same — these formulas let us set admission thresholds given priced recourse instead of ad-hoc hysteresis.

**3. Generalized incremental knapsack** — https://arxiv.org/abs/2009.07248
**Variant:** multi-period, non-decreasing capacities W₁≤…≤W_T, item-and-time-dependent profits p_it, items stay once inserted.
**Idea:** Reformulate as single-machine sequencing: item profits depend on completion time C_π(i)=Σ prior weights, "ϕ_π(i) = max{p_{i,t} : W_t ≥ C_π(i)}." Split contributions into heavy vs. light per geometric weight interval; DP for heavy, Shmoys-Tardos LP for generalized assignment for light → (1/2−ε)-approx in polytime; a self-improving/boosting scheme yields a QPTAS, so not APX-hard.
**Implementable rule:** the sequencing reduction itself (order items, take best feasible insertion profit) is a cheap deterministic per-turn heuristic for capacity-growth.
**Relevance:** modest — proves even simplified multi-period knapsack is strongly NP-hard and needs DP+LP machinery; don't try exact multi-turn optimization per turn; approximate within-turn instead.

**4. OMdKP LinRP/ExpRP (most directly implementable)** — https://groups.cs.umass.edu/wp-content/uploads/sites/3/2021/11/V5pomacos30-yang1.pdf (dead; identical at https://ali-zeynali.github.io/CompetitiveAlgorithmsforOnlineMultidimensionalKnapsackProblems.pdf)
**Variant:** online multidimensional knapsack, unit values in [p_min,p_max], θ=p_max/p_min, α=C/C_min.
**Idea:** admission cost = increasing function of per-dimension utilization; admit iff value ≥ cost and space suffices.
**Exact rules (quoted):** LinRP: "z_{i,j} = (u_{i,j}/C_j)·√(θm)"; admit iff "v_i ≥ max_j z_{i−1,j}·√(2α_j/m)·w_{i,j}" — CR O(√(θα)). ExpRP: "z_{i,j} = (u_{i,j}/C_j)·log(θα_j)"; admit iff "v_i ≥ Σ_{j=1}^m (2^{z_{i−1,j}} − 1)·w_{i,j}" — CR ≤ max{12, 4log(θα)}+1 (ε→0), matching the Ω(log θα) lower bound; fractional ExpRP-F: max{8, 4log θα}+1.
**Relevance:** immediate fit. Our coupled costs (tokens + layout) = dimensions; utility estimates = v_i; thresholds are O(1) per item, deterministic, closed-form. Scarce dimensions get exponentially rising admission prices — a principled budget-pressure term.

**5. Learning-augmented OKP** — https://arxiv.org/abs/2406.18752
**Variant:** OKP with succinct predictions of the critical value v̂ (min unit value in the offline optimum).
**Idea:** Robust fallback = ZCL threshold algorithm (optimal, CR ln(U/L)+1 given unit-value bounds [L,U]). Prediction-based PP-a uses "reserve-while-greedy" (dynamically adjust reserved capacity from observed high-value items) → CR 1+min{1, ω̂}; interval prediction IPA → 2+ln(u/ℓ); both match lower bounds. Untrusted predictions blended via MIX: "c/λ-consistent and (ln(U/L)+1)/(1−λ)-robust," λ∈(0,1) trust parameter — near-Pareto-optimal.
**Relevance:** exactly our estimated-utility situation. Blend: follow the estimate with weight λ, keep the worst-case threshold as floor; performance degrades smoothly (λ knob) as estimates worsen. Also: only the *critical threshold* needs predicting, not per-item utilities.

**6. Online MCKP for promotions (Booking.com)** — https://arxiv.org/abs/2108.13298
**Variant:** true online MCKP, one class per customer, negative values/weights allowed.
**Idea:** Per class: (1) prune dominated + LP-dominated items (upper-left convex hull, O(|K|log|K|)); (2) sort by weight, convert to incremental (Δv, Δw) between adjacent dominant items (incremental efficiency monotonically decreasing); (3) efficiency angle θ_id = atan2(v,w) (with quadrant fixes for negatives); (4) maintain empirical efficiency-angle function f(θ) = cumulative average weight of past dominant items; pick the least-angle item above the threshold "θ*(i) = min_p{θ_p | f(θ_p) ≤ C/(|P|/i·(|U|−i+1))}". Achieves >99.7% of optimal impact at Booking.com scale.
**Relevance:** the per-class dominance-then-incremental transform is the classic O(n log n) MCKP preprocessing that collapses our per-turn classes cheaply; the angle trick handles negative estimates (our utility estimates can be negative); threshold calibrated from history = self-tuning budget.

**7. Random-order knapsack (brief)** — https://pmc.ncbi.nlm.nih.gov/articles/PMC8550732
**Variant:** online knapsack/GAP, uniform random permutation. **Headline:** run two algorithms "optimized for restricted item classes, sequentially" (large-item then small-item phase) plus a reduction to the 2-secretary problem → **1/6.65-competitive** (1/6.99 for GAP). Relevance: low — assumes irrevocable arrivals; our re-solve-per-turn with recourse is strictly easier.

---

**Summary for parent:** Read all 7 sources in full text (5 arXiv PDFs, PMC, and the Yang et al. POMACS paper from a live mirror since the given UMass URL now 404s with no Wayback archive — verified identical title/authors/venue). No files created. Most transferable to our per-turn MCKP with hysteresis and estimated utilities: **#4's ExpRP thresholds** (utilization-based admission prices, closed-form, O(1)/item, handles our coupled-cost dimensions), **#5's MIX blend** (trust-λ between utility estimates and a robust threshold floor), **#6's dominance+incremental-angle MCKP pipeline** (fast per-class reduction, tolerates negative estimates), and **#2's priced-recourse formulas** (principled treatment of switching/holding costs α, β rather than ad-hoc hysteresis bonuses).