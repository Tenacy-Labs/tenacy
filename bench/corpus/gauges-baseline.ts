/**
 * ADR-0006 §7 baseline gauges — run the pressure-corpus workload with the
 * ledger on, then report the five gauges against the CURRENT solver.
 * These numbers are the falsification baseline: phases 1-3 must move them.
 *
 * Usage: bun bench/corpus/gauges-baseline.ts
 */
import { AgentLoop } from "../../src/optimizer/loop.ts";
import { MockProvider } from "../../src/optimizer/providers.ts";
import { TurnBoundaryWatcher } from "../../src/optimizer/live-views.ts";
import { executeIntent, type SteeringIntent } from "../../src/optimizer/intents.ts";
import { paramSetV1 } from "../../src/optimizer/params.ts";
import { StandingItem } from "../../src/optimizer/items.ts";
import { INTENT_PROTOCOL_DOC } from "../../src/optimizer/live.ts";
import { Ledger } from "../../src/optimizer/ledger.ts";
import { loadCorpus } from "../../src/optimizer/corpus.ts";
import { reportGauges } from "../../src/optimizer/reports.ts";
import { loadHarnessConfig, paramSetFor } from "../../src/optimizer/harness-config.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const SPEC = JSON.parse(readFileSync(resolve(import.meta.dir, "scenarios.json"), "utf8")) as Record<string, { script?: string[]; steps?: Array<{ msg?: string; intent?: unknown }> }>;

async function main(): Promise<void> {
  const scenarioNames = process.argv[2] !== undefined ? [process.argv[2]] : ["s3-chunked-read"];
  const ledgerPath = "/tmp/agent-kernel-gauges-baseline.jsonl";
  try { writeFileSync(ledgerPath, ""); } catch { /* fresh */ }
  const ledger = new Ledger(ledgerPath);

  // Budget pressure: the corpus reference configuration (Λ=2048).
  const cfg = loadHarnessConfig();
  const ps = { ...paramSetFor("glm-5.2", cfg), budgetLambda: 2048 };

  for (const name of scenarioNames) {
    const spec = SPEC[name];
    if (spec === undefined) throw new Error(`unknown scenario ${name}`);
    const engine = new TurnBoundaryWatcher();
    const loop = new AgentLoop(new MockProvider(), ps, ledger, {
      onRender: (_rr): void => undefined,
    });
    loop.watcher = engine;
    loop.fileContent = (t) => { try { return readFileSync(resolve(ROOT, t), "utf8"); } catch { return ""; } };
    loop.dirListing = (t) => { try { return readFileSync(resolve(ROOT, t), "utf8"); } catch { return ""; } };
    loop.store.add(new StandingItem("identity", "identity",
      "You are running the agent-kernel pressure corpus. " + INTENT_PROTOCOL_DOC +
      " Work under a tight token budget: expand only the ranges you need, distill what matters into your replies, release ranges when done.").toContextItem());

    const steps = spec.script ?? [];
    for (const line of steps) {
      if (line.startsWith("say ")) continue;
      const intent = JSON.parse(line) as SteeringIntent;
      executeIntent(intent, loop.store, ledger);
      await loop.run(line);
    }
  }

  await ledger.drain();
  const corpus = await loadCorpus([ledgerPath], "realized");
  const g = reportGauges(corpus, ps);
  console.log("── ADR-0006 §7 baseline gauges (current solver, pre-§2) ──");
  console.log(JSON.stringify({
    scenario: scenarioNames.join("+"),
    turns: g.turns,
    flipsPer100: round(g.flipsPer100),
    reExpansionsPerEviction: g.reExpansionsPerEviction === null ? null : round(g.reExpansionsPerEviction),
    believedHitRatio: g.believedHitRatio === null ? null : round(g.believedHitRatio),
    deadTokenShare: g.deadTokenShare === null ? null : round(g.deadTokenShare),
    writeToHarvest: g.writeToHarvest === null ? null : round(g.writeToHarvest),
    harvestBasis: g.harvestBasis,
    raw: { flips: g.flips, evictions: g.evictions, reExpansions: g.reExpansions, restructures: g.restructures },
  }, null, 2));
}

function round(x: number): number { return Math.round(x * 10000) / 10000; }

await main();
