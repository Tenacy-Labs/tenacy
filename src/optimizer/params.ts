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
}

/** Cache price model — ADR-0002 §2 CacheModel beliefs, self-calibrating. */
export interface CacheModelParams {
  /** Cached-token price as a fraction of uncached price (Anthropic ~0.1). */
  cachedPriceFraction: number;
  /** Assumed provider block granularity (tokens). */
  granularity: number;
  /** Believed TTL in turns (Anthropic 5-min; we model turns). */
  ttlTurns: number;
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
}

export const PROFILES_V1: Record<ItemKind, ValueProfile> = {
  identity:      { kind: "identity", mu0: 10.0, alpha: 0.0 },   // standing value, never decays
  directive:     { kind: "directive", mu0: 6.0, alpha: 0.2 },
  goal:          { kind: "goal", mu0: 8.0, alpha: 0.0, decayExempt: true },  // 0002f §3
  episodic:      { kind: "episodic", mu0: 3.0, alpha: 1.0 },    // α ≈ 1 to start (0002b §2)
  reference:     { kind: "reference", mu0: 4.0, alpha: 0.5 },
  lens:          { kind: "lens", mu0: 5.0, alpha: 0.6 },
  kernelView:    { kind: "kernelView", mu0: 5.0, alpha: 0.4 },
  artifact:      { kind: "artifact", mu0: 4.0, alpha: 0.5 },
  notice:        { kind: "notice", mu0: 2.0, alpha: 1.2 },
  error:         { kind: "error", mu0: 4.5, alpha: 0.15, floorTurns: 8, floorValue: 2.0 },  // A1 (0004 §2)
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
    rotCurve: { sizeCoef: 0.00015, midPenalty: 0.3 },
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
  };
}
