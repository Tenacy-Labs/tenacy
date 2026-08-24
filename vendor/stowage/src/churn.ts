/**
 * Content-renewal semantics — ADR-0006 §2.3 (churnProfile).
 *
 * Churn promoted from watcher-local to item property so the FV stream sees
 * content renewal. Two decays, never conflated:
 *   - value decay (interest fading)   — the power-law clock on deltaT
 *   - content decay (bytes changing)  — churn; the bytes are FRESH
 * A churning item's FV must not decay as if stale: renewal refreshes the
 * decay clock. hazardPremium keeps pricing k=0 change risk separately.
 *
 * Honest v1 (additive; bit-identical when churnProfile absent):
 *   credit = ewmaChurn-scaled turns since lastChangeTurn within (lastTouchTurn, turn]
 *   effectiveDeltaT = clamp(deltaT - credit, 0, deltaT)
 * Exact estimator family remains open per §9.
 */
import type { ContextItem } from "./types.ts";

/** Turns credited as renewed (0 when churnProfile is absent). */
export function renewalCredit(item: ContextItem, deltaT: number, lastTouchTurn?: number): number {
  const cp = item.churnProfile;
  if (cp === undefined) return 0;
  const ltt = lastTouchTurn ?? item.lastTouchTurn;
  if (cp.lastChangeTurn === undefined) return 0;
  // Turns AFTER the last touch are the renewals we can honestly credit:
  // a change at or before lastTouch is already priced into the touch itself.
  if (cp.lastChangeTurn <= ltt) return 0;
  const renewed = cp.lastChangeTurn - ltt;
  // Scale by observed churn intensity (EWMA of events per turn; 1 = every turn).
  return Math.min(deltaT, Math.max(0, Math.floor(cp.ewmaChurn * renewed)));
}

/** The FV decay clock after renewal credit (never negative, never inflated). */
export function effectiveDeltaT(item: ContextItem, deltaT: number, lastTouchTurn?: number): number {
  return Math.max(0, deltaT - renewalCredit(item, deltaT, lastTouchTurn));
}
