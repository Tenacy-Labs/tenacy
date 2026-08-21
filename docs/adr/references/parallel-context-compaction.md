# Parallel Context Compaction for Long-Horizon LLM Agent Serving

- **Link:** https://arxiv.org/abs/2605.23296
- **Kind:** Paper
- **Date:** 2026-05
- **Relates to:** ADR-0002f (async transforms)

Moves compaction off the critical path: summarize old context in parallel with generation rather than stalling the turn. Validates the dreaming-turn discipline — representation transforms as asynchronous maintenance, decided at one turn, visible at the next. Also documents the failure we designed against: aggressive synchronous compaction destroys the recent context that carries the agent's freshest state.
