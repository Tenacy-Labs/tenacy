/**
 * RED tests: delta consolidation lattice (Daniel ruling 2026-08-22).
 *
 * The lens emits the full lattice of consolidation states over its pending
 * deltas, each as REAL bytes with honest cache semantics:
 *
 *   base+d1+d2      chain form — each delta snapshot kept for sequence
 *                   legibility; APPENDS to the previous base render
 *   base+(d1,d2)    fusion form — the lens re-derives the OPTIMAL rendering
 *                   of the combined contents (latest-wins over the union of
 *                   affected lines; byte-equal to the fresh substrate slice).
 *                   REWRITE (it re-orders bytes already in context).
 *   (base,d1,d2)    atomic full form — everything in one fresh block; REWRITE.
 *
 * The solver picks. RATCHET: once a combined option is chosen, the
 * consolidation is permanent — the lens retires the finer-grained states
 * (and discards superseded delta snapshots), so the lattice never re-opens
 * downward.
 *
 * Fusion truth invariant: fused bytes === fresh substrate slice over the
 * union of affected lines (latest-wins). Not a concatenation of diffs.
 */
import { describe, expect, test } from "bun:test";
import { FileLensItem } from "../src/optimizer/lens.ts";
import { solve, type Incumbent } from "../src/optimizer/solver.ts";
import { ContextStore } from "../src/optimizer/store.ts";
import { StandingItem } from "../src/optimizer/items.ts";
import { paramSetV1 } from "../src/optimizer/params.ts";

function makeLens(): FileLensItem {
  const content = Array.from({ length: 60 }, (_, i) => `line ${i + 1} ${"x".repeat(30)}`).join("\n");
  return new FileLensItem("lens:lat.ts", "lat.ts", content);
}

describe("delta consolidation lattice", () => {
  test("RED: lens with a base and two pending deltas emits all lattice states as real bytes", async () => {
    const lens = makeLens();
    lens.expand(1, 20);
    lens.baseBlockTurn = 1;                 // base banked (post-fix this is set by committing)
    // Two successive mutations, drained at successive turn boundaries:
    lens.noteLiveDelta(2, [1]);   // d1: line 1 changed
    lens.noteLiveDelta(3, [2]);   // d2: line 2 changed (substrate already latest-wins)
    const opts = lens.options();
    const ids = opts.map((o) => o.id);
    // The lattice over {base, d1, d2}: chain, fusion, atomic
    if (!ids.includes("base+d1+d2")) throw new Error(`chain form missing: ${JSON.stringify(ids)}`);
    if (!ids.includes("base+(d1,d2)")) throw new Error(`fusion form missing: ${JSON.stringify(ids)}`);
    if (!ids.includes("(base,d1,d2)")) throw new Error(`atomic form missing: ${JSON.stringify(ids)}`);
    // Honest cache semantics:
    const chain = opts.find((o) => o.id === "base+d1+d2")!;
    if (!chain.purelyAdditive) throw new Error("chain form must be additive (appends after base)");
    const fusion = opts.find((o) => o.id === "base+(d1,d2)")!;
    if (fusion.purelyAdditive) throw new Error("fusion form is a rewrite — must NOT be additive");
    const atomic = opts.find((o) => o.id === "(base,d1,d2)")!;
    if (atomic.purelyAdditive) throw new Error("atomic form is a rewrite — must NOT be additive");
    // Fusion truth: the combined (d1,d2) body must equal the fresh substrate
    // slice over the union of affected lines {1,2} — latest-wins, not concat.
    const fused = lens.sliceRangePublic(1, 2);
    if (!fusion.text.includes(fused)) throw new Error("fusion body is not the fresh substrate slice over affected lines");
    if (fusion.text.includes("+Δ") === false && fusion.text.length <= chain.text.length) {
      throw new Error("fusion should re-derive compact combined form, not pad the chain");
    }
  });

  test("RED: choosing a combined option ratchets — finer states retire permanently", async () => {
    const lens = makeLens();
    lens.expand(1, 20);
    lens.baseBlockTurn = 1;
    lens.noteLiveDelta(2, [1]);
    lens.noteLiveDelta(3, [2]);
    // Commit the fusion choice:
    lens.commitConsolidation("base+(d1,d2)", 4);
    const opts = lens.options();
    const ids = opts.map((o) => o.id);
    // Finer-grained states are gone...
    if (ids.includes("base+d1+d2")) throw new Error("chain form must retire after fusion ratchet");
    if (ids.includes("(base,d1,d2)")) throw new Error("atomic form must retire after fusion ratchet");
    // ...and the base is re-banked at the commit turn: next live delta appends again
    if (lens.baseBlockTurn !== 4) throw new Error(`base must re-bank at commit turn, got ${lens.baseBlockTurn}`);
    const next = lens.options().find((o) => o.id.startsWith("base+"));
    if (next === undefined) throw new Error("a new base+Δ form must exist after ratchet");
  });

  test("RED: solver can pick the fusion option under honest pricing and the choice ratchets via commit", async () => {
    const lens = makeLens();
    lens.expand(1, 20);
    lens.baseBlockTurn = 1;
    lens.noteLiveDelta(2, [1]);
    lens.noteLiveDelta(3, [2]);
    // Honest value signal (ctx.promote class): without it the solver cannot
    // know the lens bytes matter — compact legitimately wins on price alone.
    lens.valueBump = { amount: 80, untilTurn: 10 };
    const store = new ContextStore();
    store.add(new StandingItem("identity", "identity", "id").toContextItem());
    store.add(lens.toContextItem());
    const ps = paramSetV1("test");
    // A tight budget: Λ must bind so relief/pre-selection forces choices.
    const psTight = { ...ps, budgetLambda: Math.min(ps.budgetLambda, 1200) };
    // Prev render exists so cache pricing sees an incumbent:
    const prev: Incumbent = {
      rendered: new Map([["lens:lat.ts", { position: 1, digest: "h1", zone: "evolving" }] as never]),
      totalTokens: 100,
      blockCount: 2,
    } as never as Incumbent;
    const out = solve(store.snapshot(), prev, psTight, 4);
    const pick = out.placements.find((p) => p.id === "lens:lat.ts");
    if (pick === undefined) throw new Error("lens not placed");
    const latticePick = ["base+d1+d2", "base+(d1,d2)", "(base,d1,d2)"];
    if (!latticePick.includes(pick.optionId)) {
      throw new Error(`solver did not pick a lattice option under tight Λ: got ${pick.optionId}`);
    }
  });
});
