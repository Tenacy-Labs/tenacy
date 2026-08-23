/**
 * A-M5 ruling (owner, 2026-08-23): prior-0 kinds are evidence-NEUTRAL —
 * access evidence never rescales their value. Identity/episodic/error are
 * priced by μ₀, floors, and deliberate signals (ctx.promote), not by
 * accidental access. The old prior<=0 branch (dead subexpression
 * Math.max(KAPPA*0.05, 1) === 1 → one hit quartered value 10 → 2.5) is
 * gone entirely.
 *
 * Error lifecycle (owner ruling, 2026-08-23): errors are sticky UNTIL
 * RESOLVED — state-based, not time-based. Unresolved error items keep
 * their floor indefinitely; a resolvedTurn stamp releases the floor and
 * restores episodic-class decay so the lesson glides out promptly.
 */
import { describe, expect, test } from "bun:test";
import { evidenceValueFactor } from "../src/optimizer/evidence.ts";
import { makeTurnItem } from "../src/optimizer/loop.ts";
import { HAZARD_PRIORS_V1, paramSetV1 } from "../src/optimizer/params.ts";
import { solve } from "../src/optimizer/solver.ts";
import { ContextStore } from "../src/optimizer/store.ts";
import type { ContextItem } from "../src/optimizer/types.ts";

function withHits(item: ContextItem, hits: number[], accessClass: "cited" | "distilledFrom" | "searchHit" | "reExpanded" = "searchHit"): ContextItem {
  (item as { refEvidence?: unknown }).refEvidence = { hits, accessClass };
  return item;
}

describe("A-M5: prior-0 kinds are evidence-neutral", () => {
  test("identity prior is 0 (fixture honesty)", () => {
    expect(HAZARD_PRIORS_V1.identity).toBe(0);
    expect(HAZARD_PRIORS_V1.episodic).toBe(0);
    expect(HAZARD_PRIORS_V1.error).toBe(0);
  });

  test("identity: one search hit does NOT quarter value", () => {
    const identity = withHits(
      {
        id: "identity:1", kind: "identity", immutable: true, tokens: 40,
        serialize: () => "You are the kernel agent. Λ = 24,000 binds.",
        options: () => [], lastTouchTurn: 10, createdTurn: 0,
      },
      [7],
    );
    expect(evidenceValueFactor(identity, HAZARD_PRIORS_V1.identity, 10)).toBe(1); // was 0.25
  });

  test("episodic: recall access does NOT quarter a conversation turn", () => {
    const turn = withHits(makeTurnItem("turn-41", "user", "Use Λ=2048 for the stress test", 40), [41, 44]);
    expect(evidenceValueFactor(turn, HAZARD_PRIORS_V1.episodic, 45)).toBe(1); // was 0.25
  });

  test("error: re-encountering the wall does NOT quarter the lesson", () => {
    const lesson = withHits(
      {
        id: "err:12", kind: "error", immutable: true, tokens: 30,
        serialize: () => "bun file: deps 404 on private repos — vendor pinned tags",
        options: () => [], lastTouchTurn: 12, createdTurn: 3,
      },
      [12],
    );
    expect(evidenceValueFactor(lesson, HAZARD_PRIORS_V1.error, 12)).toBe(1); // was 0.25
  });

  test("nonzero-prior kinds keep evidence pricing (regression guard)", () => {
    const lens = withHits(
      {
        id: "lens:src/kernel.ts", kind: "lens", immutable: false, tokens: 100,
        serialize: () => "src/kernel.ts 1-60", options: () => [],
        lastTouchTurn: 20, createdTurn: 0,
      },
      [5, 9, 13, 17],
    );
    const f = evidenceValueFactor(lens, HAZARD_PRIORS_V1.lens, 20);
    expect(f).toBeGreaterThan(1);
    expect(f).toBeLessThanOrEqual(4);
  });
});

