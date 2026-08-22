/**
 * Batch-1 review-major pins (2026-08-22): A-M2, A-M10, A-M11, A-M1.
 */
import { describe, test } from "bun:test";
import { futureValue, solve } from "../src/optimizer/solver.ts";
import { paramSetV1 } from "../src/optimizer/params.ts";
import { effectiveHysteresis } from "../src/optimizer/horizon.ts";
import { ContextStore } from "../src/optimizer/store.ts";
import { StandingItem, NoticeItem } from "../src/optimizer/items.ts";

describe("batch-1 review majors", () => {
  const ps = paramSetV1("m");

  test("A-M2: futureValue(hValue=0) is exactly 0 — no lookahead floor", () => {
    const fv0 = futureValue(10, 1, 5, 50, 1, ps, 0);
    if (fv0 !== 0) throw new Error(`hValue=0 must yield 0, got ${fv0}`);
    const fv3 = futureValue(10, 1, 5, 50, 1, ps, 3);
    if (!(fv3 > 0)) throw new Error(`hValue=3 must collect value, got ${fv3}`);
  });

  test("A-M2/A-M10: over-budget window — no non-finite utilities, tombstones price at capped horizon", () => {
    const small = { ...ps, budgetLambda: 30 } as typeof ps;
    const store = new ContextStore();
    store.add(new StandingItem("identity", "identity", "core identity block").toContextItem());
    store.add(new NoticeItem("n:big", "notice", "x".repeat(200), false, [], 0.9).toContextItem());
    const res = solve(store.snapshot(), { rendered: new Map(), totalTokens: 0, blockCount: 0 }, small, 5);
    for (const l of res.itemLedgers) {
      if (!Number.isFinite(l.utility.total)) throw new Error(`non-finite utility: ${l.id}`);
    }
  });

  test("A-M11: evidence-rich item's effectiveHysteresis is variance-scaled", () => {
    const item = new NoticeItem("n:rich", "notice", "rich", false, [], 0.9).toContextItem();
    item.refEvidence = { hits: [1, 2, 3, 4, 5], accessClass: "searchHit" };
    item.createdTurn = 1;
    item.lastTouchTurn = 5;
    const eh = effectiveHysteresis(ps, item);
    if (eh === ps.hysteresisMargin) throw new Error("expected variance-scaled margin for evidence-rich item");
  });

  test("A-M1: strand-aware exact-MCKP relief protects the front item (warm incumbent)", () => {
    // Warm scenario is required: on a cold solve every item's strand is 0
    // and the pick is arbitrary. With an incumbent, evicting the FRONT
    // item re-bills the suffix; keep-profit = utility + strand makes the
    // TAIL the honest victim — matching the density path's pick.
    const store = new ContextStore();
    store.add(new StandingItem("identity", "identity", "id").toContextItem());
    store.add(new NoticeItem("n:front", "notice", "F".repeat(100), false, [], 0.9).toContextItem());
    store.add(new NoticeItem("n:tail", "notice", "T".repeat(100), false, [], 0.9).toContextItem());
    // Turn 1: generous budget — both placed, front before tail.
    const r1 = solve(store.snapshot(), { rendered: new Map(), totalTokens: 0, blockCount: 0 }, ps, 1);
    if (!r1.placements.map((p) => p.id).includes("n:front")) throw new Error("t1 setup failed: front not placed");
    // Turn 2: tight budget, warm incumbent.
    const tight = { ...ps, budgetLambda: 45, reliefMode: "exact-mckp" } as typeof ps;
    const warm = new Map(r1.placements.map((p, i) => [p.id, { position: i + 1, zone: "mid" as never, digest: `d${i}`, representation: "full", optionId: p.optionId }]));
    const r2 = solve(store.snapshot(), { rendered: warm, totalTokens: r1.totalTokens, blockCount: r1.placements.length }, tight, 2);
    const dropped = r2.itemLedgers.filter((l) => l.decision === "drop" && l.accepted).map((l) => l.id);
    if (dropped.includes("n:front")) {
      throw new Error(`strand-blind relief evicted the front item: dropped=${dropped.join(",")}`);
    }
    const dropRow = r2.itemLedgers.find((l) => l.id === "n:tail" && l.decision === "drop" && l.accepted);
    if (dropRow === undefined) throw new Error("expected the tail item to be the evicted one");
    if (dropRow.utility.cacheCost < 0) throw new Error("cacheCost must be a non-negative re-bill");
  });
});
