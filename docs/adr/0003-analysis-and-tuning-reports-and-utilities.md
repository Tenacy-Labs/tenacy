# ADR-0003: Analysis and tuning — reports and utilities over the decision corpus

- **Status:** Accepted (overview; lettered sub-ADRs will detail specific tools)
- **Date:** 2026-08-21
- **Deciders:** Daniel Eisner (rulings), Robby (analysis)
- **Parent:** ADR-0000 · **Evaluates:** the ADR-0002 family
  (0002, 0002a–0002e)

---

**Summary.** The analysis and tuning layer: replay harness, six audit reports, refit pipeline, synthetic workload generator, and baselines/live A/B — the instruments that evaluate and tune the 0002 optimizer from its decision corpus.

**Key points**

- Offline mirror: query/extract → reports → review → refit → versioned parameter sets; read-only over the ledger — §1, line 40
- Replay harness: deterministic re-render under chosen params — cost-counterfactual only, never behavior-counterfactual — §2, line 62
- Six audits: cache belief, value forecast, hazard, rot, decision (thrash), cost — reliability-scored, corpus-carded — §3, line 77
- Refit pipeline: fit diagnostics + prior-divergence guards; review-gated adoption — §4, line 100
- Synthetic workload generator: planted ground truth validates the estimators; never silently merged with real corpora — §5, line 110
- Baselines (accumulator control, v1 analytic floor, incumbent render) + live A/B — the only source of behavior claims — §6, line 122
- Sequencing: instrument-first — ledger write path, reports 1/6, replay skeleton ship with the loop milestone — §8, line 151

**Contents** — Context 27 · Decision 38 · Consequences 161 · Risks / research areas 174

*(Line anchors are valid as of this revision.)*

## Context

The 0002 family built an online optimizer and named its closed loops —
cache, value, rot (ADR-0002 §2, §4; ADR-0002e) — and 0002e committed to
collecting decision ledgers across many runs and tuning forecasts and
utility parameters against them. Ruling this session specifies **what we
build to do that**: the analysis reports and utilities that turn the
corpus into evaluation, and the corpus into better parameters.

ADR-0002 optimized the context. This layer optimizes the optimizer.

## Decision

### 1. The offline mirror

The stack is the online system's mirror image, arranged around the
ledger:

```
            ┌────────────────────────── offline ──────────────────────────┐
ledger ──►  query/extract ──► reports (six audits) ──► human/agent review
   ▲        (indexes, views)                                     │
   │                                                            ▼
   │        replay harness ──► counterfactual A/B ──► refit pipeline
   │                                                            │
   └──────────── versioned parameter sets ◄─────────────────────┘
                (review-gated adoption, 0002e §3)

synthetic workload generator ──► bootstrap corpus (pre-traffic)
```

Everything reads the ledger; nothing mutates the store. Reports and
replays are deterministic functions of (corpus, parameter set) — the
same discipline as render.

### 2. Replay harness (foundational utility)

Deterministic re-render of a journaled session's store history under a
chosen parameter set — possible because render is pure and parameters
are version-pinned (ADR-0002e).

**The honesty boundary (recorded as a principle): replay is
cost-counterfactual, not behavior-counterfactual.** The journal's touch
stream is treated as exogenous; re-rendering answers "what would
placement/pricing/cache cost have been?" — valid for evaluating the
optimizer's decisions. It cannot answer "would the model have performed
better?" because the model's responses depend on the context it saw, and
the journal holds only what actually happened. Quality claims require
live A/B (§6); cost claims may come from replay.

### 3. Six audit reports

| # | Report | Forecast under test | Realized signal | Feeds |
|---|---|---|---|---|
| 1 | **Cache belief audit** | cacheBelief (hits, price) | usage reports, divergence classes | cache-model params |
| 2 | **Value forecast audit** | μ₀·(1+Δt)^−α | re-references per item/kind/age | μ₀, α per kind |
| 3 | **Hazard audit** | hᵢ (prior/observed) | realized invalidations | hazard priors |
| 4 | **Rot audit** | rot(Λ) curve | redo rate, instruction misses vs. Λ | λ, rot shape |
| 5 | **Decision audit** | margins, hysteresis | accepted vs. rejected near-misses, reversals | solver thresholds |
| 6 | **Cost report** | transaction costs | realized spend per turn/session/task | the money question |

