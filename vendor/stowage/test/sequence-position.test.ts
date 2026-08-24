import { describe, expect, test } from "bun:test";
import {
  CacheModel,
  billingQuanta,
  breakpointPrice,
  blockDigest,
  interveningMoveMass,
  paramSetV1,
  solve,
} from "../src/index.ts";
import type {
  Block,
  ContextItem,
  Incumbent,
  ParamSet,
  RenderOption,
  SequencePosition,
  Zone,
} from "../src/index.ts";

function contextItem(
  id: string,
  tokens: number,
  sequence?: SequencePosition,
  turn = 0,
  zone: Zone = "evolving",
): ContextItem {
  const option: RenderOption = {
    id: "full",
    purelyAdditive: true,
    zones: [zone],
    representation: "AS_IS",
    tokens,
    text: `${id}:${"x".repeat(tokens)}`,
    ...(sequence === undefined ? {} : { sequence }),
  };
  return {
    id,
    kind: "reference",
    immutable: false,
    tokens,
    serialize: () => option.text,
    options: () => [option],
    lastTouchTurn: turn,
    createdTurn: turn,
    ...(sequence === undefined ? {} : { sequence }),
  };
}

function incumbentFor(items: ContextItem[], order: string[]): Incumbent {
  const byId = new Map(items.map((item) => [item.id, item] as const));
  return {
    rendered: new Map(order.map((id, index) => {
      const option = byId.get(id)!.options()[0]!;
      return [id, {
        position: index + 1,
        zone: option.zones[0]!,
        digest: blockDigest(option.text),
        representation: option.representation,
        optionId: option.id,
      }] as const;
    })),
    totalTokens: items.reduce((sum, item) => sum + item.tokens, 0),
    blockCount: items.length,
    blockMass: order.map((id) => byId.get(id)!.tokens),
  };
}

function roomyParams(): ParamSet {
  const ps = paramSetV1("sequence-test");
  ps.budgetLambda = 100_000;
  ps.reservationPrice = 0;
  ps.hysteresisMargin = 0;
  return ps;
}

