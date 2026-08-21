# ACON: Optimizing Context Compression for Long-horizon LLM Agents

- **Link:** https://arxiv.org/abs/2510.00615
- **Kind:** Paper
- **Date:** 2025-10
- **Relates to:** ADR-0003 (audits, refit), ADR-0002f (fidelity)

Failure-driven compression: find trajectories where full context succeeded but compressed context failed, have a strong model diagnose what the compressor dropped, and refine the natural-language compression guideline — gradient-free, API-compatible. This is our re-expansion-as-realized-lossiness signal promoted to a full optimization loop: near-miss failures (rejected moves, in our ledger's terms) become the training signal. The 0003 audits' 'contrastive set' methodology in independent invention.
