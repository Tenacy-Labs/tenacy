# Phase 3 implementation summary

ADR-0001 is implemented in the public `solve()` path.

## Delivered

- Optional `SequencePosition` metadata on `ContextItem` and `RenderOption`.
- Independent base/delta placement with deterministic per-parent precedence.
- Zone-tail defaults and credit-gated lineage-fuse branch moves.
- O(n) prefix/suffix and predecessor preprocessing per move pass; O(1)
  intervening-mass evaluation per candidate.
- One deterministic accepted move per pass, a five-pass hard cap, and no random
  search or selection re-solve.
- Solver diagnostics: one selection pass, move-pass count, cap status, accepted
  move count, reversals, and move-thrash.
- Position-regret ledger rows for accepted and rejected fuse moves.
- Optional wall-clock cache TTL with turn-TTL fallback in both cache belief and
  solver expiry pricing.
- Provider billing-quanta and breakpoint-price helpers.

## Compatibility

All sequence, wall-clock, and prior-move fields are optional. Metadata-free
items retain the existing selection and canonical layout behavior. Exact MCKP
relief remains conditional on an over-budget render and is called at most once.

## Verification

`test/sequence-position.test.ts` pins the discriminating suffix-mass identity,
precedence, migration threshold/rejected regret, deterministic layout, quiet
path, cap, reversal signal, billing breakpoints, and both TTL axes. The full Bun
suite and strict TypeScript gate are the release checks.

## Honest scope gaps

This release does not accrue/persist migration credit, construct delta items,
search arbitrary permutations, learn position value, jointly re-select after
moves, apply provider quanta to every legacy continuous-price term, or provide
live A/B effectiveness evidence. See ADR-0001 for the complete boundary list.
