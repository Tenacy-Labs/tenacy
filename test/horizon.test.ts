/**
 * ADR-0006 phase 2 — pricing switch: T* horizon caps + two-class recoverability.
 *
 * T* = (Λ − W_t)/a_t (decision-invariant turnover estimate; §5);
 * H_value = min(fv.horizon, T*), H_cache = min(T*, ttlTurns);
 * content-preserving consolidation is NOT priced lossy when recoverability
 * says the bytes are recoverable (§3).
 */
import { describe, test, expect } from "bun:test";
import { turnoverStar, capHorizons, effectiveHysteresis } from "../src/optimizer/horizon.ts";
import { solve } from "../src/optimizer/solver.ts";
import { paramSetV1, type ParamSet } from "../src/optimizer/params.ts";
import type { ContextItem } from "../src/optimizer/types.ts";
import { StandingItem } from "../src/optimizer/items.ts";

const EMPTY = { rendered: new Map(), totalTokens: 0, blockCount: 0 };

describe("ADR-0006 §5 — T* estimator", () => {
  test("filling window: T* = headroom/drift; matches the L3 sanity check", () => {
    // Λ=2048, W=900, a=150 → T* ≈ 7.6
    const t = turnoverStar(2048, 900, 150);
    expect(t).toBeCloseTo((2048 - 900) / 150, 5);
    expect(t).toBeGreaterThan(7);
    expect(t).toBeLessThan(8);
  });

  test("non-positive drift: T* = Infinity (stable session prices the full cap)", () => {
    expect(turnoverStar(2048, 900, 0)).toBe(Infinity);
    expect(turnoverStar(2048, 900, -10)).toBe(Infinity);
  });

  test("two caps: H_value = min(horizon, T*); H_cache = min(T*, ttlTurns)", () => {
    const ps = paramSetV1("mock");   // horizon 20, ttlTurns 6
    const caps = capHorizons(ps, 2048, 900, 150);      // T* = 1148/150 ≈ 7.653
    expect(caps.hValue).toBeCloseTo(7.6533, 3);
    expect(caps.hCache).toBe(6);                        // ttl binds
    const caps2 = capHorizons(ps, 2048, 1200, 20);     // T* = 42.4 > horizon
    expect(caps2.hValue).toBe(20);                      // fixed cap binds
    expect(caps2.hCache).toBe(6);
  });

  test("absent drift: caps fall back to the fixed horizon (bit-identical)", () => {
    const ps = paramSetV1("mock");
    const caps = capHorizons(ps, 2048, 900, undefined);
    expect(caps.hValue).toBe(ps.fv.horizon);
    expect(caps.hCache).toBe(ps.cache.ttlTurns);
    expect(caps.tStar).toBe(Infinity);
  });
});

describe("ADR-0006 §2.4 — variance-scaled hysteresis", () => {
  test("absent evidence: margin unchanged", () => {
    const ps = paramSetV1("mock");
    const item = new StandingItem("identity", "identity", "x").toContextItem();
    expect(effectiveHysteresis(ps, item)).toBe(ps.hysteresisMargin);
  });

  test("thick evidence shrinks the margin; thin evidence raises it (risk aversion follows uncertainty)", () => {
    const ps = paramSetV1("mock");
    const base = new StandingItem("identity", "identity", "x").toContextItem();
    const thin: ContextItem = { ...base, createdTurn: 0, lastTouchTurn: 2, refEvidence: { hits: [1], accessClass: "cited" } };
    const thick: ContextItem = { ...base, createdTurn: 0, lastTouchTurn: 40, refEvidence: { hits: Array.from({ length: 40 }, (_, i) => i + 1), accessClass: "cited" } };
    const mThin = effectiveHysteresis(ps, thin);
    const mThick = effectiveHysteresis(ps, thick);
    expect(mThick).toBeLessThan(ps.hysteresisMargin);
    expect(mThin).toBeGreaterThan(mThick);
  });
});

describe("ADR-0006 §3 — two-class recoverability in the solver", () => {
  test("verbatim-preserving MERGED is priced with qRendered-class FV (not lossy)", () => {
    const ps = paramSetV1("mock");
    const lossy: ContextItem = {
      ...new StandingItem("merge:1", "directive", "merged content block").toContextItem(),
      kind: "episodic" as ContextItem["kind"],
    };
    // two merge groups with identical options; one recoverable, one not.
    // We verify via the ledger: the recoverable one must show >= FV.
    const makeGroup = (rec: ContextItem["recoverability"]): ContextItem => ({
      ...lossy, id: `merge:${rec}`, recoverability: rec, kind: "goal",
      options: () => [
        { id: "merged", zones: ["foundational"], representation: "MERGED", tokens: 100, purelyAdditive: false, text: "merged bytes" },
      ],
      lastTouchTurn: 0, createdTurn: 0,
    });
    const rrLossy = solve(new Map([["m1", makeGroup("lossy")]]), EMPTY, ps, 10);
    const rrPres = solve(new Map([["m2", makeGroup("verbatim-preserving")]]), EMPTY, ps, 10);
    const fvLossy = rrLossy.itemLedgers.find((i) => i.id === "merge:lossy")!.forecast.futureValue!;
    const fvPres = rrPres.itemLedgers.find((i) => i.id === "merge:verbatim-preserving")!.forecast.futureValue!;
    expect(fvPres).toBeGreaterThan(fvLossy);
  });
});

describe("ADR-0006 §5 — solver consumes the drift (T* caps the FV horizon)", () => {
  test("tight T* shortens the future-value stream", () => {
    const ps = paramSetV1("mock");
    const item: ContextItem = new StandingItem("d", "directive", "standing directive text").toContextItem();
    const noDrift = solve(new Map([["d", item]]), { ...EMPTY }, ps, 10);
    // Λ=24000, W=20000, drift 3000 → T* = 4000/3000 ≈ 1.33 < horizon 20 → FV shrinks
    const drifted = solve(new Map([["d", item]]), { rendered: new Map(), totalTokens: 20000, blockCount: 20, standingMassDrift: 3000 }, ps, 10);
    const fvNo = noDrift.itemLedgers.find((i) => i.id === "d")!.forecast.futureValue!;
    const fvYes = drifted.itemLedgers.find((i) => i.id === "d")!.forecast.futureValue!;
    expect(fvYes).toBeLessThan(fvNo);
  });
});
