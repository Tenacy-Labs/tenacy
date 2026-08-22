# Code Review B — Security + Data Integrity (feature/loop-milestone → main)

- **Date:** 2026-08-22
- **Reviewer:** B (fresh-context subagent): `ledger.ts`, `cache-model.ts`, `registry.ts`, `harness-config.ts`, `reports.ts` + all bench scripts (`bench/`, `bench/corpus/*`). Focus: credential audit, basis-priority soundness, pricing math, JSON robustness.
- **Method:** full read of every in-scope file + independent re-run probes; findings accepted only with reproduced evidence (house rule). Every probe below was executed against the working tree at `e479b46`.

---

## 1. Credential audit — verdict: clean, two notes

Traced every path a key can take: `buildProvider` (registry.ts:177) → `spec.build({apiKey,…})` → `createOpenAI/createAnthropic/…` — the key reaches only the vendor constructor and the HTTP header. It is never assigned to a ledger field, log line, error string, session row, or journaled signal:

- **Throw messages name the env var, never the value** — `buildProvider` ("`ZAI_API_KEY` not set and no harness config entry…"), `AnthropicProvider.call` (anthropic.ts:56). Verified by grep: no `apiKey` value is interpolated into any `Error()` or `recordSignal` payload.
- **Ledger cannot carry it structurally.** `CacheLedger.rawProviderReport` is set from `usage.raw` — the *parsed usage counters object* (`registry.ts:74` / `anthropic.ts:102`), which contains token counts only; the key lives in request headers, not the response body. `recordSignal` payloads are intent metadata (ids, turns, ranges).
- **`agents/config.json`** (the on-disk key store): gitignored (`agents/` in .gitignore), never committed (`git log --all -- agents/` empty), chmod 600 on disk. `loadHarnessConfig` reads it only; `availableProviders()` returns names only.
- **rlm children are handed a provider wrapper, never the key** (`rlm.ts` header claim verified: children wrap an existing Provider instance; no credential is re-resolved child-side).
- **Retry path doesn't leak either**: `callWithRetry` journals `error: msg.slice(0,120)` — provider error text (which vendors prefix with status codes, not keys), truncated.

Two non-blocking notes:

- **N1 (minor, hygiene).** `loop.ts` `callWithRetry` lowercases the whole error and matches substrings (`"rate"`, `"network"`, `"timeout"`). A *non*-transient error whose body merely contains one of these words (e.g. an HTML 400 page containing "network") would be retried twice with backoff before surfacing. Cost: 2 wasted calls + ~3s. Not a security issue.
- **N2 (minor).** `HarnessProviderConfig.apiKey` has no format validation — a truncated/copied-wrong key is indistinguishable from absent until the provider 401s. Acceptable for BYOK; noting for completeness.

## 2. Critical

