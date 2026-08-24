import { describe, expect, test } from "bun:test";
import { blockDigest, paramSetV1, solve, ZONE_ORDER } from "../src/index.ts";
import type { ContextItem, Incumbent, ParamSet, RenderOption, SequencePosition, Zone } from "../src/index.ts";
import { normalizeSequenceOrder, planSequenceMoves, type PositionEntry } from "../src/sequence-position.ts";

function pe(id: string, seq: SequencePosition | undefined, tokens = 10, zone: Zone = "evolving", itemSeq?: SequencePosition | undefined): PositionEntry {
  const option: RenderOption = {
    id: "full", purelyAdditive: true, zones: [zone], representation: "AS_IS",
    tokens, text: id + ":" + "x".repeat(tokens),
    ...(seq === undefined ? {} : { sequence: seq }),
  };
  return {
    item: {
      id, kind: "reference", immutable: false, tokens,
      serialize: () => option.text, options: () => [option],
      lastTouchTurn: 0, createdTurn: 0,
      ...(itemSeq === undefined ? {} : { sequence: itemSeq }),
    },
    option, utility: 1,
  };
}

function rewriteItem(id: string, text: string, tokens: number): ContextItem {
  const option: RenderOption = { id: "full", purelyAdditive: false, zones: ["evolving"], representation: "AS_IS", tokens, text };
  return { id, kind: "reference", immutable: false, tokens, serialize: () => text, options: () => [option], lastTouchTurn: 0, createdTurn: 0 };
}

function ttlIncumbent(overrides: Partial<Incumbent>): Incumbent {
  return {
    rendered: new Map([
      ["a", { position: 1, zone: "evolving" as const, digest: blockDigest("old-a"), representation: "AS_IS" as const, optionId: "full" }],
      ["b", { position: 2, zone: "evolving" as const, digest: blockDigest("same-b"), representation: "AS_IS" as const, optionId: "full" }],
    ]),
    totalTokens: 300, blockCount: 2, blockMass: [100, 200], blockWriteTurns: [0, 0],
    ...overrides,
  };
}

function ttlParams(): ParamSet {
  const p = paramSetV1("ttl-fix");
  p.budgetLambda = 100_000; p.reservationPrice = 0; p.hysteresisMargin = 0;
  p.cache.ttlTurns = 1; p.cache.ttlMs = 100;
  return p;
}

