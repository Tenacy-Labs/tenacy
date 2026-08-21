# Cache Replacement Policies (survey article)

- **Link:** https://en.wikipedia.org/wiki/Cache_replacement_policies
- **Kind:** Reference survey
- **Date:** living
- **Relates to:** ADR-0002b §3/§6, ADR-0002c §3

The classical arsenal — Belady's OPT, LRU and its variants (2Q, LRU/K), ARC, RRIP family — and the founding observation (Belady 1966) that optimal replacement requires the future. Our placement policy is a cache-replacement problem with a twist: the 'cache' is the render, 'accesses' are forecast by value decay and hazard rather than observed, and the miss cost is priced in tokens. Read for the vocabulary; our novelty is the forecast-driven, priced variant.
