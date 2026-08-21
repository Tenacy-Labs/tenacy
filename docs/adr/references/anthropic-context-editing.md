# Context Editing (Claude Platform Docs)

- **Link:** https://docs.claude.com/en/docs/build-with-claude/context-editing
- **Kind:** Platform documentation (verified live)
- **Date:** 2025–2026
- **Relates to:** ADR-0002f, ADR-0002b §6

Server-side context curation: `clear_tool_uses_20250919` drops oldest tool results past a token threshold (with `keep`, `clear_at_least`, `exclude_tools` knobs), replacing them with placeholders; `clear_thinking_20251015` does the same for reasoning blocks. This is fill-then-clear compaction as an API — threshold-triggered, positional, utility-blind. The `exclude_tools` carve-out is a hand-rolled version of our foundational zone; the documented cache-invalidation cost of clearing is precisely the rewrite-priced term in our objective. The contrast case for the conversation lens: same lever, no value model behind it.
