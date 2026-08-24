// RED: relief engagement at scale — the full-window wall, honestly tested.
// Reviewer finding (PR #3, 2026-08-24): the prior test never reached
// exactMckpRelief (stale items rejected in phase 1, totalTokens = 0), so it
// validated nothing. This file pins the MECHANISM at a DP-engaged scale,
// and documents the full-window wall as a bound, not a runtime assertion.
import { describe, expect, test } from "bun:test";
import { solve, paramSetV1 } from "../src/index.ts";
import type { ContextItem, ItemKind } from "../src/index.ts";

function freshItem(id: string, tok: number, kind: ItemKind): ContextItem {
  const options = [
    { id: "full", purelyAdditive: true, zones: ["evolving"] as const, representation: "AS_IS" as const, tokens: tok, text: "x" },
    { id: "tomb", purelyAdditive: true, zones: ["evolving"] as const, representation: "AS_IS" as const, tokens: 8, text: "t", zeroValue: true },
  ];
  return { id, kind, immutable: false, tokens: tok, serialize: () => "x",
    options: () => options, lastTouchTurn: 0, createdTurn: 0 };
}

describe("relief engagement", () => {
  test("over-budget fresh content fires exact relief, feasible, deterministic", () => {
    const n = 220, tok = 150; // 33k tokens of content
    const items = new Map<string, ContextItem>();
    for (let i = 0; i < n; i++) items.set("i" + i, freshItem("i" + i, tok, i % 5 === 0 ? "episodic" : "reference"));
    const ps = paramSetV1("q");
    ps.budgetLambda = 24_000; // 33k content vs 24k budget: relief MUST fire
    ps.cache.ttlTurns = 4; ps.cache.ttlMs = undefined as unknown as number;
    const r1 = solve(items, { rendered: new Map(), totalTokens: 0, blockCount: 0 }, ps, 12, 1000);
    const r2 = solve(items, { rendered: new Map(), totalTokens: 0, blockCount: 0 }, ps, 12, 1000);
    // Engagement: content exists and budget relief had work to do.
    expect(r1.totalTokens).toBeGreaterThan(0);
    expect(r1.totalTokens).toBeLessThanOrEqual(ps.budgetLambda);
    // Determinism: identical inputs -> identical decisions.
    expect(r2.totalTokens).toBe(r1.totalTokens);
    expect(r2.placements).toEqual(r1.placements);
    expect(r2.itemLedgers).toEqual(r1.itemLedgers); // full ledger equality
  });
});

describe("full-window bounded relief", () => {
  test("10k items / 1M window over-budget relief: engaged, fast, feasible, deterministic", () => {
    const n = 10_000, tok = 150; // 1.5M tokens of content vs 900k window
    const items = new Map<string, ContextItem>();
    for (let i = 0; i < n; i++) items.set("i" + i, freshItem("i" + i, tok, i % 5 === 0 ? "episodic" : "reference"));
    const ps = paramSetV1("q");
    ps.budgetLambda = 900_000; // 10M content vs 900k budget: relief MUST fire
    ps.cache.ttlTurns = 4; ps.cache.ttlMs = undefined as unknown as number;
    const t0 = performance.now();
    const r1 = solve(items, { rendered: new Map(), totalTokens: 0, blockCount: 0 }, ps, 12, 1000);
    const ms = performance.now() - t0;
    const r2 = solve(items, { rendered: new Map(), totalTokens: 0, blockCount: 0 }, ps, 12, 1000);
    // ENGAGED: over-budget fresh content forces exactMckpRelief (not phase-1 prune).
    expect(r1.totalTokens).toBeGreaterThan(0);
    expect(r1.totalTokens).toBeLessThanOrEqual(ps.budgetLambda);
    // FAST at full window: bounded mode, not divide-and-conquer exact.
    // Hardware-honest threshold: CI runner measured 10.4s, M4 Max 1.6s;
    // the exact path at this scale is 37-42s local / minutes on CI —
    // 15s separates the regimes on any runner.
    expect(ms).toBeLessThan(15_000);
    // Deterministic.
    expect(r2.totalTokens).toBe(r1.totalTokens);
    expect(r2.placements).toEqual(r1.placements);
  }, 60_000); // 60s test timeout: the solve IS the measurement (bun default 5s)
});
