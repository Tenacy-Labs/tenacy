/**
 * Optimizer core types — ADR-0002 §2, 0002b, 0002c, 0002e, 0004.
 *
 * The ContextStore holds rich ContextItems; render is a pure projection
 * decided by the solver; the ledger journals every decision. Nothing here
 * mutates — these are the contracts the rest of the module implements.
 */
import type { Horizon } from "./params.ts";

export type ItemKind =
  | "identity" | "directive" | "goal" | "episodic" | "reference"
  | "lens" | "kernelView" | "artifact" | "notice" | "error";

// Velocity removed per ADR-0006 §2 (owner ruling 2026-08-22): duplicated
// hazard (hazard IS velocity as a probability); zoneOfDyn derives dynamism
// from observed state. Historical: docs/adr/0002*.md.

export type Zone = "identity" | "foundational" | "stable" | "evolving" | "volatile";

export const ZONE_ORDER: readonly Zone[] = ["identity", "foundational", "stable", "evolving", "volatile"] as const;

/** Lens representation states — ADR-0002b §5. */
export type LensState = "FULL" | "BASE+DELTA" | "CONSOLIDATED" | "SPLIT" | "PURGED";

/** Conversation representations — ADR-0002f §2. */
export type ConvoRep = "VERBATIM" | "SUMMARY" | "MERGED";

/**
 * Optional sequence-position contract for independently rendered base/delta
 * blocks.  Producers own the accumulated migration credit; the solver spends
 * it only when a requested fuse move covers the intervening suffix bill.
 */
export interface SequencePosition {
  /** Stable file/object lineage. Members with the same parent form a chain. */
  parentId: string;
  /** Arrival order inside the lineage (base is normally zero). */
  ordinal: number;
  role: "base" | "delta";
  /** Explicit arrival-precedence edge; normally the prior delta/base item id. */
  predecessorId?: string | undefined;
  /** Tail is the backwards-compatible/default delta policy; fuse co-locates. */
  placement?: "tail" | "fuse" | undefined;
  /** Accumulated file-migration credit, denominated in token mass. */
  migrationCreditTokens?: number | undefined;
}

/** Render option presented by an item — ADR-0004 §5–6 (option surface). */
export interface RenderOption {
  /** Stable option id (item-scoped). */
  id: string;
  /** True when choosing this option only appends bytes after the incumbent render tail (or item is new). */
  purelyAdditive: boolean;
  /** Zones this option may legally occupy (solver picks one). */
  zones: readonly Zone[];
  representation: LensState | ConvoRep | "AS_IS";
  /** Token estimate at this option's serialization. */
  tokens: number;
  /** The deterministic bytes this option renders (ADR-0004: an option IS a representation). */
  text: string;
  /** Renders no content — scores zero value (purge/compact-head/range-drop): you cannot derive utility from bytes you do not render. */
  zeroValue?: boolean | undefined;
  /** Option-specific sequence semantics; overrides the item's metadata. */
  sequence?: SequencePosition | undefined;
}

/** The stored record — never rendered directly (ADR-0002 §2). */
export interface ContextItem {
  id: string;                       // stable handle: "goal:1", "turn-41", "lens:src/kernel.ts", "mem:7"
  kind: ItemKind;
  immutable: boolean;               // episodic records never change once written
  tokens: number;                   // accounted at insertion (estimate: chars/4)
  /** Serialized bytes of the current representation (pure function of item state). */
  serialize(): string;
  /** Render options presented to the solver (ADR-0004: ≥1 purely-additive where possible). */
  options(): RenderOption[];
  /** Base/delta lineage metadata. Absent preserves the pre-ADR-0001 path. */
  sequence?: SequencePosition | undefined;
  /** Upstream item ids (DAG — ADR-0002c §5); leaf validation covers the subtree. */
  upstreams?: readonly string[] | undefined;
  lastRender?: { position: number; digest: string } | undefined;  // render memory
  lastTouchTurn: number;            // value decay clock input
  createdTurn: number;
  /** Per-item hazard override; absent → kind prior (params). */
  hazardOverride?: number | undefined;
  /** Value bump signals (ctx.promote / explicit invocation) — decay-exempt adders, per 0002g. */
  valueBump?: { amount: number; untilTurn: number } | undefined;
  /** Merge-group value mass (multi-period pass 2026-08-22): sum of member
   *  values at merge time — overrides the kind profile for group scoring,
   *  so a group carrying eight members' content is priced with eight
   *  members' value mass and a fresh decay clock. */
  valueMass?: number | undefined;
  /** Toggle state — ADR-0002d §7 (live | polled | frozen); default polled. */
  watch?: "live" | "polled" | "frozen" | undefined;
  /** Marks store-level authored signals (model ctx / goals flips) — never optimizer-authored. */
  signalClass?: "model-authored" | "optimizer" | undefined;
  /** Dream output (0002f §4): when set, a SUMMARY option joins the surface. Store record stays verbatim. */
  summary?: string | undefined;
  /** ADR-0006 §2.1: per-item re-reference evidence ledger → λᵢ posterior (absent → kind prior). */
  refEvidence?: { hits: number[]; accessClass: "cited" | "distilledFrom" | "searchHit" | "reExpanded" } | undefined;
  /** A-M5 owner ruling 2026-08-23: error-lifecycle stamp. Unset → the error
   * is LIVE and keeps its value floor indefinitely (sticky until dealt
   * with). Set → resolved: floor lifts and the item glides out at profile
   * alpha (episodic-speed decay) so settled lessons fall off. */
  resolvedTurn?: number | undefined;
  /** ADR-0006 §2.2: substrate recoverability class (absent → "unknown"). */
  recoverability?: "verbatim-preserving" | "rereadable" | "lossy" | "unknown" | undefined;
  /** ADR-0006 §2.3: content-churn descriptor (absent → prior behavior). */
  churnProfile?: { ewmaChurn: number; lastChangeTurn?: number | undefined } | undefined;
  /** ADR-0006 §2.4: forecast variance σ² (computed; absent → no variance pricing). */
  forecastVariance?: number | undefined;
  /** Conversation lens (0002f §2): verbatim access for re-expansion; merge-group membership. */
  verbatim?: () => string;
  mergedInto?: string | undefined;
  markReexpanded?: () => void;
  setMergedInto?: (v: string | undefined) => void;
}

