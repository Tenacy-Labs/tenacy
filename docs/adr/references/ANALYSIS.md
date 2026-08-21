# Literature Review — What the Field Validates, Warns, and Suggests for the ADR Corpus

> **Summary.** Deep read of the 29-entry bibliography (`references/`), 2026-08-21. The core bets of the
> optimizer design are independently validated by production systems (Manus) and published research
> (ACE, Context-Folding, governance-decay, Chroma, Anderson & Schooler). The literature also supplies
> concrete implementation gotchas — cache-accounting subtleties, tool-mutation costs, mimetic drift in
> uniform contexts, summarization confidence — and six proposed plan adjustments, which await ruling.
> No ADR body was modified.

> **Key points**
> - §1 — The optimizer-not-accumulator framing is externally confirmed; nobody else prices it end-to-end.
> - §2 — Ten reinforcements, from KV-cache economics to replay-as-learn-from-oracle.
> - §3 — Ten implementation warnings with their sources and the ADR each touches.
> - §4 — Six proposed adjustments (A1–A6), awaiting the Decider's ruling.
> - §5 — Synthesis: value density, not length, is the variable the field is arguing about; our objective is the arbiter.
> - §6 — Takeaways: the architecture holds; the risks are named; the loop-milestone checklist is sharpened.

*An index of sections and key points, with line anchors, appears at the end of this file. If you edit this file, update that index to match.*

## §1 Method and scope

Sources read in depth: Manus engineering post (full), ACE (ICLR 2026, incl. §2.2 limitations and §3
mechanisms), Memory-R1 (method + LoCoMo tables + latency), Zep (architecture through evaluation),
Chroma context-rot report (experimental design + results), Context-Folding (alphaxiv overview incl.
RL ablations), Letta memory blocks (full), Aider repomap (full), Anthropic prompt-caching and
context-editing docs (fetched whole, prior pass), plus search-verified summaries for ACON,
governance-decay, MemDecay, AbsenceBench, MemOS, SGLang RadixAttention, Hawkeye, Parrot, and
Anderson & Schooler 1991. Quotes below are verbatim from the fetched sources.

Verdict categories follow the ruling request: **reinforced** (external validation — keep going),
**keep in mind** (does not change the design; will bite during implementation), **adjust**
(proposed change to the plan, awaiting ruling).

## §2 What is reinforced

**R1. The cache economics are real, dominant, and currently hand-managed.**
Manus: "the KV-cache hit rate is the single most important metric for a production-stage AI agent,"
with a ~100:1 input:output ratio and a 10x price spread between cached and uncached input. Their
practices — stable prefixes, append-only context, explicit breakpoints — are hand-tuned special
cases of the priced placement our objective computes (ADR-0002b §5, ADR-0002e). We are formalizing
what production teams already believe; that is the right place for a kernel to stand.

**R2. Lossy in render, never in store.**
Manus: "any irreversible compression carries risk… you can't reliably predict which observation
might become critical ten steps later," solved by restorable compression — drop the webpage, keep
the URL; drop the document, keep the path. Zep's episode subgraph is the same principle as storage:
raw episodes are "a non-lossy data store from which semantic entities and relations are extracted."
This is ADR-0002f's journal-plus-expand, found independently twice.

**R3. Goals recited at the head.**
Manus's todo.md mechanism — constantly rewriting the plan "into the end of the context… avoiding
lost-in-the-middle issues and reducing goal misalignment" across ~50-tool-call tasks — is the
goals lens with a cheaper implementation. Governance-decay (2026) supplies the failure statistics:
compaction silently erases pinned safety constraints, and explicit pinning removes violations at no
utility cost. Foundational placement and the decay exemption for active goals (ADR-0002f) are both
externally grounded.

**R4. Itemized, incremental updates — never monolithic rewrites.**
ACE documents *context collapse*: a monolithic LLM rewrite took an 18,282-token context to 122
tokens in one step, dropping accuracy from 66.7 to 57.1 — "worse than the baseline accuracy of
63.7 without adaptation." Their fix is structured bullets with metadata — unique identifiers and
"counters tracking how often it was marked helpful or harmful" — merged by deterministic non-LLM
logic. Our per-item decision ledger, marked deltas, and solver-as-single-writer are the same
conclusions; their helpful/harmful counters are a primitive touch journal.

**R5. Selective forgetting under utility is the open program.**
The 2026 memory survey: "Forgetting is not a bug; it is a feature… current systems handle it
crudely: hard time-based expiration, storage-limit eviction, or nothing at all." Chroma shows the
cost of accumulation: 18 SOTA models degrade with input length even on trivial tasks, with
degradation accelerating as needle-question similarity falls. The rot term (ADR-0002b) is not a
nicety; it prices a measured effect.

