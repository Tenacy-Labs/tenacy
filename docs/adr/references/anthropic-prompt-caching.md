# Prompt Caching (Claude Platform Docs)

- **Link:** https://docs.claude.com/en/docs/build-with-claude/prompt-caching
- **Kind:** Platform documentation (verified live)
- **Date:** 2025–2026
- **Relates to:** ADR-0002b §3/§5, ADR-0002e §1 (cache beliefs)

Ground truth for the provider-side cache model our objective prices against: prefix hashing over tools→system→messages, up to four `cache_control` breakpoints, 5-minute default TTL (1-hour at 2x write cost), cache writes at 1.25x and reads at 0.1x base input price. The TTL refresh semantics (lifetime measured from request start; generation time counts against it) and the byte-exact invalidation rule are exactly the assumptions ADR-0002e says the ledger must record per call — believed vs realized hits, divergence classified.
