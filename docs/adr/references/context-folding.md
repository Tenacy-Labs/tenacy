# Scaling Long-Horizon LLM Agents via Context-Folding

- **Link:** https://arxiv.org/abs/2510.11967
- **Kind:** Paper
- **Date:** 2025-10
- **Relates to:** ADR-0002a (focus/release algebra), swarm contexts

Adds branch/return actions so an agent can spawn a focused sub-context for a subtask and fold it back as a summary — 107k tokens folded to 6.5k in their case study. The branch/return pair is focus/release applied to *conversation* rather than files; their fold-on-return is a declarative group-merge in conversation-lens terms. Also the cleanest published statement of the sub-agent context-isolation pattern our swarm envelopes implement.
