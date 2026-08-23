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

## Provenance

Four reviewer runs total: A (initial dispatch, recovered from a mangled
goal — completed 2026-08-22 19:xx), A′ (re-dispatch), B, C. C1 and the
strand / prior-0 / H-floor findings were found INDEPENDENTLY by both A
runs — concurrence noted inline. First-A's verified-correct list
additionally cleared: churn credit semantics, sharedBillSurcharge math,
prior-0 zero-hits neutrality, write-turn/mass carry-forward on
digest-identical keeps.

## MAJORS — verified, tracked (recommended next session)

- ~~**A-M1** Exact-MCKP relief strand-blind~~ **FIXED** PR #17 (2026-08-22): strand cost = real prefix re-bill, wired into relief.: evicts front
  items, eats prefix re-bill. The docstring's strand pricing never wired.
- ~~**A-M2** T*=0 clamp defeated~~ **FIXED** PR #17 (2026-08-22): non-positive hValue collects no lookahead. at solver
  L77 — over-budget window still collects a full FV turn. (Found
  independently by both A runs; first-A measured −2.125 leaked at T*=0.)
- ~~**A-M3** Thrash detector dead~~ **FIXED** PR #18 (2026-08-22): decision-comparison restore. — thrashCount identically 0.
- ~~**A-M4** Gauge 4 wrong~~ **FIXED** PR #18 (2026-08-22): both halves. (per-item vs per-token ρ;
  (turn,id) join lets rejected row overwrite accepted keep).
- ~~**A-M5** Prior-0 evidence branch: any access evidence quarters value~~
  **RESOLVED (owner rulings 2026-08-23, PR #19 + follow-up):** prior-0 kinds
  evidence-NEUTRAL at every layer (value + variance); identity ANCHORED
  (structurally decayExempt — immune to recall and age); errors
  sticky-until-resolved (`err.resolve`, state-based floor, episodic glide);
  episodic prior split deferred to B-5 access data. ADR-0006 amendment note
  added; pins in `test/review-a-m5.test.ts` (RED-verified).
- ~~**A-M10** Tombstone-relief FV uncapped~~ **FIXED** PR #17 (2026-08-22): threads caps.hValue into tombFV.
  horizon (default 20) while keeps are T*-capped — over-budget windows
  overprice tombstones 0.419 util (419 MCKP units vs margin 0.15), biasing
  toward tombstoning exactly when the window is fullest. Threads
  `caps.hValue` into `tombFV`.
- ~~**A-M11** New-item re-entry margin flat~~ **FIXED** PR #17 (2026-08-22).
  L245 uses flat `ps.hysteresisMargin` while incumbent comparison uses
  variance-scaled `effectiveHysteresis` — inconsistent hysteresis pricing
  across the two paths (and the NaN-immune one).
- ~~**A-M6** hazardBasis never journaled~~ **FIXED** PR #18 (2026-08-22): journaled as its own signal. — observed-hazard
  items pool into prior buckets, contaminating hazard calibration.
- ~~**A-M7** Hysteresis-held rot estimate~~ **FIXED** PR #18 (2026-08-22).; Map-with-last-row-
  wins changed journaled rotShare 70× for held items.
- ~~**A-M8** Family-rescue flip unjournaled~~ **FIXED** PR #18 (2026-08-22).; relief sees stale utility —
  family can render zero content while ledgers claim keeps.
- ~~**A-M9** sharedBillCredit over-credits~~ **FIXED** PR #18 (2026-08-22): discounted suffix masses. (computed
  from undiscounted suffix masses).
- ~~**B-2** Session restore zeroes turn stamps~~ **FIXED (2026-08-23):** turn/notice rows persist and restore save-time createdTurn/lastTouchTurn via store.addRestored (no re-stamp); setTurn-order clobber eliminated.
  API's stamps; `setTurn` runs after the row loop).
- ~~**B-3** blockWriteTurns positional zip~~ **FIXED (2026-08-23):** carry-forward keyed by PREVIOUS chain digests (recovered from incumbent.rendered), not positional zip against the new chain.
  old write-turns positionally — inverts TTL provenance on non-prefix
  changes.
- ~~**B-4** Merge-group lifecycle~~ **FIXED (2026-08-23):** validation-before-mutation (no stranding), member upstreams → [groupId] (solver coupling; verbatim fallback reachable), MergeRow round-trips valueMass + memberIds.
  no verbatim escape; purge fallback unreachable — upstreams never set;
  groups don't round-trip; asymmetric in-merge pricing).
- ~~**B-5** noteLiveDelta no production caller~~ **FIXED (2026-08-23):** turn-boundary drain feeds noteLiveDelta (v1 coarse: affected lines = range union; snapshot defaults to live substrate slice). Lattice arms in live flow.
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
only; C-m9 suite lacks hazardBasis coverage. First-A adds: ttlWindowFree
now also dead-export (only own-file tests consume); m2's H-floor leak is
the T*=0 case of A-M2.

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
