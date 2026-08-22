/**
 * ADR-0006 §2 phase 1 — evidence-priced properties (additive).
 *
 * refEvidence -> lambda_i posterior (shrinkage toward kind prior);
 * evidenceValueFactor (exactly 1.0 when absent — bit-identical behavior);
 * forecastVariance from posterior spread; store recordAccess wiring;
 * solver consumption (discriminating: dead evidence lowers the score).
 */
import { describe, test, expect } from "bun:test";
import { lambdaPosterior, evidenceValueFactor, evidenceVariance } from "../src/optimizer/evidence.ts";
import { ContextStore } from "../src/optimizer/store.ts";
import { StandingItem, GoalItem } from "../src/optimizer/items.ts";
import { solve } from "../src/optimizer/solver.ts";
import { paramSetV1 } from "../src/optimizer/params.ts";
import type { ContextItem } from "../src/optimizer/types.ts";

const EMPTY_INCUMBENT: Parameters<typeof solve>[1] = {
  rendered: new Map(),
  totalTokens: 0,
  blockCount: 0,
};

describe("ADR-0006 §2.1 — refEvidence / lambda_i", () => {
  test("absent evidence: posterior equals the kind prior exactly, factor exactly 1", () => {
    const item = new StandingItem("identity", "identity", "hello").toContextItem();
    expect(item.refEvidence).toBeUndefined();
    expect(lambdaPosterior(item, 0.3)).toBe(0.3);
    expect(evidenceValueFactor(item, 0.3)).toBe(1);
    expect(evidenceVariance(item, 0.3)).toBeNull();
  });

  test("hits-heavy item: posterior rises above prior; dead item sinks below", () => {
    const base = new StandingItem("identity", "identity", "h").toContextItem();
    const hot: ContextItem = { ...base, refEvidence: { hits: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], accessClass: "cited" } };
    const dead: ContextItem = { ...base, createdTurn: 0, lastTouchTurn: 20, refEvidence: { hits: [], accessClass: "cited" } };
    const turns = 20;
    expect(lambdaPosterior(hot, 0.3, turns)).toBeGreaterThan(0.3);
    expect(lambdaPosterior(dead, 0.3, turns)).toBeLessThan(0.3);
    expect(evidenceValueFactor(hot, 0.3, turns)).toBeGreaterThan(1);
    expect(evidenceValueFactor(dead, 0.3, turns)).toBeLessThan(1);
  });

  test("shrinkage: few observations stay near the prior (no confident posteriors from thin data)", () => {
    const base = new StandingItem("identity", "identity", "t").toContextItem();
    const thin: ContextItem = { ...base, lastTouchTurn: 2, refEvidence: { hits: [1], accessClass: "cited" } };
    // 1 hit in 2 observed turns, kappa=10, prior 0.3 -> (3+1)/12 = 0.333 — close to prior
    const l = lambdaPosterior(thin, 0.3, 2);
    expect(Math.abs(l - 0.3)).toBeLessThan(0.05);
  });

  test("variance: thinner evidence -> wider posterior; absent -> null", () => {
    const base = new StandingItem("identity", "identity", "t").toContextItem();
    const thin: ContextItem = { ...base, lastTouchTurn: 2, refEvidence: { hits: [1], accessClass: "cited" } };
    const thick: ContextItem = { ...base, lastTouchTurn: 20, refEvidence: { hits: Array.from({ length: 20 }, (_, i) => i + 1), accessClass: "cited" } };
    const vThin = evidenceVariance(thin, 0.3, 2)!;
    const vThick = evidenceVariance(thick, 0.3, 20)!;
    expect(vThick).toBeLessThan(vThin);
  });
});

describe("ADR-0006 §2.1 — store wiring", () => {
  test("recordAccess appends hits lazily and caps the window", () => {
    const store = new ContextStore();
    store.add(new StandingItem("identity", "identity", "x").toContextItem());
    store.recordAccess("identity", "cited", 1);
    store.recordAccess("identity", "cited", 2);
    let it = store.get("identity")!;
    expect(it.refEvidence).toBeDefined();
    expect(it.refEvidence!.hits.length).toBe(2);
    for (let t = 3; t <= 120; t++) store.recordAccess("identity", "cited", t);
    it = store.get("identity")!;
    expect(it.refEvidence!.hits.length).toBeLessThanOrEqual(64);
    expect(it.refEvidence!.hits.at(-1)).toBe(120);
  });

  test("recordAccess on unknown id is a no-op (no crash)", () => {
    const store = new ContextStore();
    store.recordAccess("ghost", "cited", 1);
    expect(store.get("ghost")).toBeUndefined();
  });
});

describe("ADR-0006 §2.1 — solver consumption (discriminating)", () => {
  test("dead evidence lowers an item's utility below the no-evidence twin", () => {
    const ps = paramSetV1("mock");
    const plain = new GoalItem("goal:1", "important standing goal").toContextItem();
    const dead: ContextItem = {
      ...new GoalItem("goal:1", "important standing goal").toContextItem(),
      createdTurn: 0,
      lastTouchTurn: 40,
      refEvidence: { hits: [], accessClass: "cited" },
    };
    const rrPlain = solve(new Map([["goal:1", plain]]), EMPTY_INCUMBENT, ps, 40);
    const rrDead = solve(new Map([["goal:1", dead]]), EMPTY_INCUMBENT, ps, 40);
    const plainTotal = rrPlain.itemLedgers.find((i) => i.id === "goal:1")!.utility.total;
    const deadTotal = rrDead.itemLedgers.find((i) => i.id === "goal:1")!.utility.total;
    expect(deadTotal).toBeLessThan(plainTotal);
  });

  test("evidence-present items journal forecast basis 'observed'", () => {
    const ps = paramSetV1("mock");
    const withEv: ContextItem = {
      ...new GoalItem("goal:2", "goal with evidence").toContextItem(),
      refEvidence: { hits: [1, 2, 3], accessClass: "cited" },
    };
    const rr = solve(new Map([["goal:2", withEv]]), EMPTY_INCUMBENT, ps, 5);
    const il = rr.itemLedgers.find((i) => i.id === "goal:2")!;
    expect(il.forecast.basis).toBe("observed");
  });
});
