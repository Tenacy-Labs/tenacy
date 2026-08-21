# Building a Better Repository Map with Tree-sitter (Aider)

- **Link:** https://aider.chat/2023/10/22/repomap.html
- **Kind:** Engineering blog / OSS technique
- **Date:** 2023-10
- **Relates to:** ADR-0002d §4 (code lens)

The canonical token-budgeted structural view of code: tree-sitter extracts symbols across 100+ languages, files-as-nodes/refs-as-edges, PageRank ranks importance, binary search packs the top-ranked symbols into ~1k tokens, re-ranked per turn against files in chat. This is a stateless, always-recomputed projection — the accumulator-style cousin of our code lens. Where Aider re-ranks by graph centrality alone, our lens adds symbol-anchored ranges, mtime incremental re-parse, and per-symbol cache validity so unchanged symbols stay byte-identical.
