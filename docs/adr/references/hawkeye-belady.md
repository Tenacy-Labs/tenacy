# Back to the Future: Leveraging Belady's Algorithm (Hawkeye)

- **Link:** https://www.cs.utexas.edu/~lin/papers/isca16.pdf
- **Kind:** Paper (ISCA 2016)
- **Date:** 2016
- **Relates to:** ADR-0002e → ADR-0003 (corpus → refit loop)

The structural ancestor of our tuning loop: run the optimal-but-clairvoyant policy (Belady) *offline over logged past accesses*, learn a predictor from its decisions, apply the predictor online. Replace 'access stream' with 'touch stream' and 'Belady' with 'regret-free placement under known costs' and you have the 0003 replay harness: deterministic re-render of journaled sessions under better parameters, adopted review-gated. Also the honest-boundary kinship: Hawkeye learns cost decisions, not behavior — same limit we placed on replay.
