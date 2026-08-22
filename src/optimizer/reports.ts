/**
 * Audit reports 2–5 — ADR-0003 §3 (early-traffic tier). Reports 1/6 in replay.ts.
 * Reports 2–4 are calibration reports: reliability buckets by kind/age/version.
 */
import type { Corpus, CorpusCard } from "./corpus.ts";
import type { ParamSet } from "./params.ts";
import type { TurnLedger } from "./types.ts";
import { corpusCard } from "./corpus.ts";

export interface ReliabilityBucket {
  lo: number;
  hi: number;
  n: number;
  observed: number;
}

export function reliability(
  claims: Array<{ forecast: number; observed01: number }>,
  bucketEdges: readonly number[] = [0, 0.25, 0.5, 0.75, 1.0001],
): ReliabilityBucket[] {
  const out: ReliabilityBucket[] = [];
  for (let i = 0; i < bucketEdges.length - 1; i++) {
    const lo = bucketEdges[i]!;
    const hi = bucketEdges[i + 1]!;
    const inBucket = claims.filter((c) => c.forecast >= lo && c.forecast < hi);
    const n = inBucket.length;
    out.push({
      lo,
      hi,
      n,
      observed: n > 0 ? inBucket.reduce((s, c) => s + c.observed01, 0) / n : 0,
    });
  }
  return out;
}

export function kindFromId(id: string): string {
  if (id.startsWith("lens:")) return "lens";
  if (id.startsWith("goal")) return "goal";
  if (id.startsWith("err")) return "error";
  if (id.startsWith("turn-")) return "episodic";
  if (id.startsWith("syn-")) {
    // synthetic ids: syn-<session>-lens-<turn> vs syn-<session>-turn-<n>-epi<k>
    if (id.includes("-lens-")) return "lens";
    return "episodic";
  }
  return "standing";
}

// ── Report 2: value forecast ───────────────────────────────────────────────

export interface ValueForecastReport {
  report: "value-forecast";
  card: CorpusCard;
  byKind: Array<{ kind: string; n: number; mae: number; buckets: ReliabilityBucket[] }>;
}

export function reportValueForecast(corpus: Corpus): ValueForecastReport {
  const byKind = new Map<string, Array<{ forecast: number; observed01: number; err: number }>>();
  for (const it of corpus.items) {
    const kind = kindFromId(it.id);
    const observed01 = it.accepted ? 1 : 0;
    const forecast = it.forecast.expectedValue > 0 ? 1 : 0;
    const err = Math.abs(it.forecast.expectedValue - (observed01 ? 1 : 0));
    const list = byKind.get(kind) ?? [];
    list.push({ forecast, observed01, err });
    byKind.set(kind, list);
  }
  return {
    report: "value-forecast",
    card: corpusCard(corpus),
    byKind: Array.from(byKind.entries()).map(([kind, list]) => ({
      kind,
      n: list.length,
      mae: list.reduce((s, x) => s + x.err, 0) / list.length,
      buckets: reliability(list),
    })),
  };
}

// ── Report 3: hazard ───────────────────────────────────────────────────────

export interface HazardReport {
  report: "hazard";
  card: CorpusCard;
  byBasis: Array<{ basis: "prior" | "observed"; kind: string; n: number; observedInvalidationRate: number; buckets: ReliabilityBucket[] }>;
}

export function reportHazard(corpus: Corpus): HazardReport {
  // Bucketed by basis AND kind (0003 §3): pooling kinds dilutes planted
  // signals — the ADR's bucketing discipline is load-bearing, not cosmetic.
  const groups = new Map<string, Array<{ forecast: number; observed01: number }>>();
  for (const it of corpus.items) {
    const key = it.forecast.basis + ":" + kindFromId(it.id);
    const observed01 = it.decision === "drop" || it.decision === "purge" ? 1 : 0;
    const list = groups.get(key) ?? [];
    list.push({ forecast: it.forecast.hazard, observed01 });
    groups.set(key, list);
  }
  return {
    report: "hazard",
    card: corpusCard(corpus),
    byBasis: Array.from(groups.entries()).map(([basisAndKind, list]) => {
      const sep = basisAndKind.split(":");
      const basis = sep[0] ?? "prior";
      const kind = sep[1] ?? "unknown";
      return {
        basis: basis as "prior" | "observed",
        kind,
        n: list.length,
        observedInvalidationRate: list.reduce((s, x) => s + x.observed01, 0) / list.length,
        buckets: reliability(list, [0, 0.1, 0.3, 0.6, 1.0001]),
      };
    }),
  };
}

// ── Report 4: rot (research-grade skeleton) ────────────────────────────────

export interface RotReport {
  report: "rot";
  card: CorpusCard;
  note: string;
  byLambdaDecile: Array<{ lo: number; hi: number; n: number; meanObservedLossiness: number }>;
}

