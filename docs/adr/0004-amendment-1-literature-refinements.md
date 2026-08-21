# ADR-0004: Amendment I — literature-derived refinements to the 0002 family

- **Status:** Accepted (amendment — adds clauses and fixes interpretation; never retro-edits accepted bodies)
- **Date:** 2026-08-21
- **Deciders:** Daniel Eisner (rulings), Robby (analysis)
- **Amends:** ADR-0002 (objective, by interpretation) · ADR-0002b (value profiles) ·
  ADR-0002d (option surface) · ADR-0002e (divergence taxonomy) · ADR-0002f (profiles, lossy confidence)
- **Evidence:** `references/` (29 entries) and `references/ANALYSIS.md` (§2–§7), 2026-08-21

---

**Summary.** The research arc's six adjustment proposals (A1–A6), as ruled. Four accepted as proposed (one strengthened); two superseded by a stronger, more general ruling — **the option space carries the policy; the solver carries the tradeoff** — which becomes the amendment's centerpiece and a standing design principle for the renderer.

**Key points**

- Four rulings accept as proposed; two supersede their proposals with a general principle — §1
- A1: `error` kind in the versioned value-profile registry; failures are evidence — §2
- A2, strengthened: per-zone kind histograms now; rot fitted per LLM model, never pooled blindly — §3
- A3: named divergence class for provider usage-field semantics; eviction never reads summed counters — §4
- A4, superseded: no special pricing clause — the lens presents alternative representations; the solver prices compact-vs-distributed — §5
- A5, superseded: rendering options are backward-consistent — one purely-additive option where possible; cache abandonment is emergent — §6
- A6: lossy representations start penalized; confidence is earned by realized low regret — §7
- The option surface becomes a renderer v1 deliverable; ledger fields enumerated — §8

*An index of sections and key points, with line anchors, appears at the end of this file. If you edit this file, update that index to match.*

## Context

The deep-read analysis (ANALYSIS.md) distilled the field's evidence into ten reinforcements, ten
implementation warnings, and six proposed adjustments. This ADR records the Decider's rulings on
those six and their consequences for the corpus. The house rule holds: accepted ADR bodies are
never retro-edited; this document amends by addition and interpretation, with per-ADR disposition
recorded in §9.

## Decision

### 1. Rulings in brief

A1, A3, A6: accepted as proposed. A2: accepted and strengthened (per-model fitting). A4 and A5:
**superseded by ruling** — the Decider's versions replace special-case clauses with a general
mechanism: the solver's tradeoffs must emerge from a rich, honest option space, not from
hand-written pricing rules. Sections 5 and 6 quote the rulings.

### 2. A1 — error-evidence value profile (accepted)

Add an `error` kind to the versioned value-profile registry (ADR-0002b §6; ADR-0002f §1): failed
action–observation pairs are classed `error` at journal time and decay on a slower curve than
episodic content (a value floor for N turns is the equivalent parameterization; the profile
decides). Grounds: failures carry standing behavioral value ("erasing failure removes evidence" —
Manus) and are calibration labels the hazard estimator needs. Negative examples are not noise.

### 3. A2 — rot observability, fitted per model (accepted, strengthened)

v1 rot stays f(window size); the ledger records per-zone item-kind histograms each turn so ADR-0003
can later fit rot as f(size, density, coherence). **Strengthened by ruling:** fits are
**separately for each LLM model** — parameter sets (ADR-0002e §3) gain a model dimension; corpus
cards (ADR-0003 §3) state per-model coverage. Chroma's evidence is explicit that degradation
varies non-uniformly across model families; pooling across models would blur exactly the effect
being fitted. Cross-model pooling remains admissible only as a fallback prior, flagged and guarded.

### 4. A3 — cache-accounting divergence class (accepted)

The ledger's divergence taxonomy (ADR-0002e §4) gains a named class: believed-vs-realized cache
divergence caused by provider usage-field semantics — summed internal cache reads from server-side
tools inflating perceived context (documented in the Anthropic SDK at ~5×; the exact bug shipped
there). Standing rule: **eviction and compaction triggers read true `input_tokens`, never summed
cache-read counters.** Provider usage fields are recorded verbatim, never summarized into belief.

### 5. A4 — representation options, not special cases (superseded by ruling)

The proposal priced tool-definition mutation as a special full-prefix-rewrite clause. The Decider
ruled otherwise:

> "Our solver should inherently be able to make tradeoffs between writing a compact tool section
> at the front, vs splitting it into a few different sections spread throughout to balance the
> cache invalidation against content length. All we need to do is make sure our context lens
> provides the different alternative ways to represent the lens so the solver can pick the best
> one for the current solution space."

Interpretation: the objective already prices both sides of the tradeoff — prefix invalidation cost
and standing per-token cost. What was missing is not a clause but an **option surface**: a lens
may present multiple representations of itself (compact front block; distributed sections;
hybrids), each a normal candidate in the solver's search. No special case enters the objective.
The Manus evidence (tool schemas near the front; mutation invalidates the tail) becomes design
confirmation of why the option matters, not a rule encoding one answer.

