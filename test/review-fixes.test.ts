/**
 * Review-fix regression tests (2026-08-22 three-reviewer gate).
 *
 * Every test here encodes a finding from CODE_REVIEW_{A,B,C}.md and is
 * written to FAIL on the pre-fix code (discriminating — verified by
 * construction against the reported probes).
 */
import { describe, test, expect } from "bun:test";
import { lambdaPosterior, evidenceValueFactor } from "../src/optimizer/evidence.ts";
import { StandingItem, NoticeItem } from "../src/optimizer/items.ts";
import { solve } from "../src/optimizer/solver.ts";
import { paramSetV1 } from "../src/optimizer/params.ts";
import { estTokens } from "../src/optimizer/renderer.ts";
import type { ContextItem } from "../src/optimizer/types.ts";

const withEv = (hits: number[]): ContextItem => ({
  ...new StandingItem("identity", "identity", "body").toContextItem(),
  refEvidence: { hits, accessClass: "cited" },
});

describe("review A-C1/M1 — prior=0 kinds (identity/episodic/error)", () => {
  test("C1: zero hits, prior 0 → factor 1 (not NaN), posterior finite", () => {
    const f = evidenceValueFactor(withEv([]), 0);
    expect(Number.isNaN(f)).toBe(false);
    expect(f).toBe(1);
    expect(Number.isFinite(lambdaPosterior(withEv([]), 0))).toBe(true);
  });

  test("M1: one hit, prior 0 → factor finite and below the clamp ceiling", () => {
    // A single hit on a never-re-referenced class must not resurrect the
    // item to the maximum multiplier (x/0 → ∞ → clamp 4 is meaningless).
    const f = evidenceValueFactor(withEv([3]), 0);
    expect(Number.isFinite(f)).toBe(true);
    expect(f).toBeLessThan(4);
  });

  test("guard does not change prior>0 behavior (regression)", () => {
    const hot = withEv([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(evidenceValueFactor(hot, 0.3, 20)).toBeGreaterThan(1);
    const dead = { ...withEv([]), createdTurn: 0, lastTouchTurn: 20 };
    expect(evidenceValueFactor(dead, 0.3, 20)).toBeLessThan(1);
  });
});

describe("review A-M3 — restored sessions can merge/re-expand (convoTurn accepts getter-form verbatim)", () => {
  test("addRestoredTurn registers a TurnItem whose convoTurn facade works", async () => {
    const { AgentLoop } = await import("../src/optimizer/loop.ts");
    const { MockProvider } = await import("../src/optimizer/providers.ts");
    const { executeIntent } = await import("../src/optimizer/intents.ts");
    const { paramSetV1 } = await import("../src/optimizer/params.ts");
    const loop = new AgentLoop(new MockProvider(), paramSetV1("mock"), null);
    // Simulate a restored session: two real TurnItems (verbatim is a GETTER).
    loop.addRestoredTurn("turn-1-user", "user", "fact one: alpha", undefined, "VERBATIM");
    loop.addRestoredTurn("turn-2-model", "model", "reply one: beta", undefined, "VERBATIM");
    const t1 = loop.convoTurn("turn-1-user");
    expect(t1).toBeDefined();                    // pre-fix: undefined (function-form check)
    const m = executeIntent({ op: "convo.merge", from: 1, to: 2 }, loop.store, null);
    expect(m.ok).toBe(true);                     // pre-fix: "fewer than two turns in range"
    const re = executeIntent({ op: "convo.reexpand", id: "turn-1-user" }, loop.store, null);
    expect(re.ok).toBe(true);                    // pre-fix: "no such turn"
  });
});

describe("review A-M2 — μ₀ double-count in valueMass future-value stream", () => {
  test("merge-group FV uses mass alone (no second μ₀)", () => {
    // Discriminator: a valueMass>0 item whose option surface is a rewrite
    // option (hand-built item, suffix.test.ts style). futureValue feeds
    // benefit; pre-fix the FV stream multiplied an already-μ₀-baked mass
    // by profile.mu0 again. We assert the ledger's benefit is finite and
    // matches the mass-only expectation (not 3× it).
    const ps = paramSetV1("mock");
    const mk = (id: string, text: string): ContextItem => ({
      id, kind: "directive", velocity: "volatile", immutable: false,
      tokens: estTokens(text),
      serialize: () => text,
      options: () => [{
        id: "as-is", purelyAdditive: false, zones: ["foundational"], representation: "AS_IS",
        tokens: estTokens(text), text,
      }],
      lastTouchTurn: 12, createdTurn: 4, valueMass: 24,
    });
    const r = solve(new Map([["m:1", mk("m:1", "merged group payload")]]), {
      rendered: new Map(), totalTokens: 0, blockCount: 0,
    }, ps, 12);
    const l = r.itemLedgers.find((i) => i.id === "m:1")!;
    // Self-calibrating discriminator: recompute the mass-only FV from the
    // same ParamSet. Pre-fix the solver passed mass*mu0 — the ledger FV
    // would then equal this same formula with mu0 = 24*6 (directive mu0),
    // i.e. far off this exact value.
    const tokens = estTokens("merged group payload");
    const dT = 8, q = 1; // createdTurn 4, turn 12; AS_IS directive option
    let expected = 0;
    for (let k = 1; k <= Math.min(ps.fv.horizon, ps.fv.horizon); k++) {
      expected += Math.pow(ps.fv.gamma, k) * (q * 24 * Math.pow(1 + dT + k, -0.2) - ps.reservationPrice * tokens);
    }
    expect(l.forecast.futureValue).toBeDefined();
    expect(l.forecast.futureValue!).toBeCloseTo(expected, 6);
    expect(Number.isFinite(l.utility.benefit)).toBe(true);
  });
});

describe("review A-M4 — new-item hazard premium charges own tokens, not the window", () => {
  test("fresh notice utility independent of incumbent window size", () => {
    // Same 13t notice, hazard 0.9: pre-fix utility at 20k window ≈ −45 (dropped),
    // at 100t window ≈ +3.6 (kept). Post-fix both decisions identical — entry
    // overpricing by hazard·(W/1000)·spread is gone.
    const ps = paramSetV1("mock");
    const solveAt = (windowTokens: number) => {
      const notice = new NoticeItem("n:1", "notice", "short notice body", "volatile", false, [], 0.9).toContextItem();
      const items = new Map<string, ContextItem>([["n:1", notice]]);
      const incumbent = {
        rendered: new Map(), totalTokens: windowTokens, blockCount: Math.max(1, Math.round(windowTokens / 100)),
      };
      return solve(items, incumbent, ps, 5).itemLedgers.find((i) => i.id === "n:1");
    };
    const small = solveAt(100);
    const large = solveAt(20_000);
    expect(small).toBeDefined();
    expect(large).toBeDefined();
    expect(small!.decision).toBe(large!.decision);
  });
});
