# Agentic Context Engineering: Evolving Contexts for Self-Improving LMs (ACE)

- **Link:** https://arxiv.org/abs/2510.04618
- **Kind:** Paper (ICLR 2026)
- **Date:** 2025-10
- **Relates to:** ADR-0002b §2 (decay), ADR-0002d §6 (marked deltas), ADR-0002e

The closest published cousin. Doer/Critic/Librarian triad evolves a structured context workspace via incremental deltas; two mechanisms rhyme directly with our design: *habituation* — attention to repeated content decays with exposure (our power-law value decay, discovered independently) — and their diff-style context updates (our marked-delta render contract). ACE tunes a growing context for self-improvement on a benchmark; we price a per-turn render under budget with cache economics. Their 'context grows monotonically, quality degrades' finding is the empirical case for optimizer-not-accumulator.
