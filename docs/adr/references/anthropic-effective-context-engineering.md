# Effective Context Engineering for AI Agents (Anthropic)

- **Link:** https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- **Kind:** Engineering blog
- **Date:** 2025
- **Relates to:** ADR-0002 (contrast anchor), ADR-0002f, ADR-0002h

The authoritative statement of the accumulator-side toolbox: structured note-taking, sub-agent contexts, just-in-time retrieval, and tool-result clearing. Names compaction as 'the smallest unit of context engineering'. Useful as the baseline family our optimizer-not-accumulator ruling departs from — every technique here is a hand-tuned special case of a priced placement decision in ADR-0002b, and their just-in-time retrieval is the cell-side mirror of our store-side search (ADR-0002h).
