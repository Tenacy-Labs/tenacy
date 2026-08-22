/**
 * Evidence-priced value — ADR-0006 §2.1 (phase 1, additive).
 *
 * The best predictor of an item's future value is its own observed access
 * pattern, not its kind label. refEvidence is a per-item access ledger
 * (update points: intent touches, search hits, citations, re-expansions);
 * lambda_i is its posterior re-reference rate — shrinkage toward the kind
 * prior so thin evidence never produces confident posteriors.
 *
 * All factors are EXACTLY neutral when refEvidence is absent: factor 1.0,
 * variance null — bit-identical solver behavior for evidence-less items
 * (the phase-1 additive contract).
 */
import type { ContextItem } from "./types.ts";

/** Access classes ranked by evidence strength (ADR-0006 §2.1). */
export type AccessClass = "cited" | "distilledFrom" | "searchHit" | "reExpanded";

export interface RefEvidence {
  /** Turn numbers in which the item was accessed (bounded window). */
  hits: number[];
  /** Dominant access class of the window (v1: single class per item). */
  accessClass: AccessClass;
}

/** Beta-ish shrinkage strength: pseudo-observations toward the prior. */
const KAPPA = 10;
/** Bounded evidence window: only the last W turns of hits are kept. */
const WINDOW = 64;

/** Observed window length: createdTurn..turn if evidence exists, else 0. */
function observedTurns(item: ContextItem, turn?: number): number {
  if (item.refEvidence === undefined) return 0;
  const t = turn ?? item.lastTouchTurn;
  return Math.max(1, t - item.createdTurn + 1);
}

/**
 * Posterior re-reference rate λᵢ.
 * λᵢ = (κ·p₀ + |hits in window|) / (κ + observed turns).
 * Absent evidence → the kind prior, exactly.
 */
export function lambdaPosterior(item: ContextItem, prior: number, turn?: number): number {
  if (item.refEvidence === undefined) return prior;
  const n = observedTurns(item, turn);
  const hits = item.refEvidence.hits.filter((h) => (turn === undefined ? true : h <= turn)).length;
  return (KAPPA * prior + hits) / (KAPPA + n);
}

/**
 * Multiplicative value factor from evidence, normalized so the prior itself
 * is neutral: factor = λᵢ/p₀, clamped to [0.25, 4].
 * Absent evidence → exactly 1.
 */
export function evidenceValueFactor(item: ContextItem, prior: number, turn?: number): number {
  if (item.refEvidence === undefined) return 1;
  // Review A-C1/M1: kinds with hazard prior 0 (identity/episodic/error —
  // the "never re-referenced" class) made lam/prior = 0/0 = NaN with zero
  // hits, and x/0 = ∞ → clamp 4 with one hit. Zero evidence on a prior-0
  // kind is neutral (1.0); positive evidence floors the prior in the ratio
  // so the factor is finite and evidence-thickening, not ceiling-pinned.
  if (prior <= 0) {
    const hits = item.refEvidence.hits.filter((h) => (turn === undefined ? true : h <= turn)).length;
    if (hits === 0) return 1;
    const lam = lambdaPosterior(item, prior, turn); // (0 + hits)/(κ + n)
    return clamp(lam / Math.max(KAPPA * 0.05, 1), 0.25, 4); // effective floor prior
  }
  const lam = lambdaPosterior(item, prior, turn);
  return clamp(lam / prior, 0.25, 4);
}

/**
 * Posterior spread σ² of λᵢ (Beta(a, b) with a = κp₀+hits, b = κ(1−p₀)+misses).
 * Null when no evidence exists.
 */
export function evidenceVariance(item: ContextItem, prior: number, turn?: number): number | null {
  if (item.refEvidence === undefined) return null;
  const n = observedTurns(item, turn);
  const hits = item.refEvidence.hits.filter((h) => (turn === undefined ? true : h <= turn)).length;
  const a = KAPPA * prior + hits;
  const b = KAPPA * (1 - prior) + (n - hits);
  return (a * b) / ((a + b) ** 2 * (a + b + 1));
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
