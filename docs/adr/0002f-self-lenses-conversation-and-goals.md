# ADR-0002f: Self-lenses — conversation history and goals & objectives

- **Status:** Accepted (guidelines subordinate to ADR-0002 / 0002b / 0002d)
- **Date:** 2026-08-21
- **Deciders:** Daniel Eisner (rulings), Robby (analysis)
- **Parent:** ADR-0002d · **Ancestors:** ADR-0002, ADR-0002b, ADR-0002e
- **Input:** this session — rulings on the conversation-history lens
  (lightweight-LLM summary transforms, disutility terms, utility-driven
  "compaction") and the goals & objectives lens (hierarchy, horizons,
  tool-gated updates, foundational placement, decay exemption).

---

**Summary.** Self-lenses: the conversation lens (verbatim/summary/merged representations priced by mean-variance — the system's only compaction, utility-driven) and the goals lens (tool-gated, foundational, decay-exempt while active).

**Key points**

- Self-lens category: conversation (the observed past) and goals (the declared future) — in-process, perfectly observable — §1
- Conversation representations: VERBATIM/SUMMARY/MERGED, chosen by the solver under transform cost + standing fidelity-loss disutility — §2
- Lossy in render, never in store; re-expansion after summarization is journaled realized lossiness — §2
- Goals: hierarchical, horizon-stratified; mutation only via goals.* tool; foundational pinned placement — §3
- First per-kind value-profile override: active goals exempt from power-law decay — lifecycle-bounded; zombie-goal risk flagged — §3

*An index of sections and key points, with line anchors, appears at the end of this file. If you edit this file, update that index to match.*

## Context

ADR-0002d's lens family watches the world (files, code, directories,
namespace). Two further lenses have substrates inside the session
itself: the **conversation lens** — the observed past — and the **goals
lens** — the declared future. Both are in-process and perfectly
observable. Rulings this session specify them, and in doing so introduce
two new mechanisms: priced **lossy representation** (the first lossy
transform in the system) and per-kind **value-profile overrides** (the
first declared exemption from the power-law decay of ADR-0002b §2).

## Decision

### 1. The self-lens category

| Lens | Substrate | Mutability | Observability |
|---|---|---|---|
| Conversation history | the session's own record | append-only (immutable entries) | in-process, free |
| Goals & objectives | the model's declared intent | tool-gated explicit updates | in-process, free |

World-lenses answer "what is true outside"; self-lenses answer "what
happened here" and "what should happen here." Conversation entries are
episodic-immutable (ADR-0002 §2); goal items are stable between
explicit updates.

### 2. Conversation lens: representation transforms

Per turn, the lens may render in one of several representations:

- **VERBATIM** — the full record (default for recent turns).
- **SUMMARY** — a lightweight-LLM transform of one turn.
- **MERGED** — one transform combining several contiguous turns
  (amortizes the call; boundaries chosen by the solver).

