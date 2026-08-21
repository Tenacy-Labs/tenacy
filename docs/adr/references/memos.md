# MemOS: A Memory OS for AI System

- **Link:** https://arxiv.org/abs/2507.03724
- **Repo:** https://github.com/MemTensor/MemOS
- **Kind:** Paper + OSS
- **Date:** 2025-07
- **Relates to:** ADR-0000 (OS framing), ADR-0002 §2

Treats memory as a first-class OS resource: MemCube unifies plaintext, activation (KV), and parameter memories under one scheduling abstraction; strong LoCoMo numbers (159% temporal-reasoning gain over a global-memory baseline). Kindred in the everything-is-scheduled framing, but it schedules *storage*; our kernel schedules *render* — the window itself is the resource under admission control, and MemOS's activation-memory tier is where our cache-belief model lives.