Reports 2–4 are calibration reports in the strict sense: reliability
diagrams (forecast probability vs. observed frequency), bucketed by
kind, age, and parameter-set version — every forecast is a probability
claim and gets scored like one. Report 5 includes **thrash detection**
(accepted moves later reversed — the 0002b optimizer-thrash risk made
measurable). Report 6 always renders against baselines (§6), never raw.

All reports emit a **corpus card**: coverage (sessions, turns, items,
kinds, providers), missing-label rates (`unreported` share — 0002e §1),
and parameter versions included — so no conclusion is drawn from a
corpus too thin or too narrow to bear it.

### 4. Refit pipeline

Offline batch over the corpus → candidate parameter sets. Emits fit
diagnostics, not just numbers: residuals, confidence intervals, corpus
size per cell, and **divergence from priors** — the 0002e §3 guard:
priors hold until the corpus disagrees with confidence (the 0002b
parameter-sparsity risk, made operational). Candidate sets pass review
gating (the ADR-0001 discipline — anything that steers the optimizer is
reviewed like code).

### 5. Synthetic workload generator

The bootstrap problem: the corpus needs runs, tuning needs the corpus,
runs need confidence. The generator produces sessions with **known
ground truth** — planted re-reference distributions, planted hazards,
planted cache behavior — validating the estimators end-to-end: if refit
cannot recover known parameters, the pipeline is broken, not the world.
Doubles as the ledger layer's golden-test corpus (render golden tests
already exist, ADR-0002 §Consequences). Synthetic sessions live in a
**separate corpus partition, never silently merged** with real traffic
(§7).

### 6. Baselines and live A/B

Every optimizer claim is a comparison:

- **Accumulator + periodic compaction** — the industry default
  (0002's rejected alternative, kept as the control).
- **v1 zone ordering, no solver** — the analytic floor.
- **Incumbent previous render** — marginal value of each solver
  generation.

Metrics per baseline pair: realized cost per task, cache hit rate,
rendered-Λ distribution, invalidation spend, thrash rate, and — live
only — redo rate and task success. **Live A/B** splits fresh sessions
across parameter sets (provider-side randomness or scheduler
round-robin); it is the only source of behavior claims.

### 7. Principles

- **Ground-truth separation** — realized, replayed, and synthetic
  records carry provenance; reports state which class they draw on;
  synthetic never mixes into fit corpora silently.
- **Forecasts are probability claims** — scored with calibration
  machinery (reliability, proper scores), not eyeballed averages.
- **Read-only over the ledger** — analysis cannot mutate the store or
  the corpus; refit outputs are proposals until review-gated.
- **Deterministic and versioned** — a report re-run on the same corpus
  and parameter versions reproduces exactly; analysis artifacts carry
  their inputs.

### 8. Sequencing

1. **With the loop milestone (v1):** ledger write path, query/extract,
   reports 1 and 6, replay harness skeleton. The optimizer is born
   instrumented.
2. **Early traffic:** reports 2, 3, 5; refit pipeline v1 (priors +
   diagnostics); synthetic generator (estimator validation).
3. **At corpus:** report 4 (rot — needs outcome labels, the slowest
   signal); counterfactual A/B at scale; live A/B harness.

## Consequences

- 0002e's "collect logs and tune" becomes a build plan with named
  artifacts, an honesty boundary, and sequencing.
- The lab notebook (0002e) gets its instruments: six audits, one replay
  bench, one generator, one refit pipeline.
- Optimizer changes become experiments: candidate params → replay
  against corpus → live A/B → review-gated adoption — the same
  evidence chain in miniature that gates code.
- The self-conditioning risk (0002e) gains its audit tooling: version
  pins + corpus cards + prior-divergence reports make the loop's
  history inspectable.

## Risks / research areas

- **Exogenous-touch approximation** — replay treats the touch stream as
  given; placement changes would in reality alter touches. Cost
  counterfactuals are approximate; the error term shrinks with live A/B
  coverage, and reports state which class of claim they make.
- **Rot measurability** — redo rate and instruction misses are noisy
  proxies; report 4 may stay research-grade longest.
- **Tool sprawl** — six reports and four utilities invite over-building
  ahead of data; the sequence in §8 is load-bearing (instrument first,
  fit later).
