/**
 * Versioned parameter sets — ADR-0002e §3, ADR-0004 §3.
 *
 * Every ledger entry pins the parameter set (and model id) that produced it.
 * Fits are PER LLM MODEL (A2 ruling): parameter sets carry a model dimension;
 * pooled fits only as flagged fallback priors.
 */
import type { ItemKind } from "./types.ts";

export type Horizon =
  | { deterministic: number }
  | { distribution: { p50: number; p95: number } }
  | { stable: true };

/** Per-kind value profile — ADR-0002f §3: power law is the default, not a law. */
export interface ValueProfile {
  kind: ItemKind;
  mu0: number;
  alpha: number;
  /** Decay-exempt while lifecycle-active (goals). */
  decayExempt?: boolean;
  /** Value floor for N turns (error evidence — ADR-0004 §2). */
  floorTurns?: number;
  floorValue?: number;
  /** A-M5 owner ruling 2026-08-23: errors are sticky UNTIL RESOLVED — the
   * floor holds while the item's resolvedTurn is unset; resolution releases
   * it and the item decays at the profile alpha (episodic-speed glide). */
  floorWhileUnresolved?: number;
}

/** Cache price model — ADR-0002 §2 CacheModel beliefs, self-calibrating. */
export interface CacheModelParams {
  /** Cached-token price as a fraction of uncached price (Anthropic ~0.1). */
  cachedPriceFraction: number;
  /** Assumed provider block granularity (tokens). */
  granularity: number;
  /** Believed TTL in turns (Anthropic 5-min; we model turns). */
  ttlTurns: number;
  /** Optional wall-clock TTL. Used only when both sides carry wall time. */
  ttlMs?: number | undefined;
  /** Per-1k-token prices (USD) — uncached input. */
  pricePer1kUncached: number;
  pricePer1kCached: number;
  pricePer1kOutput: number;
}

export interface ParamSet {
  version: string;
  modelId: string;                        // A2: per-model fits
  lambda: number;                         // rot-penalty weight (risk aversion)
  budgetLambda: number;                   // rendered-token budget Λ
  rotCurve: { sizeCoef: number; midPenalty: number };
  hysteresisMargin: number;               // solver discipline (0002b §6)
  profiles: Record<ItemKind, ValueProfile>;
  hazardPriors: Record<ItemKind, number>; // per-turn change probability
  cache: CacheModelParams;
  /** ADR-0004 §7 (A6): starting fidelity penalty for lossy representations. */
  summaryConfidencePrior: number;
  /**
   * Reservation (shadow) price per rendered token — the emergence pass's
   * knapsack dual (2026-08-22). An item must earn its seat: v_i must exceed
   * rho × tokens + transaction costs, else the byte is better left for
   * fresher content. Tuned so a fully-decayed turn (value → 0) leaves the
   * window within ~2 turns of its value crossing rho × its tokens.
   */
  reservationPrice: number;
  /**
   * Budget-relief selection mode (ADR-0005 §7 v1.2, ruled 2026-08-22).
   * "exact-mckp" — DEFAULT: relief is formulated as a pure MCKP (one
   * choice per droppable item: keep at current tokens, tombstone to its
   * zeroValue handle, or evict freeing all tokens) and solved exactly
   * through @tenacy-labs/knapsack (Pareto → LP bounds → fathoming →
   * DP). Dominates density by construction: greedy is a feasible point
   * of the same MCKP.
   * "density" — the superseded v1.1 relief (sequential worst utility-
   * per-token argmax). Selectable for A/B measurement and fallback.
   */
  reliefMode: "density" | "exact-mckp";
  /**
   * Future-utility capture (Daniel, 2026-08-22: "we may need to think more
   * about how we capture the future utility of our context objects over
   * future turns"). Benefit is a discounted re-reference stream, not a k=0
   * scalar: FV = Σ_{k=1..H} γ^k · (q(state)·μ0·α/(1+Δt+k) − ρ·tokens).
   * The re-reference hazard uses the kind's OWN α (the decay profile IS the
   * recurrence shape — no separate knobs); q is the state quality factor:
   * what fraction of μ0 is realized at re-reference from that state.
   */
  fv: {
    /** Lookahead horizon H (turns). */
    horizon: number;
    /** Per-turn discount γ. */
    gamma: number;
    /** q: realization fraction, rendered verbatim/full. */
    qRendered: number;
    /** q: realization fraction, lossy (SUMMARY/MERGED/CONSOLIDATED). */
    qLossy: number;
    /** q: realization fraction, handle (compact header / purge tombstone):
     *  optionality only — re-expand pays a writeback. */
    qHandle: number;
  };
}

