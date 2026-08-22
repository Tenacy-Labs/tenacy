# CODE REVIEW — fresh-context, range 9253429..d92f6cb (PRs #8–#15)

Three scoped parallel reviewers (A: pricing core; B: runtime/state/persistence;
C: analysis/tests/docs), each in an isolated context with the diff + full
files. Every CRITICAL/MAJOR below was independently re-verified by the
orchestrator against the code (direct read or probe) before disposition.

## Verdict

The range ships real, working machinery (exact-MCKP default, lattice,
battery, churnProfile, TTL e2e — 824/824 green at merge time) but carries
**4 confirmed criticals, ~14 majors, ~12 minors**. All criticals fixed in
this branch with discriminating regression pins; majors tracked below
(fix-now candidates next session); minors documented.

## CRITICALS — all fixed + pinned

- **B-1** `StandingItem.toContextItem()` hardcoded `kind:"episodic"` (PR #14
  sed-repair casualty): identity/directive became evictable α=1 episodic,
  session rowType corrupted. FIX: `kind: this.kind` restored; pinned in
  `test/kind-integrity.test.ts` (all item families).
- **C1** `evidenceVariance` negative when hits > observedTurns (multi-access
  turns) → NaN hysteresis → always-move discriminator. FIX: n counted by
  distinct hit turns, positivity guard; pinned in
  `test/review-criticals.test.ts`.
- **C2** NaN `hazardOverride` passed the min/max clamp → NaN utility →
  solve() threw via knapsack validator. FIX: `Number.isFinite` gate falls
  back to the kind prior; pinned.
- **C3** Watcher fed lifetime event TOTAL as `ewmaChurn` (per-turn rate
  contract) → renewalCredit saturated → churned lenses priced fully fresh
  forever. FIX: true per-turn EWMA in the watcher (`churnEwma`), lifetime
  total kept for `shouldDemote` (also fixes B-9's conflation); pinned.

## MAJORS — verified, tracked (recommended next session)

- **A-M1** Exact-MCKP relief strand-blind (`void strand`): evicts front
  items, eats prefix re-bill. The docstring's strand pricing never wired.
- **A-M2** T*=0 clamp defeated by `Math.max(1, floor(hValue))` at solver
  L77 — over-budget window still collects a full FV turn.
- **A-M3** Thrash detector dead after B9 dedupe — thrashCount identically 0.
- **A-M4** Gauge 4 wrong both directions (per-item vs per-token ρ;
  (turn,id) join lets rejected row overwrite accepted keep).
- **A-M5** Prior-0 evidence branch: any access evidence quarters value
  (`Math.max(KAPPA*0.05, 1)` identically 1 — dead subexpression).
- **A-M6** `hazardBasis` computed but never journaled — observed-hazard
  items pool into prior buckets, contaminating hazard calibration.
- **A-M7** Hysteresis-held items keep §1 rot estimate; Map-with-last-row-
  wins changed journaled rotShare 70× for held items.
- **A-M8** Family-rescue flip unjournaled; relief sees stale utility —
  family can render zero content while ledgers claim keeps.
- **A-M9** sharedBillCredit over-credits in TTL-expiry windows (computed
  from undiscounted suffix masses).
- **B-2** Session restore zeroes turn stamps (`store.add` clobbers restore
  API's stamps; `setTurn` runs after the row loop).
- **B-3** `blockWriteTurns` carry-forward zips new-chain digests against
  old write-turns positionally — inverts TTL provenance on non-prefix
  changes.
- **B-4** Merge-group lifecycle unsafe (failed merge strands members with
  no verbatim escape; purge fallback unreachable — upstreams never set;
  groups don't round-trip; asymmetric in-merge pricing).
- **B-5** `noteLiveDelta` has no production caller — the lattice never
  arms in live flow (test-only machinery). Largest live-path gap.

## MINORS (documented, backlog)

A: m1 purge counted as eviction in Gauge 2; m2 dead code (zoneOf, estTokens
import, hCache test-only); m3 relief tombFV inconsistencies vs §1. B: B-6
split-fragment duplicate-add (fixed + pinned this session —
`test/fragment-crash.test.ts`); B-7 error-evidence degrades to notice across
save/restore; B-8 watcher.deltas unbounded growth, zero readers; B-10
transient-retry matcher false positives ("rate" substring); B-11 /resume
with same lens throws; B-12 code: prefix stripping inconsistent. C: C-m1
battery wholesale-replace vacuous assertion — REPAIRED this session into a
falsifying test that caught the NS dangling-prefix defect (fixed with
root-walk fallback); C-m2 review-fixes.test.ts M5/B12/B20 prefix-stable
only; C-m9 suite lacks hazardBasis coverage.

## Security

No credential/key value reaches any log, ledger, error, or journal — all
three reviewers probed; clean.

## Fixed this session (this branch)

- B-1 (critical), C1, C2, C3 (criticals)
- B-6 split-fragment duplicate-add crash (upsert in materializeFragments)
- NS wholesale-replace dangling prefixes (root-walk fallback in
  #focusableListing)
- Battery wholesale-replace test honesty (falsifying invariant)
- buildProvider test honesty (real path, all key tiers controlled)

Suite: **831/831** (was 824 at range tip), tsc clean (filtered noise).
