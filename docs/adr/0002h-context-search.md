# ADR-0002h: Context search — regex and semantic retrieval over store and journal

- **Status:** Accepted (guidelines subordinate to ADR-0002 / 0002g)
- **Date:** 2026-08-21
- **Deciders:** Daniel Eisner (rulings), Robby (analysis)
- **Parent:** ADR-0002g · **Ancestors:** ADR-0002e, ADR-0002f
- **Input:** this session — ruling that context manipulation requires
  search over the context: both regex-based and semantic
  (embedding-vector) retrieval.

---

**Summary.** Context search — regex and semantic retrieval over the two corpora cells cannot reach (the store and the journal): the discovery half of ctx.*, and the recovery path from summarization.

**Key points**

- Scope: the store (including the invisible context) + the journal verbatim; world files and the namespace stay cell-side — §1, line 38
- Journal search is the recovery path from 0002f summarization; the fidelity disutility is discounted by retrieval availability — §1, line 38
- Surface: ctx.search(regex) / ctx.find(semantic); results carry representation/rendered/recoverable; value channel at handle policy; search never mutates — §2, line 59
- Lexical v1: deterministic regex over text + metadata; ships with the loop milestone — §3, line 88
- Semantic v2: embeddings as DAG artifacts keyed (item, representation, modelVersion); async; costs ledgered — §4, line 94
- Searches are journaled behavioral signals — weak class, no automatic value bump — §5, line 111

**Contents** — Context 28 · Decision 36 · Consequences 121 · Risks / research areas 134

*(Line anchors are valid as of this revision.)*

## Context

ADR-0002g gave the model declarative manipulation (`promote`, `demote`,
`watch`) and enumeration (`inspect`), but enumeration does not locate —
you cannot promote what you cannot find. Ruling this session adds the
discovery primitive: search over the context object, lexical and
semantic.

## Decision

### 1. Scope: the two corpora cells cannot reach

- **The store** — rendered items plus the invisible context (dropped,
  purged, frozen items and their forecasts; ADR-0002g §3).
- **The journal** — full-fidelity verbatim history, including content
  summarization has de-rendered (ADR-0002f).

Explicitly out of scope: the world (files, code on disk, directories —
greppable and walkable from cells already) and the live namespace
(enumerable in code). Search exists for what only the coordinator can
see.

**Journal search is the recovery path from summarization.** 0002f made
lossy rendering safe (verbatim never destroyed); semantic recall over
the journal makes recovery cheap. Zoom-in generalizes from structural
`expand` ("turn 41") to content-addressed recall ("where did we decide
X"). Corollary, recorded as a calibration input: the standing
fidelity-loss disutility of a summarized item is discounted by
retrieval availability — optimal summarization aggressiveness rises as
recall cost falls.

### 2. The surface

```ts
ctx.search(pattern: RegExp, opts?: SearchOpts): SearchResult[];
ctx.find(query: string, k?: number, opts?: SearchOpts): SearchResult[];
//   semantic: query embedded once, cosine-ranked against item vectors

interface SearchResult {
  id: ItemId; kind: ItemKind;
  score: number;                 // lexical: match quality; semantic: cosine
  snippet: string;               // windowed excerpt, digest-stamped
  representation: "FULL" | "SUMMARY" | "MERGED" | "ABSENT";
  rendered: boolean;             // false = invisible context
  recoverable: "expand" | "promote" | "journal-read";
}

// SearchOpts: filter by kind / zone / turn-range / rendered-state;
// corpus: "store" | "journal" | "both" (default both).
```

Results return on the **value channel** at handle policy (summary +
digest to context, full structure to namespace) — the no-self-flooding
rule of ADR-0002g §4 applies to search results most of all: search
must cost less context than it finds.

**Search never mutates.** Results are read-only; recovery is the
model's explicit act — `expand` / `promote` / journal read — priced and
re-solved by the solver, per ADR-0002g §2 (signals, not overrides).

### 3. Lexical engine (v1)

Deterministic regex over item text and metadata (kind, tags, id,
upstream edges, unchanged-stamps). No infrastructure beyond the store;
ships with the loop milestone alongside `ctx.*`.

### 4. Semantic engine (v2)

- **Embeddings are derived artifacts** — DAG nodes over items
  (ADR-0002c §5), keyed `(itemId, representation, modelVersion)`;
  invalidation rides the item's own. A summarized turn may carry both
  its verbatim-journal vector and its summary vector.
- **Computed asynchronously** — at insertion or lazily on first search,
  in dreaming/maintenance turns, never on the render path (the
  ADR-0002f transform-execution rule).
- **Versioned by embedding model** — vectors from different models
  never interleave in one index; a model change is a re-embed under a
  new version, journaled and priced. Unversioned vectors would silently
  corrupt ranking and the 0003 corpus.
- **Costs ledgered** — the transform-cost class of ADR-0002f: embedding
  calls are lightweight-model invocations with token/price records in
  the decision ledger; query embedding is one call per search.

### 5. Searches are behavioral signals

Every query is journaled (pattern or query text, result set, which
results the model acted on). What the model searches for is task
relevance made visible — 0003 audit material, and a candidate input for
μ₀-by-task conditioning. **A hit does not bump value automatically**:
search touches are weak behavioral evidence, distinct from the
declarative class; whether they earn weight is a corpus question, not a
ruling (the self-conditioning guard of ADR-0002e applies).

## Consequences

- The ctx pipeline completes: **search → locate → recover** (expand /
  promote / journal-read) → solver re-prices. Discovery was the missing
  verb.
- 0002f summarization gains its safety net; the fidelity disutility
  gains a retrieval-availability discount term.
- The recall-set idea of ADR-0002 (future lens: "recall sets") gains
  its substrate — persistent curated retrievals are a lens over search
  results.
- The journal becomes a first-class queryable asset for the model, not
  only the analyst — one more audience for the truth layer.

## Risks / research areas

- **Embedding model churn** — version discipline is load-bearing;
  re-embed cost on version change is real and must be priced before
  adoption.
- **Index maintenance** — per-item vectors on hot substrates (live
  lenses) churn; lazy embedding with explicit materialization hints is
  the default.
- **Search-as-procrastination** — an introspection-cost variant
  (ADR-0002g): query spend is journaled and visible; the optimizer
  prices nothing here yet, but the data will say.
- **Ranking trust** — early semantic ranking with a weak embedding
  model may mislead more than help; v1 lexical is the honest floor, v2
  earns its place by corpus evidence (the 0003 discipline).