export function reportRot(corpus: Corpus): RotReport {
  const perTurn = corpus.turns.map((t) => ({
    lam: t.layout.reduce((s, e) => s + e.tokens, 0),
    lossy: 0,
  }));
  for (const it of corpus.items) {
    if (it.decision === "summarize-intent" || it.decision === "drop") {
      if (perTurn.length > 0) perTurn[0]!.lossy += 1; // v1: session-level attribution
    }
  }
  const sorted = [...perTurn].sort((a, b) => a.lam - b.lam);
  const deciles: RotReport["byLambdaDecile"] = [];
  const per = Math.max(1, Math.ceil(sorted.length / 10));
  for (let i = 0; i < sorted.length; i += per) {
    const chunk = sorted.slice(i, i + per);
    deciles.push({
      lo: chunk[0]!.lam,
      hi: chunk[chunk.length - 1]!.lam,
      n: chunk.length,
      meanObservedLossiness: chunk.reduce((s, c) => s + c.lossy, 0) / chunk.length,
    });
  }
  return {
    report: "rot",
    card: corpusCard(corpus),
    note: "research-grade skeleton (0003 §8 tier 3): outcome labels (redo rate, instruction misses) not yet journaled — wired for when they are",
    byLambdaDecile: deciles,
  };
}

// ── Report 5: decision (thrash) ────────────────────────────────────────────

export interface DecisionReport {
  report: "decision";
  card: CorpusCard;
  accepted: number;
  rejectedNearMisses: number;
  thrashCount: number;
  thrashRate: number;
  reversals: Array<{ id: string; fromTurn: number; toTurn: number; decisions: [string, string] }>;
  meanMargin: number | null;
}

export function reportDecision(corpus: Corpus): DecisionReport {
  const accepted = corpus.items.filter((i) => i.accepted);
  const nearMisses = corpus.items.filter((i) => !i.accepted && i.marginVsHysteresis > -0.05);
  const byId = new Map<string, typeof corpus.items>();
  for (const it of corpus.items) {
    const list = byId.get(it.id) ?? [];
    list.push(it);
    byId.set(it.id, list);
  }
  const reversals: DecisionReport["reversals"] = [];
  for (const [id, list] of byId) {
    // Review B9: the solver emits BOTH a keep-row (accepted) and a
    // rejected-challenger row for one held incumbent in the same turn —
    // dedupe to the ACCEPTED row per (id, turn) before the sweep, else a
    // phantom keep→drop "reversal" fires where no state ever changed.
    const placed = list.filter((r) => r.accepted);
    const sorted = placed.sort((a, b) => a.turn - b.turn);
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i]!;
      const b = sorted[i + 1]!;
      if (a.turn + 3 >= b.turn && a.accepted !== b.accepted) {
        reversals.push({ id, fromTurn: a.turn, toTurn: b.turn, decisions: [a.decision, b.decision] });
      }
    }
  }
  const margins = corpus.items.map((i) => i.marginVsHysteresis);
  return {
    report: "decision",
    card: corpusCard(corpus),
    accepted: accepted.length,
    rejectedNearMisses: nearMisses.length,
    thrashCount: reversals.length,
    thrashRate: corpus.items.length > 0 ? reversals.length / corpus.items.length : 0,
    reversals,
    meanMargin: margins.length > 0 ? margins.reduce((s, m) => s + m, 0) / margins.length : null,
  };
}

// ── ADR-0006 §7 gauges — the falsification instrument (phase 0) ──────────

/**
 * Gauge 6 (phase 3.5) — optional harness-supplied truth for the belief gap.
 * `truthByTurn` carries an INDEPENDENT ground truth (e.g. an LCP
 * recomputation over actual render bytes) supplied by the harness ALONGSIDE
 * the corpus — report-side only; the ledger is never retro-fabricated
 * (ADR-0002e honesty boundary).
 */
export interface BeliefGapInput {
  basis: "lcp-truth";
  truthByTurn: ReadonlyMap<number, number>;
}

export interface BeliefGapReport {
  /** Truth basis used for comparison. */
  basis: "provider-realized" | "lcp-truth";
  /** Number of comparable turns (belief + truth both present). */
  compared: number;
  /** Mean absolute |truth − believed| in tokens. */
  maeTokens: number;
  /** Mean signed (truth − believed); positive = under-belief. */
  signedMeanTokens: number;
  /** OLS slope of the signed gap against turn number (tokens/turn). */
  slopeTokensPerTurn: number;
  /** Discriminating signature (see classifyBeliefGap). */
  signature: BeliefGapSignature;
}

export type BeliefGapSignature =
  | "insufficient"          // < 3 comparable turns
  | "growing-underbelief"   // positive slope, positive mean (TTL-creep shape)
  | "growing-overbelief"
  | "constant-offset"       // |slope| small, mean ≢ 0
  | "noise";                // |slope| and |mean| both small

