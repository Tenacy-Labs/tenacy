# An Imitation Learning Approach to Cache Replacement (Parrot)

- **Link:** https://arxiv.org/abs/2006.16239
- **Kind:** Paper (ICML 2020)
- **Date:** 2020-11
- **Relates to:** ADR-0003 §4

Featurizes cache lines and imitates Belady's decisions with a learned classifier — the ML successor line to Hawkeye, and prior art for 'learn the oracle's choices from features'. Relevant when the refit pipeline graduates from statistical estimation to learned policies: the same featurization discipline (access history, PC-equivalents) maps to our per-item journal features (kind, age, touches, toggle state).
