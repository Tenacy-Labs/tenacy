# Letta Memory Blocks / Agent Memory

- **Link:** https://www.letta.com/blog/memory-blocks
- **Memory blocks docs:** https://docs.letta.com/v1-sdk/memory/memory-blocks
- **Agent memory post:** https://www.letta.com/blog/agent-memory
- **Platform repo:** https://github.com/letta-ai/letta
- **Kind:** OSS platform docs & blog
- **Date:** 2024–2025
- **Relates to:** ADR-0002f (goals lens), ADR-0002g (ctx.*)

Memory blocks: labeled, size-limited, in-context sections the agent can rewrite via tools (memory_insert/replace/rethink), pinned to the window, with recursive summarization of evicted messages underneath. This is the shipping implementation of tool-gated foundational context — the closest production relative of the goals lens, including the limit-bounded allocation that mirrors our budget. Their agent-memory post lays out the tiering (message buffer / core / recall / archival) our zones generalize into a single priced spectrum.
