import { describe, expect, test } from "bun:test";
import { blockDigest, paramSetV1, solve } from "../src/index.ts";
import type { ContextItem, Incumbent, ParamSet } from "../src/index.ts";
import { planSequenceMoves, type PositionEntry } from "../src/sequence-position.ts";
function pe(id: string, seq: import("../src/index.ts").SequencePosition | undefined, tokens = 10, zone: import("../src/index.ts").Zone = "evolving"): PositionEntry {
  const option: import("../src/index.ts").RenderOption = {
    id: "full", purelyAdditive: true, zones: [zone], representation: "AS_IS",
    tokens, text: id + ":" + "x".repeat(tokens),
    ...(seq === undefined ? {} : { sequence: seq }),
  };
  return {
    item: {
      id, kind: "reference", immutable: false, tokens,
      serialize: () => option.text, options: () => [option],
      lastTouchTurn: 0, createdTurn: 0,
    },
    option, utility: 1,
  };
}

function rewriteItem(id: string, text: string, tokens: number): ContextItem {
  return { id, kind: "reference", immutable: false, tokens, serialize: () => text,
    options: () => [{ id: "full", purelyAdditive: false, zones: ["evolving"], representation: "AS_IS", tokens, text }],
    lastTouchTurn: 0, createdTurn: 0 };
}

function fuParams(): ParamSet {
  const p = paramSetV1("fu");
  p.budgetLambda = 100_000; p.reservationPrice = 0; p.hysteresisMargin = 0;
  p.cache.ttlTurns = 1; p.cache.ttlMs = 100;
  return p;
}

function fuIncumbent(overrides: Partial<Incumbent>): Incumbent {
  return {
    rendered: new Map([
      ["a", { position: 1, zone: "evolving" as const, digest: blockDigest("old-a"), representation: "AS_IS" as const, optionId: "full" }],
      ["b", { position: 2, zone: "evolving" as const, digest: blockDigest("old-b"), representation: "AS_IS" as const, optionId: "full" }],
      ["c", { position: 3, zone: "evolving" as const, digest: blockDigest("old-c"), representation: "AS_IS" as const, optionId: "full" }],
    ]),
    totalTokens: 600, blockCount: 3, blockMass: [100, 200, 300], blockWriteTurns: [0, 0, 0],
    ...overrides,
  };
}

const fuItems = (): Map<string, ContextItem> => new Map([
  ["a", rewriteItem("a", "new-a", 100)],
  ["b", rewriteItem("b", "new-b", 200)],
  ["c", rewriteItem("c", "new-c", 300)],
]);

describe("verification follow-ups", () => {
  test("#4 shared-bill credit: fresh snapshot must not suppress per-block turn expiry", () => {
    // Fresh snapshot + expired turn stamps: per-block evidence (MAJOR-4
    // semantics) says every suffix block is cold, so the shared-bill
    // overcount is zero and the credit must vanish.
    const expired = solve(fuItems(), fuIncumbent({ cacheSnapshotWallTimeMs: 950 }), fuParams(), 10, 1000);
    expect(expired.sharedBillCredit).toBeCloseTo(0, 10);
    // Warm companion: fresh snapshot + fresh turns must price identically to
    // no snapshot + fresh turns (per-block evidence; snapshot only decides
    // when it is EXPIRED). Credit stays materially negative.
    const warm = solve(fuItems(), fuIncumbent({ cacheSnapshotWallTimeMs: 950, blockWriteTurns: [10, 10, 10] }), fuParams(), 10, 1000);
    const equiv = solve(fuItems(), fuIncumbent({ blockWriteTurns: [10, 10, 10] }), fuParams(), 10, 1000);
    expect(warm.sharedBillCredit).toBeLessThan(-0.1);
    expect(warm.sharedBillCredit).toBeCloseTo(equiv.sharedBillCredit, 10);
  });

  test("#6 suffixCount: phantom evidence past blockCount must not warm a cold suffix", () => {
    // Malformed incumbent: evidence arrays longer than the real block
    // count. True suffix (block 2 of 2) is turn-expired; phantom wall
    // stamps beyond blockCount are fresh. Cost must collapse to own.
    const inc: Partial<Incumbent> = {
      blockCount: 2, blockMass: [100, 200], blockWriteTurns: [0, 0, 0, 0, 0, 0, 0, 0],
      blockWriteWallTimeMs: [undefined, undefined, 995, 995, 995, 995, 995, 995],
    };
    const items = new Map([["a", rewriteItem("a", "new-a", 100)]]);
    const r = solve(items, fuIncumbent(inc), fuParams(), 10, 1000);
    const cost = r.itemLedgers.find((l) => l.id === "a" && l.optionChosen === "full")!.utility.cacheCost;
    expect(cost).toBeCloseTo(0.3, 10);
  });

  test("#5 pin: capped === (a further call would accept a move)", () => {
    const battery: PositionEntry[][] = [];
    const mk = (): PositionEntry[] => {
      const e: PositionEntry[] = [];
      for (let i = 0; i < 6; i++) e.push(pe(`b${i}`, { parentId: `p${i}`, ordinal: 0, role: "base" }));
      e.push(pe("spacer", undefined));
      for (let i = 0; i < 6; i++) e.push(pe(`d${i}`, { parentId: `p${i}`, ordinal: 1, role: "delta", placement: "fuse", migrationCreditTokens: 60 - i * 10 }));
      return e;
    };
    battery.push(mk());
    battery.push([pe("x", { parentId: "q", ordinal: 0, role: "base" }), pe("y", undefined)]);
    for (const entries of battery) {
      const first = planSequenceMoves(entries, [], 1, undefined);
      const second = planSequenceMoves(entries, [], 1, undefined);
      expect(first.capped).toBe(second.acceptedMoves > 0);
      expect(second.capped).toBe(false);
    }
  });
});