The mean-variance solver decides representation per turn/group
(per ruling — "for rendering purposes to be decided by the
mean-variance"), under the standard objective plus two new disutility
terms:

- **Transform cost** — the price of the lightweight-LLM call, incurred
  at creation, one-time. Logged in the decision ledger (ADR-0002e):
  tokens in/out, price, fidelity parameters, trigger.
- **Fidelity loss** — a standing disutility while a lossy representation
  renders. Research-graded until outcome data exists (§Risks).

**Lossy in render, never in store.** The journal retains verbatim
records at full fidelity regardless of representation; summarization
de-renders detail, it does not destroy it. `expand` on a summarized
turn re-materializes verbatim (zoom-in at re-materialization + cache
cost); summarize is zoom-out at LLM-call cost. The expand algebra
(ADR-0002d §2) covers both directions. **Re-expansion after
summarization is journaled as realized lossiness** — a model repeatedly
restoring verbatim is reporting the summary was premature; this closes
the fidelity loop and feeds the ADR-0003 value audit.

**This is the closest the system comes to compaction** (ruling) — but
utility-driven, never "fill the window then compact." Recency
protection emerges from existing machinery, with no new mechanism:

- Value decay: recent turns carry high vᵢ; summary cannot beat verbatim
  while vᵢ is high. Old turns decay until the summary's lower bound
  wins.
- Cache economics agree independently: conversation history is natively
  BASE+DELTA (append-only deltas at the tail); consolidating old turns
  into summaries rewrites early, cheap positions, while rewriting the
  recent tail would invalidate everything after it (ADR-0002b §4
  positional risk).

**Transform execution is asynchronous.** The solver decides; the
lightweight-LLM call runs in dreaming/maintenance turns (ADR-0002 §2),
never inside render — decision and effect decouple by a turn; render
stays pure and golden-testable.

### 3. Goals & objectives lens

- **Hierarchy and horizons** — goals decompose into subgoals (a
  focusable tree; expand/focus applies) and stratify by horizon
  (session / task / standing), mirroring the portfolio horizons of
  ADR-0002b.
- **Tool-gated mutation** — the model updates goals only through
  explicit `goals.*` calls (set / update / complete / decompose).
  Updates are declarative journal signals (the toggle class of
  ADR-0002d §7): high-confidence, low-frequency intent. Hazard =
  observed edit rate.
- **Foundational placement** — active goals render with foundational
  context near the pinned head (identity zone), cache-pinned. Among the
  most stable objects in the window while active.
- **Value-profile override — decay exemption** (ruling): active goals
  do **not** follow vᵢ = μ₀·(1+Δtᵢ)^−α. A goal's value is standing,
  not re-reference probability: disuse does not make a goal irrelevant.
  This is the first declared instance of a general mechanism — per-kind
  value profiles selectable in the parameter sets (ADR-0002e §3).
  Research flag: neglect salience — an unaddressed goal's value may
  *rise* with age rather than hold.
- **Lifecycle restores decay** — on completion or supersession, the
  goal converts to an episodic record ("done" / "superseded by"),
  rendered per normal episodic economics; the exemption applies only
  while active.

## Consequences

- ADR-0002d's family table gains the self-lens category (two rows);
  the lens algebra (focus/expand/release) covers both — including
  lossy zoom levels on the conversation lens.
- ADR-0002b §2's value model gains per-kind **value profiles**; the
  power law is the default profile, not a law. Goals are the first
  override; the conversation lens uses the default.
- ADR-0002's "store maintenance (summarize old episodic items)" is
  refined: summarization is a priced representation decision of the
  conversation lens, proposed by the solver, executed in dreaming turns
  — not unpriced background maintenance.
- The decision ledger (ADR-0002e) gains transform records and
  re-expansion events; ADR-0003's value audit gains the fidelity
  dimension (summarize-then-re-expand sequences).
- The goals plugin (goals/scheduler, sequenced after the loop in
  ADR-0002) owns the `goals.*` surface; goal items enter the store
  through the lease (ADR-0002a §3).

## Risks / research areas

- **Fidelity penalty calibration** — the lossiness disutility is a
  guess until re-expansion and outcome statistics accumulate; the
  corpus tunes it (the 0002e theme).
- **Zombie goals** — an active goal never decays and never evicts;
  explicit completion must be the only exit, and stale-active goals
  should surface (render-time staleness marking is a candidate, not a
  ruling).
- **Merge boundaries** — combining turns across topic boundaries
  damages summaries; the merge-window heuristic is research, informed
  by re-expansion statistics.
- **Transform call discipline** — summarization must never run on the
  render hot path; dreaming-turn scheduling with a budget, journaled.


---

**Index** — line anchors as of this revision.

*Update this index whenever the file is edited.*

Sections:

- Context — line 26
- Decision — line 37
- Consequences — line 125
- Risks / research areas — line 144

Key points:

- Self-lens category: conversation (the observed past) and goals (the declared future) — in-process, perfectly observable — §1 — line 39
- Conversation representations: VERBATIM/SUMMARY/MERGED, chosen by the solver under transform cost + standing fidelity-loss disutility — §2 — line 51
- Lossy in render, never in store; re-expansion after summarization is journaled realized lossiness — §2 — line 51
- Goals: hierarchical, horizon-stratified; mutation only via goals.* tool; foundational pinned placement — §3 — line 99
- First per-kind value-profile override: active goals exempt from power-law decay — lifecycle-bounded; zombie-goal risk flagged — §3 — line 99