### 6. A5 — backward-consistent rendering options (superseded by ruling)

The proposal recorded a determinism-vs-variation tension as a design note. The Decider ruled a
mechanism instead:

> "Each context object should present rendering options to the solver which are
> backwards-consistent (e.g., at least one purely-additive version) so that the solver has an
> option available to it which preserves the KV cache (if possible). The solver itself will make
> the appropriate tradeoff between keeping the KV cache or abandoning it as an emergent behavior,
> if we've set things up correctly."

Interpretation: **backward-consistent** — a rendering option that, relative to the current render,
only appends (never rewrites earlier bytes) and therefore preserves the cached prefix. Each
context object presents its options; **where possible, at least one is purely additive**, so a
cache-preserving path always exists. Cache-keep-vs-abandon is then an emergent solver tradeoff
under the existing objective, not a policy. This also dissolves the original tension cleanly:
determinism lives *within* each option (each serialization is byte-stable), and variation lives
*across* options (anti-mimicry becomes a priced dimension of the option space rather than injected
noise). "Where possible" is honest — a tool *removal* is inherently a rewrite; the option surface
must say so rather than fake an additive path.

### 7. A6 — summary-confidence ramp (accepted)

Lossy representations (SUMMARY/MERGED, ADR-0002f §1) start with a high fidelity-loss penalty as
prior; it relaxes only as realized-lossiness records accumulate low regret — re-expansion rate and
contrastive failures as triggers (ACON's discipline). Parameterization stance plus an explicit
adoption rule in the ADR-0003 refit pipeline; no structural change. v1 ships VERBATIM-dominant.

### 8. Consequences for the loop milestone

- **Renderer v1 gains a first-class deliverable:** the option surface. Every lens/item type
  presents rendering options; where possible one is purely additive (§6); tool-section placement
  is among the first option families exercised (§5). The template/option-choice log is journaled.
- **Ledger write path ships with:** raw provider usage fields verbatim + the standing rule (§4);
  per-zone kind histograms (§3); option-choice log (§5–§6); lossiness events (§7).
- **Profile registry opens with two entries:** error-evidence (§2) and the summary-confidence
  prior (§7).
- **Versioned parameter sets carry model identity** (§3).

### 9. Disposition against the corpus

No accepted body is edited. ADR-0002/0002b/0002d/0002e/0002f are amended by this document's
clauses as recorded above; ADR-0003's reserved lettered sub-ADRs inherit the observability fields
(§3 histograms, §4 divergence class, §7 ramp rule) where they live naturally. ANALYSIS.md §7's
proposed vehicle is hereby delivered as this ADR.

## Risks / research areas

- **Option-space growth** — per-object options are locally enumerable, but the composed space is
  combinatorial; the solver's horizon-limited search is the containment, and option counts per
  object are a corpus question (ADR-0003 decision audit will price the search itself).
- **"Purely-additive where possible"** — the boundary (when no additive option can exist) must be
  stated by the option surface, not discovered by cache misses; a mislabeled option is a ledger
  divergence of a new class.
- **Per-model parameter sets** multiply corpus requirements — slower refit confidence; corpus
  cards must state per-model coverage honestly, and pooled fallback priors carry divergence guards
  (ADR-0002e §3).
- **Mimetic drift under a stable option** — if the solver converges on one representation and
  holds it, Manus's few-shotting risk returns through the back door; the option log exists so
  ADR-0003 can test exactly this.

---

**Index** — line anchors as of this revision.

*Update this index whenever the file is edited.*

Sections:
- 1. Rulings in brief — line 37
- 2. A1 — error-evidence value profile (accepted) — line 44
- 3. A2 — rot observability, fitted per model (accepted, strengthened) — line 52
- 4. A3 — cache-accounting divergence class (accepted) — line 61
- 5. A4 — representation options, not special cases (superseded by ruling) — line 69
- 6. A5 — backward-consistent rendering options (superseded by ruling) — line 87
- 7. A6 — summary-confidence ramp (accepted) — line 108
- 8. Consequences for the loop milestone — line 115
- 9. Disposition against the corpus — line 126

Key points:
- Four rulings accept as proposed; two supersede their proposals with a general principle — §1 — line 16
- A1: `error` kind in the versioned value-profile registry; failures are evidence — §2 — line 17
- A2, strengthened: per-zone kind histograms now; rot fitted per LLM model, never pooled blindly — §3 — line 18
- A3: named divergence class for provider usage-field semantics; eviction never reads summed counters — §4 — line 19
- A4, superseded: no special pricing clause — the lens presents alternative representations; the solver prices compact-vs-distributed — §5 — line 20
- A5, superseded: rendering options are backward-consistent — one purely-additive option where possible; cache abandonment is emergent — §6 — line 21
- A6: lossy representations start penalized; confidence is earned by realized low regret — §7 — line 22
- The option surface becomes a renderer v1 deliverable; ledger fields enumerated — §8 — line 23
