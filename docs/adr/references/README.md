# References — research bibliography for the ADR corpus

One entry per file. Each entry carries: link(s), kind, date, the ADRs it relates to,
and a blurb stating the overlap and the divergence. Entries were verified against live
sources on 2026-08-21; the two Anthropic doc pages marked *verified live* were fetched whole.

**Deep-read analysis:** [ANALYSIS.md](ANALYSIS.md) — what the literature reinforces (R1–R10),
what to keep in mind while implementing (K1–K10), and six proposed plan adjustments (A1–A6,
awaiting ruling).

## Production & platform engineering

- [Context Engineering for AI Agents: Lessons from Building Manus](manus-context-engineering.md) — *ADR-0002 §2/§4, ADR-0002b §5, ADR-0002e §1*
- [Effective Context Engineering for AI Agents (Anthropic)](anthropic-effective-context-engineering.md) — *ADR-0002 (contrast anchor), ADR-0002f, ADR-0002h*
- [Prompt Caching (Claude Platform Docs)](anthropic-prompt-caching.md) — *ADR-0002b §3/§5, ADR-0002e §1 (cache beliefs)*
- [Context Editing (Claude Platform Docs)](anthropic-context-editing.md) — *ADR-0002f, ADR-0002b §6*
- [Compaction (Claude Platform Docs)](anthropic-compaction.md) — *ADR-0002f*
- [Building a Better Repository Map with Tree-sitter (Aider)](aider-repomap.md) — *ADR-0002d §4 (code lens)*
- [SGLang RadixAttention (LMSYS blog)](sglang-radixattention.md) — *ADR-0002b §5, ADR-0002c §3*

## Agent memory systems (OSS)

- [MemGPT: Towards LLMs as Operating Systems](memgpt.md) — *ADR-0000, ADR-0002 §6, ADR-0002f*
- [Letta Memory Blocks / Agent Memory](letta-memory-blocks.md) — *ADR-0002f (goals lens), ADR-0002g (ctx.*)*
- [MemOS: A Memory OS for AI System](memos.md) — *ADR-0000 (OS framing), ADR-0002 §2*
- [Zep: A Temporal Knowledge Graph Architecture for Agent Memory](zep-temporal-kg.md) — *ADR-0002c §2 (validity), ADR-0002f (goal lifecycle)*
- [Memory-R1: RL for Memory Management](memory-r1.md) — *ADR-0003 §4 (refit pipeline)*

## Context optimization papers

- [Agentic Context Engineering: Evolving Contexts for Self-Improving LMs (ACE)](ace-agentic-context-engineering.md) — *ADR-0002b §2 (decay), ADR-0002d §6 (marked deltas), ADR-0002e*
- [ACON: Optimizing Context Compression for Long-horizon LLM Agents](acon-context-compression.md) — *ADR-0003 (audits, refit), ADR-0002f (fidelity)*
- [Make Your LLM Fully Utilize the Context (Context Quota)](context-quota.md) — *ADR-0002b §4 (zones), ADR-0002h*
- [Scaling Long-Horizon LLM Agents via Context-Folding](context-folding.md) — *ADR-0002a (focus/release algebra), swarm contexts*
- [Parallel Context Compaction for Long-Horizon LLM Agent Serving](parallel-context-compaction.md) — *ADR-0002f (async transforms)*
- [Governance Decay: How Context Compaction Silently Erases Safety Constraints](governance-decay.md) — *ADR-0002f (goals lens decay exemption), ADR-0002b §4*
- [MemDecay: Region-Aware KV Cache Eviction](memdecay-kv-eviction.md) — *ADR-0002b §4 (zones), ADR-0002c*
- [Context Rot (Chroma technical report)](chroma-context-rot.md) — *ADR-0002 §2, ADR-0002b (rot term), ADR-0003*
- [AbsenceBench: Language Models Can't Tell What's Missing](absencebench.md) — *ADR-0002d §6 (sequence legibility), ADR-0002h*

## Cache-replacement theory

- [Cache Replacement Policies (survey article)](cache-replacement-policies.md) — *ADR-0002b §3/§6, ADR-0002c §3*
- [Back to the Future: Leveraging Belady's Algorithm (Hawkeye)](hawkeye-belady.md) — *ADR-0002e → ADR-0003 (corpus → refit loop)*
- [An Imitation Learning Approach to Cache Replacement (Parrot)](parrot-imitation-cache.md) — *ADR-0003 §4*

## Cognitive-science roots

- [Reflections of the Environment in Memory (Anderson & Schooler, 1991)](anderson-schooler-1991.md) — *ADR-0002b §2 (power-law decay)*

## Surveys & living indexes

- [Knapsack Solvers — Survey & Performance Review](knapsack-solvers-survey.md) — *ADR-0005 (primary), ADR-0002b, ADR-0004. MCKP canon (Pisinger/Martello–Toth/Kellerer et al.), online/incremental variants matching ADR-0005's coupled-cost and cross-turn deviations, knapsack×LLM-inference papers (incl. independent OS-MCKP corroboration), and OSS implementations — with a performance review mapping techniques onto `src/optimizer/solver.ts`.*
- [Memory for Autonomous LLM Agents — survey (2026)](memory-survey-2026.md) — *ADR-0002 (landscape), ADR-0003 (benchmarks)*
- [Choosing How to Remember: Adaptive Memory Structures for LLM Agents](adaptive-memory-structures.md) — *ADR-0002, ADR-0003*
- [Agent-Memory-Paper-List (living index)](agent-memory-paper-list.md) — *All ADR-0002/0003 (discovery)*
- [Awesome-GraphMemory (living index)](awesome-graphmemory.md) — *ADR-0002c/0002h (graph-structured memory)*

---

**Closest overlaps with the seemingly-novel mechanics** (start here): ACE habituation ↔ power-law value decay (0002b §2); Hawkeye learn-from-Belady ↔ ledger→refit loop (0002e/0003); governance-decay pinning ↔ goals-lens decay exemption (0002f); Manus KV-cache economics ↔ render objective (0002 §4); AbsenceBench ↔ sequence-legibility contract (0002d §6); Anderson & Schooler 1991 ↔ the decay curve's 35-year-old ancestor (0002b §2).

**Where we still appear novel**: the mean-variance solver over all context (no published system prices render as a portfolio); per-item hazard forecasting with forecast-vs-subscription substitution (0002c); the decision ledger with expected-vs-realized cache divergence classes (0002e); re-expansion-as-realized-lossiness feeding calibration (0002f/0003).