None found in-scope. (The prior review's criticals — duplicate `err:` ids, `providers: null` — are fixed and regression-tested; re-verified the guards at `harness-config.ts:44-56` and `loop.ts:106/178`.)

## 3. Major

**B3. `cache-model.ts` `calibrate()` — providers that omit cache counters are recorded as "realized 0 hits", corrupting two gauges and one divergence class.**
When `usage` is present but `cacheReadTokens === undefined` (openai/grok/deepseek/qwen via the AI SDK frequently don't report cache detail), `realized.hitTokens = usage.cacheReadTokens ?? 0` → `{hitTokens: 0, price: 0}`, `divergence = "believed-cached-rebilled"` if belief >200t (cache-model.ts:71-81). "Unreported" and "zero observed hits" are *different epistemic states* — the codebase's own A3 rule says so — yet this path conflates them. Downstream:
- `reportCacheBelief` (replay.ts) counts the turn as *compared* with abs error = full belief → inflates `meanAbsErrorTokens`.
- `computeBeliefGap` (reports.ts:381-399) excludes only `divergence === "unreported"`; a `"none"`/`"believed-cached-rebilled"` record with realized 0 flows into Gauge 6 as genuine "overbelief" evidence.
- Probe (P1/P1b): expected 900t, usage present without cache counter → `realized: {"hitTokens":0}`, divergence `believed-cached-rebilled`; the same record yields `maeTokens: 900, signedMeanTokens: -900` in Gauge 6 — a fabricated belief-gap.
Fix: distinguish `cacheRead undefined` (unknown) from `cacheRead = 0` (observed zero): either keep `realized: null` + `divergence: "unreported"` when the counter is absent, or introduce a `counters-absent` class.

**B4. `reports.ts` `computeBeliefGap` — basis-priority violation: `input !== undefined` beats provider-realized *unconditionally*, including the degenerate empty-map case, and can emit NaN.**
The docblock (reports.ts:377-380) states priority: explicit harness truth > provider-realized > null. But:
- If `input` is supplied with an **empty `truthByTurn`** (harness computed nothing), `pairs = []` → `n = 0` → `mae = 0/0 = NaN`, `signedMean = NaN`. Probe (P2): `maeTokens: NaN`. `classifyBeliefGap(0, NaN, NaN)` → `"insufficient"` masks it, but `JSON.stringify({mae: NaN})` → `{"mae":null}` — the report serializes `null` fields; a consumer can't tell "no data" from "NaN corruption". `writeToHarvest`… not affected, but gauges-baseline.ts emits this object verbatim (`JSON.stringify` at line 71).
- Semantics: when providers DO report realized hits (live corpora) and the harness ALSO supplies a truth map, harness truth silently overrides — by design, fine — but there is no `compared`-floor: `input` present with 1 truth entry yields `basis: "lcp-truth"` from one point while dozens of provider-realized turns exist. The basis-priority code should fall back to provider-realized when `truthByTurn` yields **zero** comparable pairs (empty map = no truth supplied, not "truth = nothing cached").
Fix: `if (input !== undefined && hasAnyTruth) basis = "lcp-truth"` else fall through to realized; guard `n === 0 → return null`.

**B5. `ledger.ts` `#flush` — a failed append destroys the batch *and* fires an unhandled rejection.**
`#flush` splices the batch off the queue *before* `await appendFile` (ledger.ts:58-60); there is no `catch` — errors propagate out of the async method, and callers do `void this.#flush()` (fire-and-forget). Probe (P4): ledger path is a directory → `EISDIR`; result: `queue.length === 0` (the two records are gone — silent data loss), and the rejection surfaces only as a Node `unhandledRejection` (in Bun it printed; in a long-lived host it can be fatal depending on `--unhandled-rejections` mode). `drain()` also exits its guard loop while `flushing === false` and queue empty → reports success despite lost records. The append-only journal is the project's calibration source of truth; losing a batch silently biases every report.
Fix: wrap in try/catch — on failure, `this.queue.unshift(...batch)` (retry on next record) or record a counter; `drain()` should surface the failure (throw or return a count).

**B6. `bench/corpus/maxsuite.ts` — top-level suite body has no `import.meta.main` guard; importing it re-runs the entire benchmark and **overwrites `dumps/maxsuite.json`**.**
Probe: a scratch file that only does `import { lcpTokens } from "../maxsuite.ts"` executed the full 10-scenario suite (output: "s1-orient: kernel 722t peak …") and rewrote `bench/corpus/dumps/maxsuite.json` (mtime bumped to run time). `longsuite.ts` and `gauges-baseline.ts` both import from `maxsuite.ts` — every `longsuite`/`gauges-baseline` run first re-runs the full maxsuite and clobbers its dump before the importer's own work. Any report generated from `maxsuite.json` is therefore *one accidental import* away from being silently regenerated against the current working tree. (longsuite writes its own file; maxsuite.json is the shared artifact that gets clobbered.)
Fix: wrap the main body in `if (import.meta.main) { … }` (Bun idiom), export the helpers.

## 4. Minor

**B7. `cache-model.ts:76` — `2.5×inputTokens` A3 anomaly threshold is hardcoded and comment says "~5x anomaly".** Comment/code mismatch; also `pricePer1kCached` pricing uses a linear hit-price while `rePrelillCost` spreads — fine — but the divergence-class thresholds (200t / 25% / 500t) are magic numbers with no param pin. ADR discipline (every ledger entry pins its paramset) argues these belong in `CacheModelParams`.

**B8. `rePrelillCost` and `blocksToChain` are dead exports** (grep: zero callers outside their own module/tests). Either wire `rePrelillCost` into the postanalysis dollar model (it's the honest "re-prefill spread" the analysis scripts re-derive inline) or drop it.

**B9. `reports.ts` `reportDecision` — phantom reversals inflate thrash metrics.** The solver emits, for one held incumbent, a keep-row (`accepted:true`) **plus** a rejected-challenger row (`decision:"drop", accepted:false`) in the *same turn* (solver.ts:193-196). `reportDecision` groups by id, sorts by turn, and counts `a.accepted !== b.accepted` within a 3-turn window — probe (P-phantom): that single turn yields `thrashCount: 1, thrashRate: 0.5, reversals: [{fromTurn:5, toTurn:5, keep→drop}]` — a "reversal" where no state ever changed. Filter: only compare rows with `accepted === true` (actual placements), or dedupe per (turn,id) before the sweep.

**B10. `solver.ts:157/411` — hazard premium and relief-damage still use the proportional block-share approximation while exact `blockMass` is available on the same object.** ADR-0006 §4's stated point was replacing that approximation (`suffixMassAfter`); the premium (`suffixTokensH`) and `worstDensityDroppable` (`strandTokens`) weren't migrated. With skewed block-mass distributions the premium misprices front blocks. Also `suffixTokensH` when `prev === undefined` uses position 0 → charges the hazard premium on a *fresh* item's full suffix even though no incumbent prefix exists to strand (fresh entries have no re-bill exposure beyond their own write, priced separately).

**B11. `bench/corpus/run.ts` — `budgetState.over` is set but never consulted.** The `onTurn` hook prints "✗ OVER BUDGET" and sets `budgetState.over = true` (run.ts:66-69), but `runScenario`'s `ok` never reads it; a live run that blows the window still exits 0 ("ALL SCENARIOS PASS") as long as recall strings hit. Pass criterion 3 ("rendered tokens stayed <= contextWindow every turn", header comment) is not actually enforced. Probe: grep — `over` written at :68, reset at :125, read nowhere.
Fix: `ok = ok && !budgetState.over` before return (live mode).

**B11b. `bench/corpus/run.ts` live mode hardcodes `buildProvider("zai", {})`** while the config file may specify a different provider; the contextWindow *is* honored from config but the provider is not. Docstring says "live model" generically. Minor footgun for A/B runs against another vendor.

**B12. `loop.ts` incumbent `blockWriteTurns` is re-stamped every turn for every kept block** (`blockWriteTurns: rr.blocks.map(() => this.turn)`, loop.ts:213), so `turn - wt ≤ 1` always for kept blocks → the ADR-0006 §4 TTL-expiry "free restructure window" (`turn - wt > ttlTurns` in `transactionCost`, solver.ts:447-451) is unreachable in the integrated loop (probe P5: after 10 turns, distinct write turns = 1 of 19 blocks). The write-turn should track the turn the block's bytes were *last actually written/changed* (digest match ⇒ keep prior stamp), not the render turn. Currently the clause is only exercisable in unit tests with hand-built incumbents — the ADR's "free-restructure moment" never fires live.

**B13. `bench/corpus/emergence.ts` — 6 of ~24 ideals are tautologies (`check: (r) => true`) with comments pointing at other files.** They still count in the pass-rate denominator's numerator when passing. Slightly inflated "IDEAL PASS RATE" (documented inline, but the printed rate makes no distinction). Either score them from the recorded structure (most already have the data in `TurnRecord`) or exclude from the count with a "deferred" bucket.

**B13b. `bench/corpus/longanalysis.ts` — L3 ideal "delayed-return turns re-expand rather than guess" matches labels that don't exist.** The check filters turns whose `label.startsWith("say Re-checked")` — but maxsuite records that label as `"distill Re-checked bench/…"` (`record("distill " + …)`, maxsuite.ts:190) — probe on the shipped `longsuite.json`: `startsWith("say Re-checked")` → false for every turn. The ideal silently returns `null` (not scored) or, if any label matched, would trivially pass. As shipped, it never evaluates.
Fix: match on `label.includes("Re-checked")` or on optionChoices containing the re-expanded lens ids.

**B14. `loadCorpus`/`loadLedger` — a single torn trailing line (crash mid-append) makes the entire corpus load throw** (`JSON.parse` per line, no per-line try/catch; probe P3: `SyntaxError: Unterminated string`). The Ledger appends multi-line batches; a crash between lines is exactly the expected corruption mode. Reports then fail wholesale instead of skipping the torn line. Fix: per-line try/catch + a `skippedLines` count on the CorpusCard (data-quality honesty).

**B14b. Same files: no `t`-field validation on parsed records.** `rec as unknown as TurnLedger` casts anything with `t:"turn"` — a truncated-but-valid JSON line (e.g. `{"t":"turn","turn":3}`) loads with `layout: undefined` and later `t.layout.reduce` throws in `reportGauges`/`reportRot`. Structural validation of at least `turn`, `layout` presence is cheap here.

**B15. `postanalysis.ts` C4 sentence overstates**: "lcpHit ≥ believed on 103/103 comparable turns — the CacheModel systematically UNDER-estimates". I re-derived: 103/103 confirmed on the shipped dump (real, good). But "systematically" from one suite, one scenario family, mock provider — the statement should be scoped to this corpus (it elsewhere is; that one sentence isn't). Cosmetic.

**B16. `maxsuite.ts` `runAccumulator` — `ps.cache.pricePer1k*` loaded via `paramSetV1("mock")` for the cost model while kernel side uses the real model's paramset.** Prices are identical in v1 defaults so numbers match today, but the two harnesses' cost bases are only accidentally aligned; a per-model price table (A2) will silently diverge them. Pin both to one explicit price constant in the script (longanalysis.ts already does this correctly with `PRICE`/`CACHE`).

**B17. `harness-config.ts` `paramSetFor` — `contextWindow` guard requires `Number.isInteger`, but `loadHarnessConfig`'s blank-string handling means `"2048.0"`-style JSON numbers (valid JSON, non-integer float) are rejected as null silently.** Fine as policy; note the file then behaves as *absent* (no provider keys read either!) — a malformed `contextWindow` disables the whole config including credentials, with no warning path. A `console.warn` on guard rejection would save an operator session.

**B18. `registry.ts` model resolution ignores env-var tier.** Credentials resolve explicit > env > file, but `model` resolves explicit > file > default — there is no env tier for model, while `AGENT_KERNEL_CONFIG` (path) is env-driven. Consistency nit; also `opts.model === ""` treated as unset (good, matches B2 fix) but `cfgProvider.model === 0`/non-string types aren't guarded (JSON could hold `model: 123` → passed to vendor → provider 400 with a confusing message).

**B19. `solver.ts` dead code:** `zoneOf` (line 365, superseded by `zoneOfDyn`, zero callers), `import { estTokens }` (unused). Harmless; tidy.

**B20. `cache-model.ts` `expectedHit` — TTL freshness check compares `this.turn - believed.turn <= ttlTurns` per block, but `update()` re-stamps every block's turn each call** (same root cause as B12). So believed TTL expiry also never fires live: the model believes everything it last rendered is fresh forever, diverging from provider reality (Anthropic 5-min wall-clock). Combined with B3 this is why Gauge 6 on live corpora will read "growing-underbelief" even when the true cause is TTL expiry the model itself caused. This is the belief-model half of the B12 fix.

**B21. `bench.ts` (src/optimizer) `runTask` catches check errors but still returns `outcomes` — good; but `valueDensity` mean of per-turn `placements.length/renderTokens*1000`** mixes an apple (items per 1k tokens) into a "value" density metric without weighting by tokens; a 1-token placement at the head dominates small-turn means. Metric nit only (test-only surface).

**B22. `sessions.ts` `restoreSession` — no row-level validation.** `JSON.parse` of a tampered/partial session file is cast wholesale; `r.ranges` could be anything (attachLens does use it as `[[n,n]]`). A malformed ranges array (`"ranges": "1-40"`) flows into lens math and fails far from the cause. Low risk (local file, same trust domain), noting for the crash-log quality.

## 5. Basis-priority soundness (dedicated pass)

- Credential basis (registry): **sound** — blank-as-unset at every tier verified in the fixed `??` chain; explicit > env > file preserved; error thrown when all absent. Prior finding B2's fix holds.
- Model basis (registry): sound but asymmetric vs credentials (B18).
- Cache-belief basis (cache-model/Gauge 6): **B3 + B4 are the two real defects** — absent-counter conflation and empty-truth-map NaN/override. With those fixed, the documented priority (harness LCP > provider-realized > null) matches the code.
- Forecast basis (`prior`/`observed` in ItemLedger): set correctly at solver (hazardOverride → observed; refEvidence → observed); reportHazard buckets on it properly.
- Corpus provenance: synthetic/realized partition enforced at generation (`synthetic.ts`) and carded — sound.

## 6. Pricing math (dedicated pass)

- `expectedHit`/`calibrate` price terms: `tokens/1000 × pricePer1k` — consistent everywhere (cache-model, maxsuite cost, longanalysis PRICE/CACHE at $3/M — units consistent: 3/1e6 per token = pricePer1kUncached 3.0/1k ✓).
- `transactionCost`: keep → 0; additive → cached-price write ✓; fresh → uncached write ✓; rewrite → own + suffix spread ✓; TTL-expired collapse — logic correct in isolation (unit-tested) but unreachable live (B12).
- `sharedBillSurcharge`: leftmost-break credit — algebra checks out (sum − leftmost charged at spread, negative credit); single restructure → 0 ✓.
- Two defects noted: B10 (proportional approximation retained in two solver paths) and B16 (accidental price alignment between harnesses).

## 7. What I checked and found clean

- Manifest/A2 per-model param pinning on every TurnLedger (`modelId`, `parameterSetVersion`) — present.
- Determinism of MockProvider/ScriptedProvider (call-order-dependent `#calls` in `raw` — journal-only, harmless).
- `scenarios.json` parse robustness (bench scripts) — wrapped in try/catch where it matters (fileLineSlice), bare `JSON.parse` at boot (acceptable: fixture in-repo).
- Postanalysis C1/C3 headline numbers re-derived from the shipped dump: **all match** (kernel over-Λ 0 vs accum 41; s3 2048 vs 2557; STRESS-A 1632 vs 4346; 103/103 one-sided LCP). The manual-verification culture holds up under independent recomputation.

## 8. Honest limitations

- I did not run the 50k-window longsuite end-to-end (runtime); B13b was verified against the *shipped* `longsuite.json`, not a fresh regen.
- B12/B20's live-loop claim is verified on the mock path; a live provider that actually expires cache could in principle produce different incumbent patterns, but the re-stamping is in `loop.ts` before any provider interaction, so the conclusion is structural.
- registry.ts line 29 displays `apiKey: ***` in my file view — byte-level `od` check confirmed the on-disk text is the plain type annotation (`apiKey: string;`); display artifact only, not repo content.
