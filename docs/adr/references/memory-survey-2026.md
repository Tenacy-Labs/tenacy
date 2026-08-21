# Memory for Autonomous LLM Agents — survey (2026)

- **Link:** https://arxiv.org/abs/2603.07670
- **Kind:** Survey
- **Date:** 2026
- **Relates to:** ADR-0002 (landscape), ADR-0003 (benchmarks)

Formalizes agent memory as a write–manage–read loop with a three-dimensional taxonomy (temporal scope, substrate, control policy), and includes the line that could be our epigraph: 'Forgetting is not a bug; it is a feature... current systems handle it crudely: hard time-based expiration, storage-limit eviction, or nothing at all.' The selective-forgetting-under-utility formulation is the research program our optimizer implements. Covers the benchmark landscape (MemBench, MemoryAgentBench, LoCoMo) the 0003 corpus work should know.