export const PROFILES_V1: Record<ItemKind, ValueProfile> = {
  identity:      { kind: "identity", mu0: 10.0, alpha: 0.0, decayExempt: true },  // A-M5 owner ruling 2026-08-23: ANCHORED — immune to recall AND age. Structural (decayExempt), not α-arithmetic, so a per-model refit can never silently re-price the anchor.
  directive:     { kind: "directive", mu0: 6.0, alpha: 0.2 },
  goal:          { kind: "goal", mu0: 8.0, alpha: 0.0, decayExempt: true },  // 0002f §3
  episodic:      { kind: "episodic", mu0: 3.0, alpha: 1.0 },    // α ≈ 1 to start (0002b §2)
  reference:     { kind: "reference", mu0: 4.0, alpha: 0.5 },
  lens:          { kind: "lens", mu0: 5.0, alpha: 0.6 },
  kernelView:    { kind: "kernelView", mu0: 5.0, alpha: 0.4 },
  artifact:      { kind: "artifact", mu0: 4.0, alpha: 0.5 },
  notice:        { kind: "notice", mu0: 2.0, alpha: 1.2 },
  error:         { kind: "error", mu0: 4.5, alpha: 1.0, floorWhileUnresolved: 2.0 },  // A1 (0004 §2); A-M5 owner ruling 2026-08-23: sticky until resolvedTurn, then episodic-speed glide
};

export const HAZARD_PRIORS_V1: Record<ItemKind, number> = {
  identity: 0.0, directive: 0.01, goal: 0.02, episodic: 0.0,  // episodic: immutable once written
  reference: 0.01, lens: 0.08, kernelView: 0.15, artifact: 0.03, notice: 0.90, error: 0.0,
};

/** Honest v1 defaults — calibratable later, never blocking (0002b Risks). */
export function paramSetV1(modelId: string): ParamSet {
  return {
    version: "v1.0.0",
    modelId,
    lambda: 0.8,
    budgetLambda: 24_000,
    // Emergence pass (2026-08-22): 0.00015 was decorative — ~0.003 utility
    // against item values of 2–10. At 0.0015 a 2,000t render carries ~2.4
    // rot-disutility units: bloat now competes with item value in the argmin.
    rotCurve: { sizeCoef: 0.0015, midPenalty: 0.3 },
    hysteresisMargin: 0.15,
    profiles: structuredClone(PROFILES_V1),
    hazardPriors: structuredClone(HAZARD_PRIORS_V1),
    cache: {
      cachedPriceFraction: 0.1,
      granularity: 1024,
      ttlTurns: 6,
      pricePer1kUncached: 3.0,
      pricePer1kCached: 0.3,
      pricePer1kOutput: 15.0,
    },
    summaryConfidencePrior: 2.0,   // A6: lossy reps start heavily penalized
    // 0.002 util/token: a 24t turn item must carry > 0.048 utility to hold a
    // seat (decay takes a turn-2 item there in ~4 turns at α=1); a 676t
    // chunk must carry > 1.35. Decay + reservation evicts stale content
    // WITHOUT relief flapping (re-entry needs to re-clear the bar).
    reservationPrice: 0.002,
    // ADR-0005 §7 v1.2 (ruled 2026-08-22): exact-MCKP relief through
    // @tenacy-labs/knapsack is the default; density stays selectable.
    reliefMode: "exact-mckp",
    // Future-utility capture (2026-08-22 multi-period pass). Defaults are
    // the sweep's tuned argmin-achieving set — see ADR-0006 for the grid.
    fv: {
      horizon: 20,
      gamma: 0.85,
      // qRendered = 1.0: a rendered verbatim object realizes its FULL value
      // at re-reference (the model reads the bytes); q discounts only
      // state lossiness. At 0.5 a 652t lens could not cover its own rent
      // (0.5×5×2^-0.6 ≈ 1.29 < ρ×652 ≈ 1.30) and fresh lenses were rejected
      // at entry — caught by STRESS-A regression.
      qRendered: 1.0,
      qLossy: 0.45,
      qHandle: 0.35,
    },
  };
}
