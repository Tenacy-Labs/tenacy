/**
 * Turnover-capped horizons — ADR-0006 §5 (phase 2).
 *
 * T* = (Λ − W_t) / a_t — the decision-invariant expected turnover of the
 * context window: the point where the window turns over regardless of any
 * decision made now. Beyond it the current cache and layout are gone;
 * expected savings can never exceed it.
 *
 * a_t is net durable drift: expected growth of the non-sheddable prefix per
 * turn, maintained by the loop as an EWMA over Δ(standing mass). v1 INCLUDES
 * restructures (the realized layout-mass change is the honest drift signal
 * while we lack per-move attribution — see loop.ts's incumbent update; the
 * split-out is a v2 refinement, not today's claim). Absent/undefined drift
 * → T* = ∞ → fixed-cap
 * fallback (bit-identical behavior for callers that do not track it).
 */
import type { ParamSet } from "./params.ts";
import type { ContextItem } from "./types.ts";
import { evidenceVariance } from "./evidence.ts";

export function turnoverStar(lambda: number, wTokens: number, drift: number | undefined): number {
  if (drift === undefined) return Infinity;
  if (drift <= 0) return Infinity;
  // Review A-minor-1: W > Λ (already over budget) used to yield negative
  // T*, leaking a k=1 term through H = max(1, floor(negative)). Clamp at 0
  // → H = 0: an over-budget window collects no lookahead.
  return Math.max(0, (lambda - wTokens) / drift);
}

export interface HorizonCaps {
  /** Value-stream horizon: min(fv.horizon, T*). */
  hValue: number;
  /** Cache-amortization horizon: min(T*, ttlTurns). */
  hCache: number;
  /** The raw T* estimate (Infinity when drift is absent/non-positive). */
  tStar: number;
}

export function capHorizons(ps: ParamSet, lambda: number, wTokens: number, drift: number | undefined): HorizonCaps {
  const tStar = turnoverStar(lambda, wTokens, drift);
  return {
    hValue: Math.min(ps.fv.horizon, tStar),
    hCache: Math.min(tStar, ps.cache.ttlTurns),
    tStar,
  };
}

/**
 * Variance-scaled hysteresis — ADR-0006 §2.4/§6: forecastVariance retires
 * the flat hysteresisMargin as unexpressed risk aversion. The margin a
 * challenger must clear scales with posterior uncertainty: thick evidence
 * → tight margin (data says move); thin evidence → wide margin (hold the
 * incumbent until the evidence thickens). Absent evidence → the param
 * margin, unchanged.
 */
export function effectiveHysteresis(ps: ParamSet, item: ContextItem): number {
  if (item.refEvidence === undefined) return ps.hysteresisMargin;
  // A-M5 owner ruling (2026-08-23): prior-0 kinds are evidence-NEUTRAL at
  // every pricing layer. One search hit on an identity anchor → σ low →
  // margin HALVED — access evidence perturbing prior-0 pricing through the
  // variance side door. Only an explicitly stamped forecastVariance is
  // honored (deliberate signal), never access-derived posteriors.
  if (ps.hazardPriors[item.kind] <= 0 && item.forecastVariance === undefined) return ps.hysteresisMargin;
  // Review A-minor-5: use the KIND prior (consistent with evidenceValueFactor)
  // instead of a hardcoded 0.3 — identity/episodic (0) and error (0) items
  // previously got variance scaled against the wrong reference.
  const prior = ps.hazardPriors[item.kind];
  const v = item.forecastVariance ?? evidenceVariance(item, prior);
  if (v === null) return ps.hysteresisMargin;
  // σ ∈ (0, 0.5); scale margin by σ/σ₀ where σ₀ = 0.15 (the margin-neutral
  // uncertainty). Clamp to [0.5×, 2×] so evidence can never zero the margin
  // (anti-Zeno) nor explode it.
  const sigma = Math.sqrt(v);
  const factor = clamp(sigma / 0.15, 0.5, 2);
  return ps.hysteresisMargin * factor;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
