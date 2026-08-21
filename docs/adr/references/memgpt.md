# MemGPT: Towards LLMs as Operating Systems

- **Link:** https://arxiv.org/abs/2310.08560
- **DeepLearning.AI course:** https://www.deeplearning.ai/courses/llms-as-operating-systems-agent-memory
- **Kind:** Paper
- **Date:** 2023-10
- **Relates to:** ADR-0000, ADR-0002 §6, ADR-0002f

The origin point of the LLM-as-OS metaphor: virtual context management that pages information between main context (window) and external storage, with the model itself issuing the paging calls. Everything downstream — Letta, MemOS, Zep, our kernel — inherits from this framing. Its self-editing memory blocks are the direct ancestor of both our goals lens (tool-gated foundational context) and the ctx.* surface (model-authored manipulation). Divergence of note: MemGPT pages on demand with no value model; our optimizer prices every placement decision.
