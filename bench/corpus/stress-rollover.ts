/**
 * STRESS B — rollover ordering (no mutation, pure conversation growth).
 * Isolates: does the 9→10 turn rollover reorder evolving-zone blocks
 * (lexicographic id sort) and destroy the cache prefix — independent of
 * any lens behavior?
 */
import { AgentLoop } from "../../src/optimizer/loop.ts";
import { MockProvider } from "../../src/optimizer/providers.ts";
import { paramSetV1 } from "../../src/optimizer/params.ts";

const ps = paramSetV1("m");
ps.budgetLambda = 2048;
const hits: number[] = [];
const loop = new AgentLoop(new MockProvider(), ps, null, {
  onTurn: (o) => { hits.push(o.cacheExpectedHit); },
});
for (let t = 1; t <= 14; t++) await loop.run(`question ${t}`);
console.log("expectedHit by turn:", hits.join(", "));
const t9 = hits[8] ?? 0, t10 = hits[9] ?? 0, t11 = hits[10] ?? 0;
console.log(`turn 9 hit=${t9}t → turn 10 hit=${t10}t → turn 11 hit=${t11}t`);
if (t9 > 0 && t10 < t9 * 0.5) console.log("STRESS-B: CACHE CLIFF at 9→10 rollover (block reorder)");
else console.log("STRESS-B: no rollover cliff");