describe("phase-3 sequence-position solve", () => {
  test("delta tail avoids exactly the intervening suffix mass", () => {
    expect(interveningMoveMass([100, 20, 300], 1, 3)).toBe(300);

    const base = contextItem("a-base", 100, { parentId: "file:a", ordinal: 0, role: "base" });
    const delta = contextItem("b-delta", 20, { parentId: "file:a", ordinal: 1, role: "delta" });
    const middle = contextItem("c-middle", 300);
    const result = solve(new Map([base, delta, middle].map((item) => [item.id, item])), {
      rendered: new Map(), totalTokens: 0, blockCount: 0,
    }, roomyParams(), 1);

    expect(result.placements.map((placement) => placement.id)).toEqual([
      "a-base", "c-middle", "b-delta",
    ]);
  });

  test("per-parent precedence preserves delta arrival order", () => {
    const delta2 = contextItem("a-delta-2", 10, { parentId: "file:a", ordinal: 1, role: "delta", predecessorId: "z-delta-1" });
    const base = contextItem("b-base", 100, { parentId: "file:a", ordinal: 0, role: "base" });
    // Deliberately conflicting ordinals prove explicit edges, not incidental id/ordinal sorting, enforce arrival.
    const delta1 = contextItem("z-delta-1", 10, { parentId: "file:a", ordinal: 2, role: "delta", predecessorId: "b-base" });
    const result = solve(new Map([delta2, base, delta1].map((item) => [item.id, item])), {
      rendered: new Map(), totalTokens: 0, blockCount: 0,
    }, roomyParams(), 1);
    const family = result.placements.filter((p) => p.id !== "unrelated").map((p) => p.id);
    expect(family).toEqual(["b-base", "z-delta-1", "a-delta-2"]);
  });

  test("migration credit fuses only after it covers the suffix bill and logs regret", () => {
    const base = contextItem("base", 100, { parentId: "file:a", ordinal: 0, role: "base" });
    const middle = contextItem("middle", 300);
    const delta = contextItem("delta", 20, {
      parentId: "file:a", ordinal: 1, role: "delta", placement: "fuse", migrationCreditTokens: 299,
    });
    const items = [base, middle, delta];
    const rejected = solve(new Map(items.map((item) => [item.id, item])), incumbentFor(items, ["base", "middle", "delta"]), roomyParams(), 1);
    expect(rejected.placements.map((p) => p.id)).toEqual(["base", "middle", "delta"]);
    expect(rejected.itemLedgers.find((l) => l.id === "delta" && l.positionRegret)?.positionRegret).toMatchObject({
      fromPosition: 3, toPosition: 2, suffixBillTokens: 300, migrationCreditTokens: 299, accepted: false,
    });

    const credited = contextItem("delta", 20, {
      parentId: "file:a", ordinal: 1, role: "delta", placement: "fuse", migrationCreditTokens: 300,
    });
    const acceptedItems = [base, middle, credited];
    const accepted = solve(new Map(acceptedItems.map((item) => [item.id, item])), incumbentFor(acceptedItems, ["base", "middle", "delta"]), roomyParams(), 1);
    expect(accepted.placements.map((p) => p.id)).toEqual(["base", "delta", "middle"]);
    expect(accepted.acceptedMoves).toBe(1);
  });

  test("layout and diagnostics are deterministic; quiet path takes one pass", () => {
    const items = [contextItem("b", 20), contextItem("a", 20)];
    const input = new Map(items.map((item) => [item.id, item]));
    const incumbent: Incumbent = { rendered: new Map(), totalTokens: 0, blockCount: 0 };
    const first = solve(input, incumbent, roomyParams(), 1);
    const second = solve(input, incumbent, roomyParams(), 1);
    expect(second.placements).toEqual(first.placements);
    expect(first).toMatchObject({
      selectionPasses: 1, movePasses: 1, capped: false, acceptedMoves: 0, reversals: 0, moveThrash: false,
    });
  });

  test("move alternation is hard-capped", () => {
    const items: ContextItem[] = [];
    const order: string[] = [];
    for (let i = 0; i < 7; i++) {
      const base = contextItem(`base-${i}`, 10, { parentId: `file:${i}`, ordinal: 0, role: "base" });
      const spacer = contextItem(`spacer-${i}`, 10);
      const delta = contextItem(`delta-${i}`, 10, {
        parentId: `file:${i}`, ordinal: 1, role: "delta", placement: "fuse", migrationCreditTokens: 1_000,
      });
      items.push(base, spacer, delta);
      order.push(base.id, spacer.id, delta.id);
    }
    const result = solve(new Map(items.map((item) => [item.id, item])), incumbentFor(items, order), roomyParams(), 1);
    expect(result).toMatchObject({ movePasses: 5, capped: true, acceptedMoves: 5 });
  });

  test("opposite accepted move is a reversal and emits move-thrash", () => {
    const base = contextItem("base", 10, { parentId: "file:a", ordinal: 0, role: "base" });
    const middle = contextItem("middle", 10);
    const delta = contextItem("delta", 10, {
      parentId: "file:a", ordinal: 1, role: "delta", placement: "fuse", migrationCreditTokens: 100,
    });
    const items = [base, middle, delta];
    const incumbent = incumbentFor(items, ["base", "middle", "delta"]);
    incumbent.previousMoves = new Map([["delta", { fromPosition: 2, toPosition: 3 }]]);
    const result = solve(new Map(items.map((item) => [item.id, item])), incumbent, roomyParams(), 1);
    expect(result).toMatchObject({ acceptedMoves: 1, reversals: 1, moveThrash: true });
  });
});

describe("billing and dual-axis TTL", () => {
  test("billing helpers round to provider quanta at breakpoints", () => {
    expect(billingQuanta(1025, 1024)).toBe(2);
    expect(breakpointPrice(1025, 3, 1024)).toBeCloseTo(6.144);
  });

  test("wall-clock TTL wins when snapshots carry wall time", () => {
    const params = { ...paramSetV1("ttl").cache, ttlTurns: 99, ttlMs: 100 };
    const cache = new CacheModel(params);
    const block: Block = { digest: "d", tokens: 10, text: "x", itemId: "x", zone: "stable" };
    cache.update([block], 1_000);
    expect(cache.expectedHit([block], 1_100).hitTokens).toBe(10);
    expect(cache.expectedHit([block], 1_101).hitTokens).toBe(0);
  });

  test("turn TTL remains the fallback without wall-clock snapshots", () => {
    const params = { ...paramSetV1("ttl").cache, ttlTurns: 0, ttlMs: 100 };
    const cache = new CacheModel(params);
    const block: Block = { digest: "d", tokens: 10, text: "x", itemId: "x", zone: "stable" };
    cache.update([block]);
    expect(cache.expectedHit([block]).hitTokens).toBe(10);
  });
});