export interface GaugesReport {
  report: "gauges";
  card: CorpusCard;
  turns: number;
  /** Gauge 1 — representation flips per 100 turns (expect down after §2). */
  flips: number;
  flipsPer100: number;
  /** Gauge 2 — re-expansions per eviction (wrong-drop detector; expect down). */
  evictions: number;
  reExpansions: number;
  reExpansionsPerEviction: number | null;
  /** Gauge 3 — believed-hit ratio: expected hit tokens / rendered tokens. */
  believedHitRatio: number | null;
  /** Gauge 4 — dead-token share: rendered tokens priced below ρ. */
  deadTokenShare: number | null;
  /** Gauge 5 — write-to-harvest: cached tokens harvested per deliberate restructure. */
  restructures: number;
  writeToHarvest: number | null;
  harvestBasis: "expected" | "realized" | "none";
  /** Gauge 6 (phase 3.5) — belief gap vs independent truth; null when no
   *  provider-realized hits and no harness truth map were supplied. */
  beliefGap: BeliefGapReport | null;
}

export function reportGauges(corpus: Corpus, ps: ParamSet, beliefGapInput?: BeliefGapInput): GaugesReport {
  const turnsByNumber = new Map<number, TurnLedger>();
  for (const t of corpus.turns) turnsByNumber.set(t.turn, t);

  // Gauge 1 — flips: representation change between consecutive ledger turns,
  // matched by item id. Layout rows are per-render placements; a flip is
  // state_t !== state_{t-1} for the same id across adjacent turns.
  let flips = 0;
  const sortedTurns = [...corpus.turns].sort((a, b) => a.turn - b.turn);
  for (let i = 1; i < sortedTurns.length; i++) {
    const prev = new Map(sortedTurns[i - 1]!.layout.map((e) => [e.id, e.state]));
    for (const e of sortedTurns[i]!.layout) {
      const before = prev.get(e.id);
      if (before !== undefined && before !== e.state) flips += 1;
    }
  }
  const turnsCount = corpus.turns.length;
  const flipsPer100 = turnsCount > 0 ? (flips / turnsCount) * 100 : 0;

  // Gauge 2 — evictions: accepted drops. Re-expansions: an expand-type signal
  // on an item that was evicted at any earlier turn (re-entry after drop).
  const evictions = corpus.items.filter(
    (i) => i.accepted && (i.decision === "drop" || i.decision === "purge"),
  ).length;
  const evictedIds = new Set(
    corpus.items.filter((i) => i.accepted && (i.decision === "drop" || i.decision === "purge")).map((i) => i.id),
  );
  let reExpansions = 0;
  for (const s of corpus.signals) {
    if (typeof s.itemId !== "string") continue;
    if (s.type.endsWith("-expand") && evictedIds.has(s.itemId)) reExpansions += 1;
  }
  const reExpansionsPerEviction = evictions > 0 ? reExpansions / evictions : null;

  // Gauge 3 — believed-hit ratio: Σ expected hitTokens / Σ rendered tokens,
  // per turn where both exist. Expected hits are the solver's cache belief.
  let hitNum = 0;
  let hitDen = 0;
  for (const c of corpus.caches) {
    const t = turnsByNumber.get(c.turn);
    if (!t) continue;
    const rendered = t.layout.reduce((s, e) => s + e.tokens, 0);
    if (rendered <= 0) continue;
    hitNum += c.expected.hitTokens;
    hitDen += rendered;
  }
  const believedHitRatio = hitDen > 0 ? hitNum / hitDen : null;

  // Gauge 4 — dead-token share: rendered tokens whose forecast expectedValue
  // sits below the reservation price ρ (squatting seats without paying rent).
  // Denominator: forecast-covered rendered tokens (item-ledger × layout join).
  let deadNum = 0;
  let deadDen = 0;
  const forecastsByTurn = new Map<string, number>();
  for (const i of corpus.items) forecastsByTurn.set(`${i.turn}:${i.id}`, i.forecast.expectedValue);
  for (const t of corpus.turns) {
    for (const e of t.layout) {
      const ev = forecastsByTurn.get(`${t.turn}:${e.id}`);
      if (ev === undefined) continue;
      deadDen += e.tokens;
      if (ev < ps.reservationPrice) deadNum += e.tokens;
    }
  }
  const deadTokenShare = deadDen > 0 ? deadNum / deadDen : null;

  // Gauge 5 — write-to-harvest: cached tokens harvested per deliberate
  // restructure (accepted consolidate/move/promote). Harvest window: the
  // H_cache = min(ttlTurns, T*) turns after the restructure, using expected
  // hits (realized when provider reports them — divergence class ≠ unreported).
  let restructures = 0;
  let harvestNum = 0;
  let harvestTurns = 0;
  let basis: GaugesReport["harvestBasis"] = "none";
  for (const i of corpus.items) {
    if (!i.accepted) continue;
    if (i.decision !== "consolidate" && i.decision !== "move" && i.decision !== "promote") continue;
    restructures += 1;
    const windowEnd = i.turn + ps.cache.ttlTurns;
    for (const c of corpus.caches) {
      if (c.turn <= i.turn || c.turn > windowEnd) continue;
      const hit = c.realized !== null && c.divergence !== "unreported"
        ? c.realized.hitTokens
        : c.expected.hitTokens;
      harvestNum += hit;
      harvestTurns += 1;
    }
    if (cachesReported(corpus)) basis = "realized";
  }
  if (restructures > 0 && basis === "none") basis = "expected";
  const writeToHarvest = restructures > 0 && harvestTurns > 0 ? harvestNum / restructures : null;

  // Gauge 6 — belief gap (phase 3.5): provider-realized wins; harness LCP
  // truth is the fallback when providers stay silent (mock corpora). Null
  // when neither exists — never fabricated (ADR-0002e).
  const beliefGap = computeBeliefGap(corpus, beliefGapInput);

  return {
    report: "gauges",
    card: corpusCard(corpus),
    turns: turnsCount,
    flips, flipsPer100,
    evictions, reExpansions, reExpansionsPerEviction,
    believedHitRatio,
    deadTokenShare,
    restructures, writeToHarvest, harvestBasis: basis,
    beliefGap,
  };
}

