# AbsenceBench: Language Models Can't Tell What's Missing

- **Link:** https://arxiv.org/abs/2506.11440
- **Kind:** Paper (benchmark)
- **Date:** 2025-06
- **Relates to:** ADR-0002d §6 (sequence legibility), ADR-0002h

Models fail to notice removed content in long contexts — deletion is invisible without a signal. The strongest external argument for our sequence-legibility contract: marked deltas, tail change-notices, and unchanged-stamps exist because the model cannot detect absence unaided. Also motivates search over the journal: what was dropped must be findable, since it will not be noticed.