describe("Error lifecycle: sticky until resolved, then episodic glide", () => {
  const ps = paramSetV1("test");

  /** Value the solver assigns an error item at `turn` via its ledger. */
  function errorValueAt(resolvedTurn: number | undefined, turn: number): number {
    const item: ContextItem = {
      id: "err:lifecycle", kind: "error", immutable: true, tokens: 10,
      serialize: () => "[error-evidence] lesson", options: () => [{
        id: "error-ev", zones: ["evolving"], representation: "AS_IS",
        tokens: 10, purelyAdditive: true, text: "[error-evidence] lesson",
      }],
      lastTouchTurn: 2, createdTurn: 2, resolvedTurn,
    };
    const store = new ContextStore();
    store.add(item);
    const r = solve(store.snapshot(), { rendered: new Map(), totalTokens: 0, blockCount: 0 }, ps, turn);
    const led = r.itemLedgers.find((l) => l.id === "err:lifecycle");
    if (!led) throw new Error("no ledger for error item");
    return led.forecast.expectedValue;
  }

  test("profile: time floor removed, state floor present, glide is episodic-speed", () => {
    expect(ps.profiles.error.floorTurns).toBeUndefined();
    expect(ps.profiles.error.floorValue).toBeUndefined();
    expect(ps.profiles.error.floorWhileUnresolved).toBe(2.0);
    expect(ps.profiles.error.alpha).toBe(1.0);
  });

  test("unresolved error: floor holds at ANY age (sticky)", () => {
    expect(errorValueAt(undefined, 20)).toBeGreaterThanOrEqual(2.0);
    expect(errorValueAt(undefined, 200)).toBeGreaterThanOrEqual(2.0); // time is not the variable
  });

  test("resolved error: floor lifts and value decays below it", () => {
    const v = errorValueAt(10, 200);
    expect(v).toBeLessThan(2.0); // 4.5 * (1+198)^-1 ≈ 0.02 — the lesson glides out
  });

  test("resolve stamps the decay clock: value decays from RESOLVE turn, not creation", () => {
    // Real path: store.add at turn 0 (creation clock), resolveError at
    // turn 10 stamps resolvedTurn AND lastTouchTurn — the lesson's value
    // clock restarts at resolution. Viewed at turn 12: deltaT = 2.
    const item: ContextItem = {
      id: "err:clock", kind: "error", immutable: true, tokens: 10,
      serialize: () => "[error-evidence] lesson", options: () => [{
        id: "error-ev", zones: ["evolving"], representation: "AS_IS",
        tokens: 10, purelyAdditive: true, text: "lesson",
      }],
      lastTouchTurn: 0, createdTurn: 0,
    };
    const store = new ContextStore();
    store.add(item);
    for (let i = 0; i < 10; i++) store.nextTurn();
    expect(store.resolveError("err:clock")).toBe(true);
    expect(item.lastTouchTurn).toBe(10);
    const r = solve(store.snapshot(), { rendered: new Map(), totalTokens: 0, blockCount: 0 }, ps, 12);
    const led = r.itemLedgers.find((l) => l.id === "err:clock")!;
    // 4.5 · (1 + 12−10)^−1 = 1.5 — decays from resolve, and (being < 2.0
    // floor-less) may legitimately drop; the forecast value is the pin.
    expect(led.forecast.expectedValue).toBeLessThan(2.0);
    expect(led.forecast.expectedValue).toBeCloseTo(4.5 * Math.pow(3, -1), 5);
  });
});

describe("err.resolve signal", () => {
  test("store.resolveError stamps resolvedTurn idempotently, rejects non-errors", () => {
    const store = new ContextStore();
    const err: ContextItem = {
      id: "err:9", kind: "error", immutable: true, tokens: 8,
      serialize: () => "[error-evidence] x", options: () => [],
      lastTouchTurn: 0, createdTurn: 0,
    };
    store.add(err);
    store.turn = 5;
    expect(store.resolveError("err:9")).toBe(true);
    expect(err.resolvedTurn).toBe(5);
    // idempotent — earliest resolution wins
    store.turn = 9;
    store.resolveError("err:9");
    expect(err.resolvedTurn).toBe(5);
    // non-error ids refuse
    const ep = makeTurnItem("turn-1", "user", "hi", 1);
    store.add(ep);
    expect(store.resolveError("turn-1")).toBe(false);
  });
});