/** Gauge 6 internals — exported for direct harness use. */
export function computeBeliefGap(
  corpus: Corpus,
  input?: BeliefGapInput,
): BeliefGapReport | null {
  // Priority: EXPLICIT harness truth (deliberate independent recomputation —
  // in mock corpora the provider "realized" is a simulated echo of belief,
  // not evidence) > provider-realized (authoritative for live providers,
  // where usage comes from the API) > null.
  const realizedPairs: Array<{ turn: number; gap: number }> = [];
  for (const c of corpus.caches) {
    if (c.realized !== null && c.divergence !== "unreported") {
      realizedPairs.push({ turn: c.turn, gap: c.realized.hitTokens - c.expected.hitTokens });
    }
  }
  let basis: "provider-realized" | "lcp-truth";
  let pairs: Array<{ turn: number; gap: number }>;
  if (input !== undefined) {
    basis = "lcp-truth";
    pairs = [];
    for (const c of corpus.caches) {
      const truth = input.truthByTurn.get(c.turn);
      if (truth === undefined) continue;
      pairs.push({ turn: c.turn, gap: truth - c.expected.hitTokens });
    }
    // Review B4: an empty truth map (harness supplied nothing for these
    // turns) must not produce NaN stats — fall through to provider-realized.
    if (pairs.length === 0 && realizedPairs.length >= 1) {
      basis = "provider-realized";
      pairs = realizedPairs;
    }
  } else if (realizedPairs.length >= 1) {
    basis = "provider-realized";
    pairs = realizedPairs;
  } else {
    return null;
  }
  if (pairs.length === 0) return null;
  const n = pairs.length;
  const mae = pairs.reduce((s, p) => s + Math.abs(p.gap), 0) / n;
  const signedMean = pairs.reduce((s, p) => s + p.gap, 0) / n;
  // OLS slope of gap against turn
  const meanTurn = pairs.reduce((s, p) => s + p.turn, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of pairs) {
    num += (p.turn - meanTurn) * (p.gap - signedMean);
    den += (p.turn - meanTurn) ** 2;
  }
  const slope = den > 0 ? num / den : 0;
  return {
    basis,
    compared: n,
    maeTokens: mae,
    signedMeanTokens: signedMean,
    slopeTokensPerTurn: slope,
    signature: classifyBeliefGap(n, signedMean, slope),
  };
}

/** Signatures (phase 3.5 stub → ADR-0003 refit input):
 *  growing-underbelief = TTL-creep shape (belief retires entries the
 *  provider still holds). constant-offset = systematic framing/rounding.
 *  noise = nothing worth refitting. */
export function classifyBeliefGap(n: number, signedMean: number, slope: number): BeliefGapSignature {
  if (n < 3) return "insufficient";
  const slopeSmall = Math.abs(slope) < 0.5;       // tokens/turn
  const meanSmall = Math.abs(signedMean) < 5;     // tokens
  if (slopeSmall && meanSmall) return "noise";
  if (!slopeSmall && slope > 0) return "growing-underbelief";
  if (!slopeSmall && slope < 0) return "growing-overbelief";
  return "constant-offset";
}

function cachesReported(corpus: Corpus): boolean {
  return corpus.caches.some((c) => c.realized !== null && c.divergence !== "unreported");
}
