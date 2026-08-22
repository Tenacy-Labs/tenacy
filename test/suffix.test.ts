/**
 * ADR-0006 §4 phase 3 — exact suffix pricing + shared-bill accounting +
 * TTL-expiry collapse (free restructure windows).
 *
 * Exact suffix mass: the incumbent carries per-block token mass, so the
 * re-bill after a rewrite is the true byte mass after the old position —
 * no proportional approximation.
 * Shared bill: provider bills ONE break per position (leftmost changed
 * block); when multiple items restructure in one turn, per-item summation
 * double-counts. sequenceSurcharge replaces per-item suffix terms when the
 * turn has 2+ non-keep restructures.
 * TTL expiry: blocks older than ttlTurns are already cold — suffix terms
 * after them collapse to zero; restructures batched into that window are
 * free (the ADR's free-restructure moment).
 */
import { describe, test, expect } from "bun:test";
import { suffixMassAfter, sharedBillSurcharge, ttlWindowFree } from "../src/optimizer/suffix.ts";
import { paramSetV1 } from "../src/optimizer/params.ts";
import { solve } from "../src/optimizer/solver.ts";
import { estTokens } from "../src/optimizer/renderer.ts";
import type { ContextItem } from "../src/optimizer/types.ts";
import type { Zone } from "../src/optimizer/types.ts";

describe("ADR-0006 §4 — exact suffix mass", () => {
  test("sums true block mass after the old position (not proportional share)", () => {
    const incumbent = {
      rendered: new Map(),
      totalTokens: 1000, blockCount: 4,
      blockMass: [100, 400, 250, 250],   // dense positions
      standingMassDrift: undefined,
    };
    // rewrite of block at position 2 (1-based): suffix = blocks 3+4 = 500
    expect(suffixMassAfter(incumbent, 2)).toBe(500);
    expect(suffixMassAfter(incumbent, 1)).toBe(900);
    expect(suffixMassAfter(incumbent, 4)).toBe(0);
  });

  test("absent blockMass: falls back to the proportional approximation (bit-identical)", () => {
    const incumbent = { rendered: new Map(), totalTokens: 1000, blockCount: 4, standingMassDrift: undefined };
    expect(suffixMassAfter(incumbent, 2)).toBe(500);
  });
});

describe("ADR-0006 §4 — shared-bill (cheapest break-set) surcharge", () => {
  test("single rewrite: surcharge zero (per-item term already correct)", () => {
    const ps = paramSetV1("mock");
    expect(sharedBillSurcharge(ps, [{ position: 2, mass: 300 }])).toBe(0);
  });

  test("two restructures same turn: bill the LEFTMOST break once, credit back the rest", () => {
    const ps = paramSetV1("mock");
    // items at positions 2 and 3 restructure; per-item suffix terms charged
    // suffix(2)=700 and suffix(3)=450. The provider bills ONE break at the
    // LEFTMOST changed position — its suffix (700) covers everything after
    // it, including position 3's region. Overcount = 1150 − 700 = 450,
    // credited back at the spread price: −(450/1000) × 2.7 = −1.215.
    const s = sharedBillSurcharge(ps, [
      { position: 2, mass: 700 },
      { position: 3, mass: 450 },
    ]);
    expect(s).toBeCloseTo(-((700 + 450 - 700) / 1000) * (ps.cache.pricePer1kUncached - ps.cache.pricePer1kCached), 6);
  });
});

describe("ADR-0006 §4 — solver-level exact suffix + TTL window", () => {
  test("rewrite at tail: exact mass prices zero suffix; TTL-cold suffix is free", () => {
    const ps = paramSetV1("mock");
    // incumbent: 3 blocks [100, 400, 500] written at turns [4, 11, 11]; turn is 12
    const incumbent = {
      rendered: new Map<string, { position: number; zone: Zone; digest: string; representation: string; optionId: string }>([
        ["a", { position: 1, zone: "foundational", digest: "da", representation: "AS_IS", optionId: "as-is" }],
        ["b", { position: 2, zone: "foundational", digest: "db", representation: "AS_IS", optionId: "as-is" }],
        ["c", { position: 3, zone: "evolving", digest: "dc", representation: "AS_IS", optionId: "as-is" }],
      ]),
      totalTokens: 1000, blockCount: 3,
      blockMass: [100, 400, 500], blockWriteTurns: [4, 11, 11],
      standingMassDrift: undefined,
    };
    // rewrite "a" (position 1): suffix = 900 EXACT (blocks 2+3), priced at spread
    // rewrite "c" (position 3): suffix = 0 — the trailing region is TTL-cold
    // at turn 12 (block 1 written turn 4, age 8 > 6) → free restructure window
    const mk = (id: string, text: string): ContextItem => ({
      id, kind: "directive", velocity: "volatile", immutable: false,
      tokens: estTokens(text),
      serialize: () => text, options: () => [{ id: "as-is", purelyAdditive: false, zones: ["foundational"], representation: "AS_IS", tokens: estTokens(text), text }],
      lastTouchTurn: 12, createdTurn: 4,
    });
    const a = mk("a", "rewritten content A");
    const c = mk("c", "rewritten content C");
    const rr = solve(new Map([["a", a], ["c", c]]), incumbent, ps, 12);
    const la = rr.itemLedgers.find((l) => l.id === "a")!;
    const lc = rr.itemLedgers.find((l) => l.id === "c")!;
    const own = (estTokens("rewritten content A") / 1000) * ps.cache.pricePer1kUncached;
    expect(la.utility.cacheCost).toBeCloseTo(own + (900 / 1000) * (ps.cache.pricePer1kUncached - ps.cache.pricePer1kCached), 4);
    expect(lc.utility.cacheCost).toBeCloseTo((estTokens("rewritten content C") / 1000) * ps.cache.pricePer1kUncached, 4);  // free window
  });
});

describe("ADR-0006 §4 — TTL-expiry collapse (free restructures)", () => {
  test("suffix terms after an expired block collapse to zero", () => {
    const ps = paramSetV1("mock");  // ttlTurns 6
    const blocks = [
      { position: 1, mass: 100, writeTurn: 1 },
      { position: 2, mass: 400, writeTurn: 10 },  // rewritten recently
      { position: 3, mass: 250, writeTurn: 10 },
    ];
    // block at position 1 is 10 turns old at turn 10 → expired → free suffix
    expect(ttlWindowFree(ps, blocks, 1, 10)).toBe(true);
    expect(ttlWindowFree(ps, blocks, 2, 10)).toBe(false);
  });

  test("restructures batched into the expiry window carry no suffix bill", () => {
    const ps = paramSetV1("mock");
    const blocks = [
      { position: 1, mass: 100, writeTurn: 1 },
      { position: 2, mass: 400, writeTurn: 1 },
    ];
    // turn 8: both blocks TTL-expired (written turn 1, ttl 6) → the whole
    // suffix is cold; restructuring anything this turn costs own-write only.
    expect(ttlWindowFree(ps, blocks, 1, 8)).toBe(true);
    expect(ttlWindowFree(ps, blocks, 2, 8)).toBe(true);
  });
});
