# ADR-0001 — sequence-position semantics

- Status: **accepted**
- Date: 2026-08-23
- Accepted scope: phase-3 sequence-position core in `solve()`

## Context

A base and its temporal deltas are separate cache objects: a base may remain near
a stable prefix while later deltas arrive at the tail. Treating `BASE+DELTA` as
one block forces every delta update to rewrite at the base and rebill all bytes
between the base and the tail. Placement therefore belongs in the solver, where
selection, suffix cost, precedence, and deterministic convergence can be
journaled together.

The relevant algorithm families are list update and file migration (movement is
paid against future savings), reordering buffers, metrical task systems on tree
metrics, radix-tree prompt caches (Prompt Cache / PSM / SOLO), and
lost-in-the-middle position value. This release borrows the file-migration
credit threshold and representative radix/zone branch points; it does not claim
the competitive ratios of those fuller models.

## Decision

### 1. Explicit, backward-compatible sequence metadata

`ContextItem.sequence` and `RenderOption.sequence` are optional. Option metadata
overrides item metadata. Absence selects the prior solver path. The metadata is:

- `parentId`: stable file/object lineage;
- `ordinal`: total arrival order within that lineage;
- `role`: `base` or `delta`;
- `predecessorId`: optional explicit edge to the prior base/delta item;
- `placement`: optional `tail` (default for deltas) or `fuse`;
- `migrationCreditTokens`: producer-accumulated credit available for a fuse.

A delta is an independent `ContextItem` with independent options, value, token
mass, and placement. The solver does not synthesize or hide delta items.

For every rendered parent lineage, explicit predecessor edges are authoritative;
`(ordinal, item id)` supplies the deterministic order when an edge is absent.
Stable topological repair preserves unrelated occupied slots.
Default deltas are placed at their legal zone-tail branch point in arrival
order. A fuse delta targets the branch immediately after its nearest rendered
predecessor, preserving sequence legibility.

### 2. One selection pass, then bounded order-aware placement

`solve()` performs the existing option-selection pass once. If and only if
exact relief is enabled and the selected render exceeds budget, it invokes the
MCKP engine once. Phase 3 does not re-run MCKP.

After budget relief, the move planner:

1. preprocesses token prefix and suffix mass in O(n) per pass;
2. resolves immediate per-parent predecessors in one linear scan;
3. evaluates each fuse relocation at its branch point with an O(1) prefix-mass
   query;
4. accepts at most one candidate per pass, chosen by credit surplus then code-
   unit item id;
5. stops on a quiet pass or after five passes.

The delta-at-base versus delta-at-tail bill is exactly the mass of blocks
strictly between those positions. There is no random or Monte Carlo search.
Canonical sorting and precedence normalization remain O(n log n); candidate
pricing itself is O(1), and the five-pass cap keeps placement bounded. No
runtime benchmark claim is made by this ADR.

### 3. File-migration threshold

A requested fuse is accepted exactly when

`migrationCreditTokens >= interveningSuffixBillTokens`.

Credit is accumulated by the item producer and carried in metadata; this first
release consumes the supplied snapshot but does not mutate the store or invent
credit. Rejected and accepted moves both write a position-regret row with old
and target positions, suffix bill, credit, regret, acceptance reason, and
reversal status.

### 4. Convergence and defect diagnostics

Every `SolverResult` includes:

- `selectionPasses` (currently always one);
- `movePasses` (one on the quiet path);
- `capped`;
- `acceptedMoves`;
- `reversals`;
- `moveThrash`.

`Incumbent.previousMoves` optionally supplies the previous solve's accepted
moves. An exact opposite accepted move increments `reversals`, marks its ledger
row, and raises `moveThrash`. This is a defect signal, not an automatic policy
change.

### 5. Dual-axis TTL and provider breakpoints

`CacheModelParams.ttlMs` is optional. Cache snapshots may carry wall-clock write
or snapshot timestamps. When both a TTL and usable wall-clock stamps exist,
wall time decides freshness; otherwise turn TTL remains the fallback. This
applies to `CacheModel` prefix belief and solver rewrite/suffix expiry.

`billingQuanta(tokens, granularity)` and
`breakpointPrice(tokens, pricePer1k, granularity)` expose provider billing
breakpoints explicitly. Position migration credit remains denominated in exact
token mass, so the discriminating suffix identity is not obscured by rounding.

## Consequences

- Existing producers need no changes; all new fields are optional.
- Bases and temporal deltas can occupy different positions without caller-side
  re-solving.
- Legal ordering, timing threshold, rejected near-misses, convergence, and
  thrash are inspectable in one solver result.
- The common metadata-free path adds one quiet move scan and reports one move
  pass.

## Falsification and operational gauges

The implementation is falsified if a delta tail does not save exactly the
intervening mass, lineage precedence is violated, identical inputs yield a
different layout, quiet solves exceed one move pass, the cap is bypassed, or an
exact opposite move is not signaled. Operational adoption should also watch
layout flips, re-expansions, cache-hit mass, dead bytes, cap rate, rejected
position regret, and move-thrash rate.

## Explicit boundaries not yet modeled

- Automatic migration-credit accrual, decay, persistence, or store mutation.
- Arbitrary all-permutation placement, full radix-tree reconstruction, or a
  globally optimal batch move set; this release uses representative zone-tail
  and lineage-fuse branch points.
- Joint re-selection after moves, more than one MCKP call, or batch shared-break
  repricing inside the move threshold.
- Learned position value / lost-in-the-middle regret; the ledger creates the
  data surface but no fitted position-value model exists yet.
- Provider-specific nonlinear prices beyond the exported quantum helpers.
- Reordering-buffer deadlines, stochastic arrivals, or competitive-ratio
  guarantees.
- Delta extraction/serialization and producer-side lineage validation.
- Live A/B effectiveness evidence. Unit tests establish contract correctness,
  not production quality or cost improvement.

## Superseded draft claims

The draft's “≤2 exact engine calls” and “~1–5 ms at n=80” statements are removed.
The implementation makes at most one conditional MCKP call and no benchmark was
run or needed for this release. Keep-branch pricing, exact suffix mass,
cache-continuity zoning, and tail relief remain compatible special cases; this
ADR does not claim they have been formally retired or subsumed.
