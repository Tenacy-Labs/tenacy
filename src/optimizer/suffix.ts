/**
 * Exact suffix pricing + shared-bill accounting + TTL-expiry collapse —
 * ADR-0006 §4 (phase 3).
 *
 * The incumbent render carries per-block token mass and write turns, so:
 *  - suffixMassAfter returns the TRUE byte mass after an old position
 *    (replacing the proportional block-share approximation);
 *  - sharedBillSurcharge implements cheapest-break-set billing: the
 *    provider charges ONE cache discontinuity per position (the leftmost
 *    changed block); per-item suffix summation overcounts when several
 *    items restructure in one turn, and this credit corrects it;
 *    cold — suffix terms after them collapse to zero, so restructures
 *    batched into an expiry window are free (§4's free-restructure moment).
 */
import type { ParamSet } from "./params.ts";

/** Incumbent block-mass vector (1-based positions; absent → proportional fallback). */
export interface IncumbentMass {
  blockMass?: readonly number[] | undefined;
  totalTokens: number;
  blockCount: number;
}

/** Exact token mass after the old 1-based position; proportional fallback. */
export function suffixMassAfter(inc: IncumbentMass, position: number): number {
  if (inc.blockMass !== undefined && inc.blockMass.length > 0) {
    let m = 0;
    for (let i = position; i < inc.blockMass.length; i++) m += inc.blockMass[i]!;
    return m;
  }
  const blocksAfter = Math.max(0, inc.blockCount - position);
  return inc.totalTokens * (blocksAfter / Math.max(1, inc.blockCount));
}

/**
 * Shared-bill correction (cheapest break-set). Given this turn's
 * restructure set [{position, mass = suffix mass the per-item term
 * charged}], the provider bills only the LEFTMOST break. Sum of per-item
 * terms overcounts by (Σmass − leftmost mass); this returns that
 * overcount as a NEGATIVE surcharge (a credit) at the spread price.
 * Single restructure → 0 (per-item term already exact).
 */
export function sharedBillSurcharge(
  ps: ParamSet,
  restructures: { position: number; mass: number }[],
): number {
  if (restructures.length <= 1) return 0;
  const leftmost = Math.min(...restructures.map((r) => r.position));
  const leftmostMass = restructures.find((r) => r.position === leftmost)!.mass;
  const overcount = restructures.reduce((s, r) => s + r.mass, 0) - leftmostMass;
  return -(overcount / 1000) * (ps.cache.pricePer1kUncached - ps.cache.pricePer1kCached);
}

