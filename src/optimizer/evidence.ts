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
  // Review A-minor-6: cap n at the evidence window — an old item with a
  // recent hit burst kept n ≈ age, dragging λᵢ to the prior regardless of
  // activity. The hit store caps at WINDOW; the denominator must too.
  return Math.max(1, Math.min(t - item.createdTurn + 1, WINDOW));
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
  // A-M5 owner ruling (2026-08-23): prior-0 kinds (identity, episodic,
  // error) are evidence-NEUTRAL — access never rescales their value. The
  // old prior<=0 branch quartered value on first hit (dead subexpression
  // Math.max(KAPPA*0.05, 1) === 1 → clamp floor 0.25); identity anchors,
  // recall-answer turns, and error lessons were punished for being used.
  // Promotion for these kinds stays deliberate: ctx.promote (0002g) and
  // the 0002h weak-signal ruling (searches journal, never auto-price).
  if (prior <= 0) return 1;
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
  // Review C1 fix (2026-08-22): hits can exceed n (multiple access events
  // per turn — search-heavy turns, re-expands), which made b negative and
  // the Beta variance negative → sqrt → NaN hysteresis (silently disabled).
  // Count observed turns by DISTINCT hit turns — the Beta's n must count
  // observation opportunities, not raw access events.
  const hitTurns = new Set(item.refEvidence.hits.filter((h) => (turn === undefined ? true : h <= turn)));
  const nEff = Math.max(n, hitTurns.size);
  const a = KAPPA * prior + hits;
  const b = KAPPA * (1 - prior) + (nEff - hits);
  if (b <= 0 || a <= 0 || a + b <= 0) return null;
  return (a * b) / ((a + b) ** 2 * (a + b + 1));
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
