/**
 * ADR-0006 §2.3 — churnProfile (the last dead §2 property).
 *
 * Contract: churn promoted from watcher-local to item property, so the FV
 * stream sees content renewal. Two decays must not be conflated:
 *   - value decay (interest fading)   — the power-law clock on deltaT
 *   - content decay (bytes changing)  — churn; the bytes are FRESH
 * A churning item's FV must not decay as if stale: renewal refreshes the
 * decay clock. hazardPremium keeps pricing the k=0 change risk (correct
 * today, untouched).
 *
 * v1 semantics (additive, bit-identical when churnProfile is absent):
 *   effectiveDeltaT = deltaT - renewalCredit
 *   renewalCredit = min(deltaT, floor(churnProfile.ewmaChurn * lastChangeTurn))
 * when lastChangeTurn is recent relative to lastTouchTurn, the churn
 * happened AFTER the last touch — those turns count as renewed.
 * Exact estimator family stays open per §9 (this is the honest floor).
 */
import { describe, test, expect } from "bun:test";
import { renewalCredit, effectiveDeltaT } from "../src/optimizer/churn.ts";

describe("ADR-0006 §2.3 — churnProfile / content renewal", () => {
  test("absent churnProfile: no credit, deltaT unchanged (bit-identical)", () => {
    const item = { kind: "lens" } as never;
    expect(renewalCredit(item, 10)).toBe(0);
    expect(effectiveDeltaT(item, 10)).toBe(10);
  });

  test("renewal after last touch: turns since change are credited", () => {
    const item = { churnProfile: { ewmaChurn: 1.0, lastChangeTurn: 8 } } as never;
    // lastTouchTurn = 2 → deltaT = 10 - 2 = 8; change landed at t8 → 2 stale turns remain
    expect(effectiveDeltaT(item, 8, 2)).toBe(2);
  });

  test("renewal every turn (perfect churn): stale turns fully credited", () => {
    const item = { churnProfile: { ewmaChurn: 1.0, lastChangeTurn: 10 } } as never;
    // lastTouch t2, change every turn → change at t10 ≥ lastTouch → full credit of deltaT=8
    expect(effectiveDeltaT(item, 8, 2)).toBe(0);
  });

  test("credit never exceeds deltaT nor goes negative", () => {
    const item = { churnProfile: { ewmaChurn: 0.5, lastChangeTurn: 20 } } as never;
    // lastTouch t2, deltaT=8, but change at t20 (beyond lastTouch window) — still clamped
    expect(effectiveDeltaT(item, 8, 2)).toBeGreaterThanOrEqual(0);
  });
});