**R6. Retrieve broadly, filter late.**
Memory-R1's Answer Agent distills 60 RAG-retrieved candidates to the relevant few before
reasoning — "humans retrieve broadly but then filter" — and Zep's retrieval fuses cosine similarity,
full-text search, reciprocal-rank fusion, and MMR re-ranking. This validates ctx.search/ctx.find
returning candidates with recoverable paths (ADR-0002h) and leaving the value bump to policy at
handle time, not at index time.

**R7. Focus/release is general — and the server can express it.**
Context-Folding's branch/return collapses sub-trajectories to summaries, with the KV cache
reverting to its pre-branch state on return: the provider-side cache model *natively supports*
focus-then-release without paying for the focused interior. The algebra of ADR-0002a/0002d applies
to conversations as well as files, and block+deltas is the right wire format to exploit it.

**R8. The decay curve has a 35-year-old ancestor.**
Anderson & Schooler (1991): human memory need-probabilities mirror environmental statistics —
power-law in recency and frequency of prior use — across headlines, parental speech, and email.
ACT-R's base-level activation is our μ₀ + (1+Δt)^−α with different clothing. ACE's *habituation*
(attention to repeated content decays with exposure) is the same finding, rediscovered in LLMs.
We are estimating an environmental regularity, not inventing one — and the per-kind value-profile
mechanism (ADR-0002f) is exactly how ACT-R handles items that defy the regularity.

**R9. Replay is learn-from-oracle.**
Hawkeye (ISCA 2016) runs clairvoyant Belady offline over logged past accesses and trains a
predictor from its decisions — "Back to the Future" is structurally identical to ADR-0003's replay
harness: deterministic re-render under better parameters, adopted review-gated. Parrot (ICML 2020)
extends the pattern to featurized imitation; LRU-BaSE documents the feedback-delay trap that our
review-gate + prior-divergence guards exist to prevent. The honesty boundary (cost-counterfactual,
never behavior-counterfactual) also matches: Hawkeye learns cost decisions, not behavior.

**R10. Async maintenance turns.**
Letta's sleep-time compute (background agents updating shared memory blocks during idle periods)
and the parallel-context-compaction paper (compaction off the critical path, in parallel with
generation) both validate the dreaming-turn discipline of ADR-0002f: transforms decided at one
turn, executed async, visible at the next, never inside render.

## §3 What to keep in mind as we implement

**K1. Cache accounting is subtler than the price list.**
The Anthropic SDK's own docs record that `cache_read_input_tokens` accumulates internal reads made
by server-side tools, inflating perceived context ~5x and triggering premature compaction. And TTL
runs from request *start* — generation time counts against the 5-minute window. Ledger design
(ADR-0002e): record per-call usage fields verbatim; treat the summed-cache-read trap as a
first-class divergence class; never drive our own eviction from summed counters.

**K2. Every mutation before a breakpoint re-prices everything after it.**
Anthropic's `clear_at_least` parameter exists because clearing invalidates the cached prefix and
must buy its keep. Manus adds the silent killer: non-deterministic JSON key ordering breaks caches
byte-exactly. The renderer's deterministic serialization (ADR-0002d) is a hard requirement, and
realized-cost records must include the post-eviction cache-write cost, not just the token delta.

**K3. Tool definitions are load-bearing context.**
Manus: tool schemas live near the front; adding/removing tools mid-session invalidates the cache
for everything after *and* strands history that references undefined tools ("schema violations or
hallucinated actions"). They mask logits rather than remove tools. For us: tool-set mutations are
full-prefix rewrites — the most expensive placement move the solver can make — and should be priced
and rare; action-space narrowing wants a mask-style mechanism where the provider allows it.

**K4. Uniform context is brittle — but so is cache-hostile variation.**
Manus's "don't get few-shotted": repetitive, uniform histories breed mimetic drift (the 20-resume
rut), fixed with *structured variation* in serialization templates. This sits in direct tension
with K2's deterministic serialization. The reconciliation: determinism within a chosen
representation (cache-safe), variation *across* representation choices in cache-inactive tail
segments. Where the line sits is an open renderer question — see A5.

**K5. Keep the wrong stuff in — the estimators need it.**
Manus: "Erasing failure removes evidence. And without evidence, the model can't adapt." Error turns
carry standing behavioral value even at low re-reference probability — and our hazard/value
estimators need error outcomes as labels. Anthropic's oldest-first clearing will eventually eat
every failure trace. Utility-priced eviction is right, but the default value profile for error
evidence should not be plain episodic decay — see A1.

