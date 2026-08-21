# Zep: A Temporal Knowledge Graph Architecture for Agent Memory

- **Link:** https://arxiv.org/abs/2501.13956
- **Kind:** Paper
- **Date:** 2025-01
- **Relates to:** ADR-0002c §2 (validity), ADR-0002f (goal lifecycle)

Bi-temporal memory: every fact carries valid-time and ingestion-time; superseded facts are invalidated, never deleted; real-time incremental graph updates. The bi-temporal discipline is the same one behind our validity interface (fresh/stale/unknown with observed hazard), and its invalidate-don't-delete rule is exactly our dropped≠destroyed principle rendered as a storage design. Also the best worked example of lifecycle-bounded standing facts — goal supersession converting to episodic records is a two-timeline event in Zep's vocabulary.
