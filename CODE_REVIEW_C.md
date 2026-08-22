# CODE_REVIEW_C — ADR-0006 conformance · UI/CLI surface · integration & roadmap honesty

- **Date:** 2026-08-22
- **Reviewer:** C (scoped subagent): ADR-0006 clauses, repl/tui/swarm surface, test/integration + roadmap tests
- **Head:** `e479b46` (ADR-0006 phase 3.5)
- **Method:** full read of ADR-0006 + the five ADR-0006 implementation files (evidence/horizon/suffix/params/solver) + loop wiring, repl/tui/swarm sources, roadmap/integration/gauges/horizon/evidence/suffix tests; independent execution of `bun test`, `tsc --noEmit`, `bun bench/corpus/gauges-baseline.ts`, and a live REPL smoke run. Every claim below was reproduced, not taken from comments.

## Executed verification (all real runs)

- `bun test` → **140 pass / 0 fail**, 334 expect() calls, 13 files, 6.43s
- `bunx tsc --noEmit` → **clean** (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- `bun bench/corpus/gauges-baseline.ts` → reproduces README's claimed numbers **exactly**: believed-hit 0.754, re-expansions/eviction 0.129, plus gauge-6 belief gap (MAE 218.2t, signature "growing-underbelief")
- REPL smoke (`bun src/ui/repl.ts < cmds`) → boots live `glm-5.2` from harness config, `/help /status /mem /provider` all respond correctly, `/mem` shows 3 persisted rows in `.agent-kernel/memory.db` (cross-run persistence real, and gitignored)

## ADR-0006 clause-by-clause conformance

### §2 property sheet — partially shipped, honestly additive

| Clause | Status | Evidence |
| --- | --- | --- |
| `refEvidence` (2.1) | **Shipped** | `store.recordAccess` + Beta-shrinkage posterior (`evidence.ts`, KAPPA=10, WINDOW=64); exactly-neutral when absent (factor 1, variance null) — the additive contract holds; solver consumes via `evidenceValueFactor`; ledger basis `prior/observed` journaled. Tests pin all of it. |
| `recoverability` (2.2) | **Plumbed but inert** | Solver consumes it (two-class q + fidelity-zero at solver.ts:137/460) — **but no production code ever sets it** (only tests plant it). Dream pass / merge factories never stamp `recoverability`, so every live MERGED/CONSOLIDATED is `undefined` → priced lossy → §3's ruled mispricing persists in production. |
| `churnProfile` (2.3) | **Not implemented** | Type stub in `types.ts:79` only; zero producers, zero consumers. |
| `forecastVariance` (2.4) | **Half** | Never stored on items; `effectiveHysteresis` computes posterior spread on the fly (acceptable), but the "realized-vs-expected divergence" half is absent. |
| `lastTouchTurn` demoted | ✅ | Value is evidence-scaled; recency is decay-clock input only. |
| `hazardOverride` → posterior | **Partial** | Watcher still writes a point EWMA-style number; no observation count / posterior. |
| `velocity` removal | **Tolerable stub** | Still a stored property, read only in `/inspect` display — matches §9's "derived debug view?" open question, but it was neither derived nor deleted. |

**Update-point honesty (§2.1):** of the four ruled access classes, only two are wired in production — `searchHit` (ctx.search) and `reExpanded` (files.expand restore). `cited` and `distilledFrom` have zero callers. Intent touches (promote/demote/goal updates) go through `store.touch()`, which updates only the decay clock — they never become evidence.

### §3 two-class recoverability — correct logic, cannot fire live
Covered above: the pricing is right and test-pinned (`horizon.test.ts` proves qRendered-class FV for verbatim-preserving MERGED), but without a producer the live solver never sees a recoverable consolidation. This is the biggest conformance gap.

### §4 transition-cost clauses — three of seven live

- **Exact suffix mass** ✅ live — `blockMass` is real per-block token mass fed from the renderer each turn; `suffixMassAfter` replaces the proportional share in `transactionCost` and the relief pass still uses the *old proportional* estimate (solver.ts:157, 411) — inconsistent pricing between the option scorer and the relief victim selector (minor).
- **Shared-bill credit (one break per position)** ⚠️ computed but **not journaled** — `SolverResult.sharedBillCredit` has zero consumers; `recordTurn` never receives it. The doc comment says "Journaled, not a selection input" — the journaling half is false as written.
- **TTL free-window** ⚠️ **structurally dead in production** — `loop.ts` rebuilds `incumbent.blockWriteTurns` as *current turn for every block, every turn*, so `turn − wt` is always 1 ≤ ttlTurns 6 and the expired-suffix branch (solver.ts:447–451) can never fire outside tests that plant old write turns. Honest block-write provenance would carry forward write turns for unchanged digests.
- **Suffix-liability trend, anti-Zeno, position-priced restructure exposure, layout moves as options (continuation pricing)** ❌ not implemented. The anti-Zeno clamp exists only as a margin clamp comment in `horizon.ts`.

### §5 T\* horizons — estimator live, one cap orphaned

- `standingMassDrift` EWMA (β=0.7) is real and `hValue = min(fv.horizon, T*)` genuinely caps the FV stream in `futureValue` — test-pinned ("tight T\* shortens the stream").
- **Deviation, disclosed in code:** the ADR estimator says drift EWMA *excludes restructures*; the loop includes them and comments the admission ("the honest drift signal while we lack per-move attribution"). Honest, but it biases T\* downward after restructure-heavy turns — exactly when §4 investments would be priced.
- `hCache` is computed and test-pinned but has **no consumer** (defensible — its consumer is the unbuilt cache-amortization pricing).
- §5 "T\* reported as a distribution / pessimile" — point estimate only (quantile left as §9 open question; the reporting half is simply absent).

### §6 retirement table — soft retirements only
`hysteresisMargin` survives as the anchor that variance scales (0.5×–2×) rather than being subsumed; the four cache patches remain patches (ADR itself predicts they retire only under the sequence objective); `fv.horizon` did become cap semantics ✅. `ALWAYS_HELD` + tombstone preference remain policy-in-code, which the ADR explicitly tolerates until the sequence objective.

### §7 gauges — genuine, reproducible, honestly nulled
Six gauges (flips, re-expansions/eviction, believed-hit, dead-token share, write-to-harvest, belief-gap-vs-LCP-truth). Write-to-harvest reports `null / basis "none"` when the scenario had zero restructures instead of fabricating a ratio — exactly right. Baseline rerun matches README to the digit.

### §8 phasing — naming conflation worth fixing
The ADR's phase ladder ends at **phase 3 = the sequence objective** (per-item H-horizon DP, continuation-priced layout moves). The repo's commits label the §4 transition-cost clauses as "phase 3" and gauge-6 as "3.5". The sequence objective itself — which §8 says is "in scope by this ruling, not deferred indefinitely" — is unbuilt. The README's implemented-features list is accurate and does *not* claim it, so this is labeling drift, not dishonesty; but a reader mapping repo phases to ADR phases will be misled. Hibernation clause (§8, turn survives restore, long-horizon first write) is genuinely honored by swarm revive + session restore.

### ADR hygiene
§-index line anchors all verified correct against the file. No retro-edits of accepted bodies detected.

## UI/CLI surface (repl.ts · tui.tsx · swarm.ts)

- **REPL** (385 lines): solid. Input queueing (never drop, `/quit` drains), SIGINT tame, live/mock boot policy, `/provider` mid-session swap re-pins ParamSet per A2, `/save` auto-indexes into memory (roadmap claim verified live). Local-intent parser covers 12 commands matching `/help`. `bindOps({memory, rlm})` at boot — model reaches host caps only through intents (credentials stay host-side; consistent with the security review's verdict).
- **TUI** (227 lines): compiles clean under the strictest tsc, sidebar projection (render/cache/goals) works, graceful shutdown with drain + 2s hard fallback. Three gaps:
  1. **No busy gate / no input queue** — `send()` has no guard; a line submitted while a model call is in flight runs a second `agent.run()` concurrently against the same AgentLoop (interleaved incumbent/render mutation). The REPL explicitly queues; the TUI silently races.
  2. **Surface parity drift** — no `/save /resume /sessions /mem /provider /ledger`; `/help` maps to `ctx.inspect all` (shows the store instead of listing commands — confusing).
  3. **No `bindOps`** — memory/rlm intents refuse honestly ("no host bound"), but the TUI is silently a lesser surface; nothing tells the user.
- **Swarm** (407 lines): reviewed against the jcode mapping table in its header — ancestry/subtree, mode-gated spawn, root-gated plan, reparent-not-orphan, coordinator-side single TS gate, soft-interrupt delivery, hibernation via `__stop` → snapshot recovery (never replay; the coordinator gate rebuilds from journal *audit source only*). All claims check out against `agent-worker.ts`. Minor: `#onWorkerMessage` treats `completion_report` and `final_response` identically (duplicate escape hatch); dropped DMs to unknown recipients are silent (comment admits "audit hook could log").

## Integration & roadmap tests — honest and discriminating

- **roadmap.test.ts** is what good roadmap tests look like: every shipped roadmap claim (FTS5 recall, embedding blend, kind filter, file-DB persistence, rlm handles + per-child/total usage attribution, transparent AttributionProvider, ops refusal-when-unbound *and* round-trip-when-bound, swarm hibernate→revive with snapshot proof) has a test, and the swarm suite includes a **fail-under-revert control** (same turn against a state dir with no snapshot must fail with TS2304/ReferenceError — proving the pass depends on recovery, not on the cell echoing). Only nit: the ops rlm test's `setTimeout(50)` fire-and-forget settle is timing-brittle in principle (MockProvider makes it safe in practice).
- **integration.test.ts**: one test, but a real end-to-end discriminator chain — purge under budget → planted fact absent from render → promote → fact back → stable zone → `cacheExpectedHit === 0` after the deliberate re-bill → `> 0` on the identical follow-up. Asserts the cache economics, not just absence/presence.
- **gauges.test.ts**: hand-planted corpus with *known* gauge values — the right design for a falsification instrument.
- **Docs drift (minor):** README says "134 tests green" (actual: 140) and Quick start says "bun test # 11 tests" (very stale). Status-section claims otherwise check out.

## Findings summary

| # | Severity | Finding |
| --- | --- | --- |
| C1 | **Major** | `recoverability` has no production producer — §3 two-class pricing is inert in the live pipeline; consolidation mispricing persists (dream/merge factories must stamp it). |
| C2 | **Major** | `blockWriteTurns` rebuilt as current-turn-every-turn → TTL free-window branch can never fire outside tests. Carry write turns forward for unchanged digests. |
| C3 | **Minor** | `sharedBillCredit` documented as "journaled" but no consumer/journal path exists — comment overstates. |
| C4 | **Minor** | Relief pass + hazard suffix still use the old proportional-share mass while option scoring uses exact `suffixMassAfter` — two different prices for the same suffix. |
| C5 | **Minor** | Re-entry margin (solver.ts:208) uses raw `ps.hysteresisMargin`, not `effectiveHysteresis` — §2.4/§6 "re-entry margins as risk pricing" only half-applied. |
| C6 | **Minor** | Evidence update points: `cited`/`distilledFrom` never recorded; intent touches don't create evidence — §2.1 loop closes for only 2 of 4 access classes. |
| C7 | **Minor** | Drift EWMA includes restructures, contra §5's estimator (admitted in a comment); biases T\* low exactly when §4 pricing matters. |
| C8 | **Minor** | Repo "phase 3" ≠ ADR §8 phase 3 (sequence objective unbuilt); rename or annotate to keep the phase ladder honest. |
| C9 | **Minor** | TUI: no busy gate (concurrent `agent.run()` race), no input queue, `/help` misleading, no ops binding, surface parity drift vs REPL. |
| C10 | **Nit** | README test-count drift (134→140; "11 tests" in Quick start); `velocity` neither derived nor deleted; `churnProfile` stub; `hCache` orphaned (defensible); pessimile absent. |

## Verdict

No dishonest claims found — every README number I rederived reproduces, tests assert discriminators rather than tautologies, and inert machinery is the failure mode, not fabrication. But two Major findings (C1, C2) mean the most consequential §3/§4 clauses, while correctly implemented and well-tested at the unit level, **cannot activate in the live system** — the ADR's "does the argmin change because this exists?" admission test currently answers "no" for recoverability and TTL windows in production. Both are small, localized fixes (stamp `recoverability` in the merge/dream factories; carry block write-turns forward on unchanged digests) and should land before the next phase is claimed.

Suite 140/140 green, tsc strictest clean, gauges baseline reproduced. Cleared on honesty; C1/C2 recommended as pre-next-phase fixes.
