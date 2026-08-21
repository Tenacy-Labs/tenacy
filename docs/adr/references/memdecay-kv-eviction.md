# MemDecay: Region-Aware KV Cache Eviction

- **Link:** https://arxiv.org/abs/2607.10582
- **Kind:** Paper
- **Date:** 2026-07
- **Relates to:** ADR-0002b §4 (zones), ADR-0002c

Orchestrator labels prompt regions (system/goals/tool outputs) and an eviction policy uses those priors plus attention statistics under a KV budget. Zone-aware eviction at the attention layer — the same insight as our ordered-not-pairwise risk, pushed into the model's own cache. Evidence the zone abstraction is converging across the stack.
