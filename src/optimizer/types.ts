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

export type Velocity = "frozen" | "stable" | "evolving" | "volatile";

export type Zone = "identity" | "foundational" | "stable" | "evolving" | "volatile";

export const ZONE_ORDER: readonly Zone[] = ["identity", "foundational", "stable", "evolving", "volatile"] as const;

/** Lens representation states — ADR-0002b §5. */
export type LensState = "FULL" | "BASE+DELTA" | "CONSOLIDATED" | "PURGED";

/** Conversation representations — ADR-0002f §2. */
export type ConvoRep = "VERBATIM" | "SUMMARY" | "MERGED";

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
}

/** The stored record — never rendered directly (ADR-0002 §2). */
export interface ContextItem {
  id: string;                       // stable handle: "goal:1", "turn-41", "lens:src/kernel.ts", "mem:7"
  kind: ItemKind;
  velocity: Velocity;
  immutable: boolean;               // episodic records never change once written
  tokens: number;                   // accounted at insertion (estimate: chars/4)
  /** Serialized bytes of the current representation (pure function of item state). */
  serialize(): string;
  /** Render options presented to the solver (ADR-0004: ≥1 purely-additive where possible). */
  options(): RenderOption[];
  /** Upstream item ids (DAG — ADR-0002c §5); leaf validation covers the subtree. */
  upstreams?: readonly string[] | undefined;
  lastRender?: { position: number; digest: string } | undefined;  // render memory
  lastTouchTurn: number;            // value decay clock input
  createdTurn: number;
  /** Per-item hazard override; absent → kind prior (params). */
  hazardOverride?: number | undefined;
  /** Value bump signals (ctx.promote / explicit invocation) — decay-exempt adders, per 0002g. */
  valueBump?: { amount: number; untilTurn: number } | undefined;
  /** Toggle state — ADR-0002d §7 (live | polled | frozen); default polled. */
  watch?: "live" | "polled" | "frozen" | undefined;
  /** Marks store-level authored signals (model ctx / goals flips) — never optimizer-authored. */
  signalClass?: "model-authored" | "optimizer" | undefined;
  /** Dream output (0002f §4): when set, a SUMMARY option joins the surface. Store record stays verbatim. */
  summary?: string | undefined;
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
  forecast: { mu0: number; alpha: number; deltaT: number; hazard: number; basis: "prior" | "observed"; expectedValue: number };
  utility: { benefit: number; cacheCost: number; rotShare: number; total: number };
  decision: "keep" | "drop" | "move" | "consolidate" | "promote" | "purge" | "summarize-intent";
  accepted: boolean;
  marginVsHysteresis: number;       // negative for rejected near-misses
  optionChosen?: string | undefined;
}

export interface CacheLedger {
  turn: number;
  expected: { hitTokens: number; price: number };
  realized: { hitTokens: number; price: number } | null;
  divergence: DivergenceClass;
  rawProviderReport: unknown;
}
