// Relief-DP bench: exact-MCKP budget relief across window scales.
//
// MEASURED WALLS (2026-08-24, M4 Max, vendored knapsack @ d71e00b lineage;
// lib-level benches through solve() with DP engagement verified via
// stats.dpCellsVisited > 0):
//
//   300 groups / cap 30k (tied profits):    27.6 ms   8.6M cells   (back-pointer)
//   2000 groups / cap 200k (tied):          1.68 s  611M cells   (divide-and-conquer)
//   10000 groups / cap 1M (tied):          41.98 s   15.2B cells (divide-and-conquer)
//   10000 groups / cap 1M (fresh items through stowage solve(), instrumented
//     by reviewer counterfactual):         ~37 s     7.6–12.9B cells
//
// The wall is NOT confined to tied geometry: genuinely over-budget fresh
// content at full-window scale hits it too (reviewer counterfactual, PR #3).
// LANDED ANSWER (perf item 1): bounded relief mode. Above the 50 MiB DP
// budget the vendor returns the certified integral greedy incumbent with
// honest [greedyLower, lpUpper] bounds (status "bounded", never "optimal")
// — measured ~1.6s at 10k groups / 900k capacity vs 37-42s exact. Below
// the budget, behavior is byte-identical to exact. Quantization (Q-token
// weight snapping) remains the documented path if the certified interval
// ever needs tightening toward true OPT.
// The runs below exercise the CURRENT (pre-quantization) exact path —
// the win-4k / win-30k lines engage the DP (85k / 4.7M cells); the win-1M
// line does NOT fire relief under stale-item phase-1 rejection and is kept
// only as the phase-1-fast-path baseline.
//
// Run: bun bench/relief-dp.ts
import { solve, paramSetV1 } from "../src/index.ts";
import type { ContextItem } from "../src/index.ts";

function build(nItems: number, itemTokens: number) {
  const items = new Map<string, ContextItem>();
  for (let i = 0; i < nItems; i++) {
    const options = [
      { id: "full", purelyAdditive: true, zones: ["evolving"], representation: "AS_IS", tokens: itemTokens, text: `i${i}` },
      { id: "trim", purelyAdditive: false, zones: ["evolving"], representation: "AS_IS", tokens: Math.floor(itemTokens * 0.7), text: `i${i}t` },
    ];
    items.set(`i${i}`, { id: `i${i}`, kind: "reference", immutable: false, tokens: itemTokens, serialize: () => `i${i}`, options: () => options, lastTouchTurn: 0, createdTurn: 0 } as unknown as ContextItem);
  }
  return items;
}

function run(label: string, nItems: number, itemTokens: number, budget: number, reps = 3) {
  const items = build(nItems, itemTokens);
  const times: number[] = [];
  for (let r = 0; r < reps; r++) {
    const ps = paramSetV1(label);
    ps.budgetLambda = budget;
    ps.cache.ttlTurns = 4; ps.cache.ttlMs = undefined as unknown as number;
    const t0 = performance.now();
    solve(items, { rendered: new Map(), totalTokens: 0, blockCount: 0 }, ps, 12, 1000);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  console.log(`${label}: n=${nItems} tok/item=${itemTokens} budget=${budget} -> min ${times[0]!.toFixed(1)} ms / med ${times[Math.floor(reps / 2)]!.toFixed(1)} ms`);
}

run("win-4k  ", 40, 150, 4_000);
run("win-30k ", 300, 150, 30_000);
run("win-200k", 500, 500, 200_000);
run("win-1M  ", 1000, 1000, 1_000_000);
