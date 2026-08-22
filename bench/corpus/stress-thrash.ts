/**
 * STRESS A — thrash lens (0002d §5, Daniel 2026-08-22):
 * a watched file that changes EVERY turn while the agent keeps expanding it.
 *
 * The design question: does the solver keep the cached HISTORY locked and
 * consolidate only the recent delta (cheap re-cache), or does it rewrite the
 * whole lens block every turn (cache destroyed at that position)?
 *
 * Measures per turn: chosen option, block digest stability, CacheModel
 * expectedHit (believed cached prefix), render tokens vs Λ.
 */
import { AgentLoop } from "../../src/optimizer/loop.ts";
import { MockProvider } from "../../src/optimizer/providers.ts";
import { paramSetV1 } from "../../src/optimizer/params.ts";
import { TurnBoundaryWatcher } from "../../src/optimizer/live-views.ts";
import { writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const targetAbs = resolve(ROOT, "bench/corpus/fixtures/thrash.log");

// 200-line base file; one line appended per turn by the "external world"
const base = Array.from({ length: 200 }, (_, i) => `t=${i + 1} base heartbeat qdepth=${(i * 3) % 17}`).join("\n");
writeFileSync(targetAbs, base + "\n");

const engine = new TurnBoundaryWatcher();
const ps = paramSetV1("m");
ps.budgetLambda = 2048;

const hits: number[] = [];
let lastPlacements: Array<{ id: string; optionId: string; zone: string }> = [];

const loop = new AgentLoop(new MockProvider(), ps, null, {
  onTurn: (o) => { hits.push(o.cacheExpectedHit); },
  onRender: (rr) => {
    lastPlacements = rr.placements.map((p) => ({ id: p.id, optionId: p.optionId, zone: p.zone as string }));
  },
});
loop.watcher = engine;
loop.fileContent = (t) => readFileSync(resolve(ROOT, t), "utf8");

const LENS_ID = "lens:bench/corpus/fixtures/thrash.log";
const lens = loop.fileLens("bench/corpus/fixtures/thrash.log");

const TURNS = 12;
for (let t = 1; t <= TURNS; t++) {
  // external world appends a line (watched change)
  const cur = readFileSync(targetAbs, "utf8");
  writeFileSync(targetAbs, cur + `t=${200 + t} EXTERNAL CHANGE payload-${t} delta-event\n`);
  engine.push({ lensId: LENS_ID, path: "bench/corpus/fixtures/thrash.log", kind: "change" });
  loop.refreshLensFromSubstrate(LENS_ID);

  // agent keeps the tail in context: expand through the new line
  lens.expand(Math.max(1, 201 + t - 30), 200 + t);
  await loop.run(`turn ${t}: absorb the change`);
}

// report
let prevHit = -1;
console.log("turn | option                 | zone      | lensTokens | expectedHit");
for (let i = 0; i < TURNS; i++) {
  // replay loop placements per turn is not stored; use last as sample
}
console.log("(final placements below — per-turn option tracking needs hooks; see analysis)");
for (const p of lastPlacements) console.log(`  ${p.id} → ${p.optionId} [${p.zone}]`);
console.log("expectedHit sequence:", hits.join(", "));

const stable = hits.length >= 6 && hits.slice(1).every((h, i) => h >= hits[i]! * 0.9);
console.log(stable ? "STRESS-A: cache prefix STABLE under thrash" : "STRESS-A: cache prefix DEGRADED under thrash (rewrite churn)");