**K6. Summarization failures are the norm; guardrails are known.**
ACON: naive compression loses "an email identifier, file version, or API format… can derail task
success"; their fix is failure-driven guideline refinement (contrastive set: full context succeeds,
compressed fails) — gradient-free, offline, exactly the shape of our 0003 refit. Online, our
realized-lossiness journaling (re-expansion after summary) is the corresponding signal. ACE's lazy
refinement (dedup only when the window is exceeded) is a sensible default schedule for dreaming
turns.

**K7. Store mutations are where LLM judgment errs.**
Memory-R1's motivating failure: a vanilla manager reads "I adopted another dog named Scout" as a
contradiction and issues DELETE+ADD, fragmenting the record; a trained agent consolidates with
UPDATE. Lessons that transfer: (a) outcome-grounded signals beat prompt instructions; (b) very few
labels go far (152 QA pairs); (c) separate the proposer from the applier — Zep uses predefined
Cypher rather than LLM-written queries "to ensure consistent schema formats and reduce the
potential for hallucinations." Our equivalent: LLM proposes (ctx.*, goals.*, transform plans);
deterministic code applies; the solver remains single writer.

**K8. Distraction compounds with length; zones must stay coherent.**
Chroma: distractor impact *amplifies* with input length, non-uniformly across models; low
needle-question similarity accelerates degradation; even haystack structure (shuffled vs. original)
matters. The rot term should eventually price distractor density and zone coherence, not just
window size — see A2. Our ordered, kind-grouped render is already the right defense.

**K9. Naive folding underperforms; confidence must be earned.**
Context-Folding's ablation: without RL training, the folding agent *underperforms* plain
long-context ReAct; the gains come from learned folding discipline. For the conversation lens
(ADR-0002f): SUMMARY/MERGED representations should start disfavored and earn aggressiveness as
realized-lossiness data shows low regret — see A6.

**K10. Infrastructure determinism is part of the contract.**
Manus: session-ID routing for distributed prefix-cache workers; SGLang: the radix tree as the
physical shape of prefix reuse, LRU eviction on it. Our block+deltas representation is designed
for exactly this substrate; the ledger's believed-vs-realized cache fields are how we detect when
the substrate betrays the belief.

## §4 What to adjust — proposals awaiting ruling

Each is a small, local change; none rewrites an accepted ADR. Lettered for reference in a future
ruling session.

**A1. Per-kind value profile: `error-evidence` class.** (from K5; touches ADR-0002b/0002f)
Add an `error` kind to the versioned value profiles with its own decay parameters — slower than
episodic, lifecycle-free — or a value floor for N turns after the error. Machinery already exists
(per-kind profiles, ADR-0002f); this adds one profile and a label rule (failed action-observation
pairs are classed `error` at journal time).

**A2. Rot term: record now, fit density later.** (from K8; touches ADR-0002b/0003)
Keep v1 rot as f(window size), but have the ledger record per-zone item-kind histograms each turn
so 0003 can fit distractor-density terms (rot as f(size, density, coherence)) once the corpus
exists. Cost: a few fields per turn. Benefit: the literature says density is where the effect lives.

**A3. Named divergence class: server-side tool double-count.** (from K1; touches ADR-0002e)
Add to the ledger's divergence taxonomy: believed-realized cache divergence caused by provider
usage-field semantics (summed internal reads). Plus a standing rule: our eviction and compaction
triggers read `input_tokens` (true context), never summed cache-read counters. The Anthropic SDK
shipped this exact bug; we should name it before we meet it.

**A4. Tool-mutation pricing made explicit.** (from K3; touches ADR-0002b)
State in the objective that tool-definition mutations are full-prefix rewrites — the maximum
placement cost — and that action-space narrowing prefers provider-side masking (logit/prefill
control) where available. We cannot always mask, but we can always price.

**A5. Variation-safe rendering: an open design note.** (from K4; touches ADR-0002d)
Record the tension between deterministic serialization (cache) and structured variation
(anti-mimicry), and the proposed resolution: variation only across representation choices in
cache-inactive segments, never within a chosen item's serialization. Renderer v1 should log
template choices so 0003 can test whether uniformity hurt. Full resolution may deserve a lettered
ADR; a design note in 0002d's future-work list suffices until then.

**A6. Summary-confidence ramp.** (from K9/K6; touches ADR-0002f/0003)
Conversation-lens lossy representations start with a high fidelity-loss penalty (prior), relaxed
only as realized-lossiness records accumulate low regret — re-expansion rate and contrastive
failures as the trigger, ACON-style. This is a parameterization stance plus an explicit adoption
rule in the refit pipeline, not a structural change.

