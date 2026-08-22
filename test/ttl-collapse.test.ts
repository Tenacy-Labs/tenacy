/**
 * ADR-0006 §4 (phase 3) — TTL-expiry collapse, END-TO-END through the solver.
 *
 * The semantics live in transactionCost (L637-642): a rewrite in place
 * pays own-uncached + suffix re-bill at the spread — UNLESS the suffix's
 * blocks are all already TTL-expired (blockWriteTurns older than
 * ttlTurns), in which case the suffix collapses to zero (free
 * restructure: the provider would expire those bytes anyway).
 *
 * Discriminating pair: identical items, identical positions, only the
 * incumbent's blockWriteTurns differ (cold vs. warm suffix). The cold
 * side must price strictly cheaper. Items are hand-built so the chosen
 * option is NON-additive (NoticeItem's only option is purelyAdditive,
 * which never reaches the rewrite path).
 */
import { describe, test, expect } from "bun:test";
import { solve } from "../src/optimizer/solver.ts";
import { paramSetV1 } from "../src/optimizer/params.ts";
import type { ContextItem, RenderOption } from "../src/optimizer/types.ts";

function item(id: string, text: string, tokens: number): ContextItem {
  const o: RenderOption = {
    id: "as-is", purelyAdditive: false, zones: ["foundational"],
    representation: "AS_IS", tokens, text,
  };
  return {
    id, kind: "notice", immutable: false, tokens,
    serialize: () => text, options: () => [o], upstreams: [],
    lastTouchTurn: 1, createdTurn: 1, watch: "frozen",
  };
}

describe("ADR-0006 §4 TTL-expiry collapse (end-to-end)", () => {
  test("cold suffix restructure is free; warm suffix pays the re-bill", () => {
    const ps = paramSetV1("test-model");
    const run = (blockWriteTurns: number[]) => {
      const items = new Map<string, ContextItem>();
      items.set("a", item("a", "AAAA cold head block rewritten in place", 10));
      items.set("b", item("b", "BBBB suffix block that only pays if warm", 15));
      const incumbent = {
        rendered: new Map([
          ["a", { position: 1, zone: "foundational", digest: "dA0", representation: "AS_IS", optionId: "as-is" }],
          ["b", { position: 2, zone: "foundational", digest: "dB0", representation: "AS_IS", optionId: "as-is" }],
        ]),
        totalTokens: 25,
        blockCount: 2,
        blockMass: [10, 15],
        blockWriteTurns,
      };
      const res = solve(items, incumbent as never, ps, 60);
      const aLedger = res.itemLedgers.find((l) => l.id === "a");
      if (aLedger === undefined) throw new Error("no ledger row for a");
      return aLedger.utility.cacheCost;
    };
    // ttlTurns=6 in paramSetV1. Cold: suffix block written t1 (59 turns
    // stale). Warm: written t59 (1 turn stale). Item a rewrites at
    // position 1 → its suffix (block 2) is billed only when warm.
    const coldCost = run([1, 1]);
    const warmCost = run([59, 59]);
    // Total collapse: cold = own uncached write only (no suffix term).
    const ownWrite = (10 / 1000) * ps.cache.pricePer1kUncached;
    expect(Math.abs(coldCost - ownWrite)).toBeLessThan(1e-9);
    // Warm = own + suffix (15t) at the spread — strictly dearer.
    const suffixTerm = (15 / 1000) * (ps.cache.pricePer1kUncached - ps.cache.pricePer1kCached);
    expect(Math.abs(warmCost - (ownWrite + suffixTerm))).toBeLessThan(1e-9);
  });
});
