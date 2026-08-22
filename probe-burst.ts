// A/B probe v2: 5-delta burst (one delta event per turn, t3..t7) then quiet.
//   ARM A (publish-then-consolidate-at-quiescence): solver picks freely over
//     the full lattice each turn; commit consumes ONLY on fusion picks, so
//     the chain stays open through the burst; fusion happens when the solver
//     prefers it (typically at/after the first quiet turn).
//   ARM B (consolidate-at-each-step): during the burst the surface is
//     restricted to the fusion option (base+(d1..dk) latest-wins re-derivation
//     + compact header); each pick re-banks the base, journal resets. After 5
//     forced fusions there is nothing left to consolidate at quiescence.
// Both arms pay real solve() pricing with the incumbent threaded turn-to-turn;
// realized cache cost uses the kernel's transactionCost economics
// (keep=0 / chain-append=cached write / rewrite=uncached + suffix reprice).
import { FileLensItem } from "./src/optimizer/lens.ts";
import { StandingItem } from "./src/optimizer/items.ts";
import { ContextStore } from "./src/optimizer/store.ts";
import { solve } from "./src/optimizer/solver.ts";
import { paramSetV1 } from "./src/optimizer/params.ts";

const LINES = 100;
const base = Array.from({ length: LINES }, (_, i) => `line ${i + 1} ${"x".repeat(30)}`).join("\n");
// five delta events, one per turn, disjoint regions
const deltaEvents: number[][] = [[10], [25, 26], [40], [55, 56, 57], [70]];

function freshLens(): FileLensItem {
  const lens = new FileLensItem("lens:probe.ts", "probe.ts", base);
  lens.expand(1, LINES);
  lens.valueBump = { amount: 8, untilTurn: 99 };
  return lens;
}

interface TurnRec { turn: number; option: string; tokens: number; cost: number }

function runArm(mode: "free" | "force-fusion", label: string) {
  const lens = freshLens();
  const store = new ContextStore();
  store.add(new StandingItem("identity", "identity", "id").toContextItem());

  let incumbent: {
    rendered: Map<string, { position: number; zone: string; digest: string; representation: string; optionId: string }>;
    totalTokens: number; blockCount: number;
  } = { rendered: new Map(), totalTokens: 0, blockCount: 0 };

  const recs: TurnRec[] = [];
  let prevLensDigest = "";
  let prevLensPos = 0;
  let prevBlockCount = 0;
  const ps = paramSetV1("m");
  const CU = ps.cache.pricePer1kUncached, CC = ps.cache.pricePer1kCached;

  for (let turn = 2; turn <= 9; turn++) {
    if (turn >= 3 && turn <= 7) lens.noteLiveDelta(turn, deltaEvents[turn - 3]!);  // ONE event per turn

    const items = new Map(store.snapshot());
    const fresh = lens.toContextItem();
    let lensItem = fresh;
    if (mode === "force-fusion" && turn >= 3 && turn <= 7 && lens.pendingDeltas.length > 0) {
      // Arm B policy: during the burst only fusion-class renders are offered
      lensItem = { ...fresh, options: () => fresh.options().filter((o) => o.id.startsWith("base+(")) } as never;
    }
    items.set("lens:probe.ts", lensItem);

    const res = solve(items, incumbent as never, ps as never, turn);
    const lensPlace = res.placements.find((p) => p.id === "lens:probe.ts");
    if (lensPlace === undefined) { recs.push({ turn, option: "(not placed)", tokens: 0, cost: 0 }); continue; }

    const curDigest = lensPlace.digest;
    let cost = 0;
    if (curDigest === prevLensDigest) cost = 0;                                   // keep
    else if (lensPlace.optionId.startsWith("base+") && !lensPlace.optionId.includes("(")) {
      cost = lensPlace.tokens / 1000 * CC;                                        // chain append
    } else {
      cost = lensPlace.tokens / 1000 * CU;                                        // rewrite (own bytes)
      const blocksAfter = Math.max(0, prevBlockCount - prevLensPos);              // + suffix reprice
      if (prevBlockCount > 0) {
        const suffixTokens = incumbent.totalTokens * (blocksAfter / Math.max(1, prevBlockCount));
        cost += suffixTokens / 1000 * (CU - CC);
      }
    }
    recs.push({ turn, option: lensPlace.optionId, tokens: lensPlace.tokens, cost });

    prevLensDigest = curDigest;
    prevLensPos = lensPlace.position;
    prevBlockCount = res.placements.length;
    incumbent = {
      rendered: new Map(res.placements.map((p) => [p.id, { position: p.position, zone: p.zone, digest: p.digest, representation: p.representation, optionId: p.optionId }])),
      totalTokens: res.placements.reduce((s, p) => s + p.tokens, 0),
      blockCount: res.placements.length,
    };

    lens.commitConsolidation(lensPlace.optionId, turn);   // consumes only on fusion/full
  }
  const sumTokens = recs.reduce((s, r) => s + r.tokens, 0);
  const sumCost = +recs.reduce((s, r) => s + r.cost, 0).toFixed(5);
  console.log(`── ${label} ──`);
  for (const r of recs) console.log(`  t${r.turn} ${r.option.padEnd(30)} ${String(r.tokens).padStart(5)}t  $${r.cost.toFixed(5)}`);
  console.log(`  totals: ${sumTokens}t rendered, $${sumCost.toFixed(5)} realized cache cost`);
  return { recs, sumTokens, sumCost };
}

const armA = runArm("free", "ARM A — publish deltas through burst, consolidate when solver prefers (quiescence)");
const armB = runArm("force-fusion", "ARM B — fuse at each step (forced fusion x5, journal reset each turn)");
console.log(`\nverdict: A $${armA.sumCost.toFixed(5)} / ${armA.sumTokens}t  vs  B $${armB.sumCost.toFixed(5)} / ${armB.sumTokens}t`);