## §5 Synthesis: the field is arguing about value density, and our objective is the arbiter

ACE's headline claim — contexts should be comprehensive playbooks, because "LLMs are more effective
when provided with long, detailed contexts and can distill relevance autonomously" — appears to
contradict Chroma's rot. It does not. ACE's playbooks are curated, high-value, repeatedly-referenced
content (power-law-exempt, in our vocabulary); Chroma's haystacks are filler. The disagreement
dissolves once value is modeled per item: saturation is optimal when marginal value density stays
high, and toxic when it does not. Every source in this review, from Manus's KV discipline to
Memory-R1's distillation, is quietly optimizing that ratio by hand. The optimizer's contribution
is to make it the explicit, journaled, tunable quantity — and the literature above suggests the
estimation problem is tractable, the failure modes are known and named, and the pieces exist
scattered, awaiting assembly.

## §6 Takeaways and plan impact

**T1. The architecture survives contact; the ruling needed is small.** No proposal from §4 touches
structure — all six (A1–A6) are parameterization, observability, or default stance. This is the
meta-finding: 29 sources, including a production system at scale, and the design held.

**T2. Instrument-first is now evidence-backed, and the ledger is the enabler.** Every adaptation
mechanism the field validated consumes records: Memory-R1's outcome-driven rewards (152 pairs
sufficed), Hawkeye's learn-from-oracle, ACON's contrastive failure mining. Corollary: widen the
ledger at write time rather than backfill — raw usage fields (A3), zone histograms (A2), template
logs (A5), lossiness events (A6).

**T3. The risk register moved from unknown to named.** Three clusters: provider accounting
semantics (K1–K2), lossy-transform failures (K6, K9), LLM-authored store mutations (K7). The
design's structural defenses — single writer, deterministic render, journal, signals-not-overrides
— already cover the third cluster; the first two need the observability and defaults queued in
A2/A3/A6.

**T4. Spend craft on the differentiated core; buy boring commodity parts.** The assembly —
forecast-priced placement, journaled ledger, calibration against realized outcomes — is the
contribution. Embedding search and summarization are representations, not the product, and should
use proven implementations.

**T5. The success metric has a name: value density.** Realized value per unit of realized,
cache-adjusted render cost. Under this metric the field's ACE-vs-Chroma contradiction dissolves
(§5), and report 6's accumulator control measures exactly the optimizer-vs-accumulator contrast.
Token reduction alone is the wrong target; the accumulator reduces tokens by forgetting.

**T6. Conservative-by-default lossiness.** The field's most repeated lesson: untrained compression
and untrained folding underperform doing nothing (Context-Folding ablation; ACON's naive-compression
losses; ACE's collapse). v1 ships VERBATIM-dominant; lossy representations earn aggressiveness
through observed low regret (A6).

**T7. The loop-milestone checklist, concretely affected.**
- *Ledger write path:* raw provider usage fields verbatim; believed-cache fields; per-zone kind
  histograms; lossiness events; template-choice log.
- *Renderer v1:* byte-stable deterministic serialization as a hard invariant; tool-set mutations
  priced as full-prefix rewrites (A4); variation confined to representation choices in
  cache-inactive segments (A5).
- *Defaults:* error-evidence profile (A1) and summary-confidence ramp (A6) as the first two
  entries in the versioned profile registry.

Recommendation on the queued proposals: all six are cheap. A3 and A6 carry the most protection per
line — a named divergence class the Anthropic SDK shipped as a bug, and the field's most repeated
failure mode. A1 is the cheapest insurance: one profile plus a label rule. A5 stays a design note
until the renderer's template logs supply evidence.


**Index**

- §1 Method and scope — line 20
- §2 What is reinforced — line 34
- §3 What to keep in mind as we implement — line 108
- §4 What to adjust — proposals awaiting ruling — line 179
- §5 Synthesis: the field is arguing about value density, and our objective is the arbiter — line 219
- §6 Takeaways and plan impact — line 232

- §1 — The optimizer-not-accumulator framing is externally confirmed; nobody else prices it end-to-end. — line 11
- §2 — Ten reinforcements, from KV-cache economics to replay-as-learn-from-oracle. — line 12
- §3 — Ten implementation warnings with their sources and the ADR each touches. — line 13
- §4 — Six proposed adjustments (A1–A6), awaiting the Decider's ruling. — line 14
- §5 — Synthesis: value density, not length, is the variable the field is arguing about; our objective is the arbiter. — line 15
- §6 — Takeaways: the architecture holds; the risks are named; the loop-milestone checklist is sharpened. — line 16