/** ItemSource — the generic validity interface, ADR-0002c §2. */
export interface ItemSource<T> {
  id: string;
  materialize(): T;
  validate(cached: T): "fresh" | "stale" | "unknown";
  horizon(cached: T): Horizon | null;
}

/** Final placement chosen by the solver for one item this render. */
export interface Placement {
  id: string;
  zone: Zone;
  position: number;                 // 1-based block position in the render
  tokens: number;
  representation: LensState | ConvoRep | "AS_IS";
  optionId: string;
  digest: string;                   // of the serialized block
}

/** A rendered block — the cache-model's substrate. */
export interface Block {
  digest: string;
  tokens: number;
  text: string;
  itemId: string;
  zone: Zone;
}

export interface RenderResult {
  text: string;
  blocks: Block[];
  placements: Placement[];
  zoneHistograms: Record<Zone, Record<string, number>>;  // ADR-0004 §3 (A2)
}

// ── Ledger records — ADR-0002e §1 ──────────────────────────────────────────

export type DivergenceClass =
  | "none"
  | "believed-cached-rebilled"
  | "believed-evicted-hit"
  | "provider-usage-semantics"      // ADR-0004 §4 (A3): summed internal reads
  | "unreported";

export interface TurnLedger {
  turn: number;
  layout: { id: string; position: number; tokens: number; state: LensState | ConvoRep | "AS_IS" }[];
  cacheBelief: {
    blockDigestChain: string[];
    checkpoints: number[];
    ttlTurns: number;
    providerGranularity: number;
  };
  budgetLambda: number;
  parameterSetVersion: string;
  modelId: string;                  // ADR-0004 §3: fits are per-model
  zoneHistograms: Record<Zone, Record<string, number>>;
}

export interface ItemLedger {
  turn: number;
  id: string;
  forecast: { mu0: number; alpha: number; deltaT: number; hazard: number; basis: "prior" | "observed"; hazardBasis?: "prior" | "observed"; expectedValue: number; futureValue?: number };
  utility: { benefit: number; cacheCost: number; rotShare: number; total: number };
  decision: "keep" | "drop" | "move" | "consolidate" | "promote" | "purge" | "summarize-intent";
  accepted: boolean;
  marginVsHysteresis: number;       // negative for rejected near-misses
  optionChosen?: string | undefined;
  /** Coupled-cost reason (0005): fragment forced by parent's aggregated choice. */
  coupledReason?: "parent-carries-bytes" | "budget-tombstone" | "budget-tombstone-exact" | "group-purged-verbatim-fallback" | "family-flip-header" | undefined;
  /** Position-regret row for an accepted or rejected deterministic move. */
  positionRegret?: {
    fromPosition: number;
    toPosition: number;
    suffixBillTokens: number;
    migrationCreditTokens: number;
    regretTokens: number;
    accepted: boolean;
    reversal: boolean;
    reason: "credit-covered" | "insufficient-credit";
  } | undefined;
  /** Defect signal: an accepted move exactly reverses the prior solve's move. */
  moveThrash?: boolean | undefined;
}

export interface CacheLedger {
  turn: number;
  expected: { hitTokens: number; price: number };
  realized: { hitTokens: number; price: number } | null;
  divergence: DivergenceClass;
  rawProviderReport: unknown;
}
