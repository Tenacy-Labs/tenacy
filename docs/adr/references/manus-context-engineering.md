# Context Engineering for AI Agents: Lessons from Building Manus

- **Link:** https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- **HN discussion:** https://news.ycombinator.com/item?id=44564248
- **Kind:** Engineering blog (production postmortem)
- **Date:** 2025-07
- **Relates to:** ADR-0002 §2/§4, ADR-0002b §5, ADR-0002e §1

The closest production kin to the context-optimizer pattern. Manus argues KV-cache hit rate is the single most important metric for a production agent (~100:1 input:output ratio; cached tokens 10x cheaper), and derives practices from it: keep the prompt prefix stable, append-only context, keep volatile content (timestamps) at the tail, and recite tool outputs rather than re-reading. Their `--no-context` recitation trick (repeating recent KV state into the new window) is a production answer to our block+deltas checkpoint question. Where Manus optimizes a fixed policy by hand, we formalize the same economics as a priced objective with a decision ledger.