describe("phase-3 review major fixes", () => {
  test("MAJOR-2: cascade — sixth pending move after pass five reports capped", () => {
    const entries: PositionEntry[] = [];
    for (let i = 0; i < 6; i++) entries.push(pe(`b${i}`, { parentId: `p${i}`, ordinal: 0, role: "base" }));
    entries.push(pe("spacer", undefined));
    for (let i = 0; i < 6; i++) {
      entries.push(pe(`d${i}`, { parentId: `p${i}`, ordinal: 1, role: "delta", placement: "fuse", migrationCreditTokens: 60 - i * 10 }));
    }
    const ledgers: import("../src/index.ts").ItemLedger[] = [];
    const first = planSequenceMoves(entries, ledgers, 1, undefined);
    expect(first.acceptedMoves).toBe(5);
    expect(first.capped).toBe(true);
    const second = planSequenceMoves(entries, ledgers, 1, undefined);
    expect(second.acceptedMoves).toBe(1);
    expect(second.capped).toBe(false);
  });

  test("MAJOR-3: cross-zone repair keeps every value in its own zone's slots", () => {
    const entries = [
      pe("delta", { parentId: "p", ordinal: 1, role: "delta", predecessorId: "base" }, 10, "foundational"),
      pe("base", { parentId: "p", ordinal: 0, role: "base" }, 10, "evolving"),
    ];
    normalizeSequenceOrder(entries, (e) => e.option.zones[0]!);
    const zoneIdx = entries.map((e) => ZONE_ORDER.indexOf(e.option.zones[0]!));
    for (let i = 1; i < zoneIdx.length; i++) expect(zoneIdx[i]).toBeGreaterThanOrEqual(zoneIdx[i - 1]!);
    expect(entries.map((e) => e.item.id)).toEqual(["delta", "base"]);
  });

  test("MAJOR-3 companion: same-zone explicit precedence still honored", () => {
    const entries = [
      pe("d2", { parentId: "p", ordinal: 2, role: "delta" }, 10, "stable"),
      pe("d1", { parentId: "p", ordinal: 1, role: "delta", predecessorId: "d0" }, 10, "stable"),
      pe("d0", { parentId: "p", ordinal: 0, role: "base" }, 10, "stable"),
    ];
    normalizeSequenceOrder(entries, (e) => e.option.zones[0]!);
    expect(entries.map((e) => e.item.id)).toEqual(["d0", "d1", "d2"]);
  });

  test("MAJOR-4: partial wall array does not suppress expired-turn suffix collapse", () => {
    const a = rewriteItem("a", "new-a", 100);
    const b = rewriteItem("b", "same-b", 200);
    const items = new Map([["a", a], ["b", b]]);
    const ps = ttlParams();
    const cost = (r: ReturnType<typeof solve>): number =>
      r.itemLedgers.find((l) => l.id === "a" && l.optionChosen === "full")!.utility.cacheCost;
    const noWall = solve(items, ttlIncumbent({}), ps, 10, 1000);
    const partialWall = solve(items, ttlIncumbent({ blockWriteWallTimeMs: [0, undefined] }), ps, 10, 1000);
    expect(cost(noWall)).toBeCloseTo(0.3, 10);
    expect(cost(partialWall)).toBeCloseTo(0.3, 10);
  });

  test("MINOR-1 coverage: option sequence metadata overrides item metadata", () => {
    const base = pe("base", { parentId: "p", ordinal: 0, role: "base" });
    const spacer = pe("spacer", undefined);
    const fuseOnOption = pe("d", { parentId: "p", ordinal: 1, role: "delta", placement: "fuse", migrationCreditTokens: 100 }, 10, "evolving",
      { parentId: "p", ordinal: 1, role: "delta", placement: "tail" });
    const ledgersA: import("../src/index.ts").ItemLedger[] = [];
    const r1 = planSequenceMoves([base, spacer, fuseOnOption], ledgersA, 1, undefined);
    expect(r1.acceptedMoves).toBe(1);
    const tailOnly = pe("d2", undefined, 10, "evolving",
      { parentId: "q", ordinal: 1, role: "delta", placement: "tail" });
    const base2 = pe("base2", { parentId: "q", ordinal: 0, role: "base" });
    const ledgersB: import("../src/index.ts").ItemLedger[] = [];
    const r2 = planSequenceMoves([base2, spacer, tailOnly], ledgersB, 1, undefined);
    expect(r2.acceptedMoves).toBe(0);
  });

  test("MAJOR-1: bucketed normalization holds invariants and calls zoneOf O(n) times at scale", () => {
    const entries: PositionEntry[] = [];
    const zones: Zone[] = ["identity", "foundational", "stable", "evolving"];
    let n = 0;
    for (let f = 0; f < 300; f++) {
      entries.push(pe(`b${n++}`, { parentId: `p${f}`, ordinal: 0, role: "base" }, 5, zones[f % 4]!));
      for (let d = 1; d <= 4; d++) entries.push(pe(`d${n++}`, { parentId: `p${f}`, ordinal: d, role: "delta" }, 3, zones[(f + d) % 4]!));
      entries.push(pe(`s${n++}`, undefined, 7, zones[(f + 2) % 4]!));
    }
    const idsBefore = new Set(entries.map((e) => e.item.id));
    let zoneCalls = 0;
    const e_zone = (e: PositionEntry): Zone => e.option.zones[0] ?? "evolving";
    // Solver stage 2 hands normalize a zone-sorted layout; mimic it here.
    const zorder = (z: Zone): number => ZONE_ORDER.indexOf(z);
    entries.sort((a, b) => zorder(e_zone(a)) - zorder(e_zone(b)));
    normalizeSequenceOrder(entries, (e) => { zoneCalls += 1; return e_zone(e); });
    expect(new Set(entries.map((e) => e.item.id))).toEqual(idsBefore);
    const zoneIdx = entries.map((e) => zorder(e_zone(e)));
    for (let i = 1; i < zoneIdx.length; i++) expect(zoneIdx[i]).toBeGreaterThanOrEqual(zoneIdx[i - 1]!);
    // Quadratic repair probes zoneOf Θ(n·d) ≈ 675k times at n=2100; the
    // bucketed pass probes exactly n. Pin the complexity class, not the clock.
    expect(zoneCalls).toBeLessThanOrEqual(entries.length * 4);
  });
});
