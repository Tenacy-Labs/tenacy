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
import type { ParamSet } from "../../src/optimizer/params.ts";
import { StandingItem } from "../../src/optimizer/items.ts";
import { TOOL_PROTOCOL_DOC } from "../../src/optimizer/tools.ts";
import { Ledger } from "../../src/optimizer/ledger.ts";
import { loadCorpus } from "../../src/optimizer/corpus.ts";
import { reportGauges, type BeliefGapInput } from "../../src/optimizer/reports.ts";
import { lcpTokens } from "./maxsuite.ts";
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
  const ps = { ...paramSetFor("glm-5.2", cfg), budgetLambda: 2048, ...(process.env.RELIEF_MODE !== undefined ? { reliefMode: process.env.RELIEF_MODE as ParamSet["reliefMode"] } : {}) };
  const renderTexts: string[] = [];          // per-turn render bytes (LCP truth)

  for (const name of scenarioNames) {
    const spec = SPEC[name];
    if (spec === undefined) throw new Error(`unknown scenario ${name}`);
    const engine = new TurnBoundaryWatcher();
    const loop = new AgentLoop(new MockProvider(), ps, ledger, {
      onRender: (rr): void => { renderTexts.push(rr.text); },
    });
    loop.watcher = engine;
    loop.fileContent = (t) => { try { return readFileSync(resolve(ROOT, t), "utf8"); } catch { return ""; } };
    loop.dirListing = (t) => { try { return readFileSync(resolve(ROOT, t), "utf8"); } catch { return ""; } };
    loop.store.add(new StandingItem("identity", "identity",
      "You are running the agent-kernel pressure corpus. " + TOOL_PROTOCOL_DOC +
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
  // LCP truth map: independent recomputation over actual render bytes —
  // supplies Gauge 6 when providers report nothing (mock corpora).
  // Alignment (2026-08-22 off-by-one fix): the turn-t cache record's
  // expected hit is the LCP of renders (t−1, t) — the chain this turn's
  // render was billed against. renderTexts[i] is the render of turn i+1,
  // so the pair (renderTexts[i−1], renderTexts[i]) belongs to turn i.
  // The old set(i+1, …) lagged one render; under monotone-append solvers
  // that hid as a constant growth-rate gap, and under oscillating relief
  // renders (exact-MCKP purge/re-expand) it blew up to ±Λ/2 swings.
  const truthByTurn = new Map<number, number>();
  renderTexts.forEach((text, i) => {
    if (i === 0) return; // no prior render: turn-0 pair does not exist
    const prev = renderTexts[i - 1]!;
    truthByTurn.set(i, lcpTokens(prev, text));
  });
  const g = reportGauges(corpus, ps, { basis: "lcp-truth", truthByTurn } satisfies BeliefGapInput);
  if (process.env.GAUGE_DEBUG !== undefined) {
    // Per-turn gap dump: truth (LCP) vs believed (digest-chain). Diffing
    // this against the raw counters localizes which turns the tombstone
    // accounting contaminates.
    for (const c of corpus.caches) {
      const truth = truthByTurn.get(c.turn);
      if (truth === undefined) continue;
      const gap = truth - c.expected.hitTokens;
      if (Math.abs(gap) > 1) {
        console.log(`turn ${c.turn}: truth ${truth}t believed ${c.expected.hitTokens}t gap ${gap >= 0 ? "+" : ""}${gap}t`);
      }
    }
    // Where does each walk break? LCP breaks at a char offset in the
    // concatenated text; the chain breaks at a block index. If the chain
    // breaks early while the LCP runs long, block-boundary alignment
    // (tombstone insertion/removal shifting block indices) is the story.
    for (let i = 1; i < renderTexts.length; i++) {
      const prev = renderTexts[i - 1]!, cur = renderTexts[i]!;
      let j = 0;
      while (j < prev.length && j < cur.length && prev[j] === cur[j]) j++;
      const lcpTokensVal = Math.floor(j / 4);
      const believed = corpus.caches.find((c) => c.turn === i + 1)?.expected.hitTokens ?? 0;
      if (Math.abs(lcpTokensVal - believed) > 40) {
        console.log(`turn ${i + 1}: LCP breaks at char ${j} (~${lcpTokensVal}t); believed ${believed}t; first divergence context: ${JSON.stringify(cur.slice(Math.max(0, j - 30), j + 30))}`);
      }
    }
  }
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
    beliefGap: g.beliefGap === null ? null : {
      basis: g.beliefGap.basis,
      compared: g.beliefGap.compared,
      maeTokens: round(g.beliefGap.maeTokens),
      signedMeanTokens: round(g.beliefGap.signedMeanTokens),
      slopeTokensPerTurn: round(g.beliefGap.slopeTokensPerTurn),
      signature: g.beliefGap.signature,
    },
    raw: { flips: g.flips, evictions: g.evictions, reExpansions: g.reExpansions, restructures: g.restructures },
  }, null, 2));
}

function round(x: number): number { return Math.round(x * 10000) / 10000; }

await main();
