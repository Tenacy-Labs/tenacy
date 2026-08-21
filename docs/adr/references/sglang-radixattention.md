# SGLang RadixAttention (LMSYS blog)

- **Link:** https://www.lmsys.org/blog/2024-01-17-sglang
- **Kind:** Engineering blog / serving system
- **Date:** 2024-01
- **Relates to:** ADR-0002b §5, ADR-0002c §3

Automatic prefix KV-cache reuse via a radix tree over all processed prompts, with LRU eviction and cache-aware scheduling; up to 5x throughput on prefix-sharing workloads. The server-side structure our block+deltas representation is designed to feed — the radix tree is the physical shape of 'append-cheap, rewrite-priced'. Their LRU-on-radix-tree is the blind version of the placement policy ADR-0002c specifies as a decision function over (validity, horizon, costs).
