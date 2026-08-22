/**
 * ADR-0006 §7 gauges — the falsification instrument. Phase 0: wire gauges
 * BEFORE the property work, so §2 has baseline numbers to earn itself against.
 *
 * Gauges (ADR-0006 §7):
 *   flips/100 turns          — representation churn (expect down after §2)
 *   re-expansions/eviction   — wrong-drop detector (expect down)
 *   believed-hit ratio       — cache belief quality (expect up; 0.77 baseline)
 *   dead-token share         — tokens held below reservation price (expect down)
 *   write-to-harvest         — cached tokens harvested per deliberate restructure
 */
import { describe, test, expect } from "bun:test";
import { loadCorpus, type Corpus } from "../src/optimizer/corpus.ts";
import { reportGauges } from "../src/optimizer/reports.ts";
import { paramSetV1 } from "../src/optimizer/params.ts";
import type { TurnLedger, ItemLedger, CacheLedger } from "../src/optimizer/types.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Hand-planted corpus with known gauge values: 2 turns, 1 flip, 1 evict→re-expand. */
function plantedCorpus(): Corpus {
  const turns: TurnLedger[] = [
    {
      turn: 1,
      layout: [
        { id: "lens:a", position: 1, tokens: 100, state: "FULL" },
        { id: "lens:b", position: 2, tokens: 400, state: "FULL" },
      ],
      cacheBelief: { blockDigestChain: ["d1", "d2"], checkpoints: [0], ttlTurns: 6, providerGranularity: 1024 },
      budgetLambda: 2048, parameterSetVersion: "test-v1", modelId: "mock",
      zoneHistograms: { identity: {}, foundational: {}, stable: {}, evolving: {}, volatile: {} },
    },
    {
      turn: 2,
      layout: [
        { id: "lens:a", position: 1, tokens: 100, state: "CONSOLIDATED" },  // flip
        { id: "lens:b", position: 2, tokens: 400, state: "FULL" },
      ],
      cacheBelief: { blockDigestChain: ["d1", "d2"], checkpoints: [0], ttlTurns: 6, providerGranularity: 1024 },
      budgetLambda: 2048, parameterSetVersion: "test-v1", modelId: "mock",
      zoneHistograms: { identity: {}, foundational: {}, stable: {}, evolving: {}, volatile: {} },
    },
  ];
  const items: ItemLedger[] = [
    {
      turn: 1, id: "lens:a",
      forecast: { mu0: 1, alpha: 0.5, deltaT: 1, hazard: 0.1, basis: "prior", expectedValue: 0.9 },
      utility: { benefit: 1, cacheCost: 0, rotShare: 0, total: 1 },
      decision: "keep", accepted: true, marginVsHysteresis: 0.5,
    },
    {
      turn: 1, id: "lens:b",
      forecast: { mu0: 0.05, alpha: 0.5, deltaT: 40, hazard: 0.1, basis: "prior", expectedValue: 0.001 },
      utility: { benefit: 0.001, cacheCost: 0, rotShare: 0, total: 0.001 },
      decision: "drop", accepted: true, marginVsHysteresis: 0.5,   // evicted (dead bytes then gone)
    },
    {
      turn: 2, id: "lens:a",
      forecast: { mu0: 1, alpha: 0.5, deltaT: 2, hazard: 0.1, basis: "prior", expectedValue: 0.9 },
      utility: { benefit: 1, cacheCost: 0.05, rotShare: 0, total: 0.95 },
      decision: "consolidate", accepted: true, marginVsHysteresis: 0.5,  // deliberate restructure
    },
  ];
  const caches: CacheLedger[] = [
    { turn: 1, expected: { hitTokens: 400, price: 0.1 }, realized: null, divergence: "unreported", rawProviderReport: null },
    { turn: 2, expected: { hitTokens: 500, price: 0.1 }, realized: null, divergence: "unreported", rawProviderReport: null },
    { turn: 3, expected: { hitTokens: 600, price: 0.1 }, realized: null, divergence: "unreported", rawProviderReport: null },
  ];
  const signals: Array<Record<string, unknown>> = [
    { t: "signal", type: "files-expand", itemId: "lens:b", from: 1, to: 40, turn: 2 },  // re-expansion after eviction
    { t: "signal", type: "files-expand", itemId: "lens:c", from: 1, to: 40, turn: 2 },  // fresh expand, not re-expansion
  ];
  return {
    turns, items, caches,
    // deno.lint-ignore no-explicit-any
    signals: signals as any,
    provenance: "realized", sources: ["planted"], parameterSetVersions: ["test-v1"], modelIds: ["mock"],
  };
}

describe("ADR-0006 §7 gauges", () => {
  test("flips: representation changes counted per consecutive layout pair, per 100 turns", () => {
    const g = reportGauges(plantedCorpus(), paramSetV1("mock"));
    expect(g.turns).toBe(2);
    expect(g.flips).toBe(1);                       // lens:a FULL → COMPACT
    expect(g.flipsPer100).toBe(50);                // 1 flip / 2 turns
  });

  test("re-expansions: expand signal on a previously-evicted item; ratio per eviction", () => {
    const g = reportGauges(plantedCorpus(), paramSetV1("mock"));
    expect(g.evictions).toBe(1);                   // lens:b drop accepted
    expect(g.reExpansions).toBe(1);                // lens:b expanded again at turn 2
    expect(g.reExpansionsPerEviction).toBe(1);
  });

  test("believed-hit ratio: expected hit tokens over rendered tokens", () => {
    const g = reportGauges(plantedCorpus(), paramSetV1("mock"));
    // turn1: 400/500, turn2: 500/500 → 900/1000
    expect(g.believedHitRatio).toBeCloseTo(0.9, 5);
  });

  test("dead-token share: rendered tokens held below reservation price ρ", () => {
    const ps = paramSetV1("mock");
    const g = reportGauges(plantedCorpus(), ps);
    // numerator: lens:b@1 tokens (expectedValue 0.001 < rho) = 400
    // denominator: forecast-covered rendered tokens = 500 (turn 1) + 100 (turn 2) = 600
    expect(g.deadTokenShare).toBeCloseTo(400 / 600, 5);
  });

  test("write-to-harvest: cached tokens harvested per deliberate restructure (expected basis)", () => {
    const g = reportGauges(plantedCorpus(), paramSetV1("mock"));
    // restructure@2; window (2, 2+6]; turn 3 in window → harvest 600/1 restructure
    expect(g.restructures).toBe(1);
    expect(g.writeToHarvest).toBe(600);
    expect(g.harvestBasis).toBe("expected");
  });

  test("real ledger round-trip: signals load; gauges run over a live corpus", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-gauges-"));
    const p = join(dir, "ledger.jsonl");
    writeFileSync(p, [
      JSON.stringify({ t: "turn", turn: 1, layout: [], cacheBelief: { blockDigestChain: [], checkpoints: [], ttlTurns: 6, providerGranularity: 1024 }, budgetLambda: 2048, parameterSetVersion: "v", modelId: "m", zoneHistograms: {} }),
      JSON.stringify({ t: "signal", type: "files-expand", itemId: "lens:x", turn: 1 }),
    ].join("\n"));
    const corpus = await loadCorpus([p], "realized");
    expect(corpus.signals.length).toBe(1);
    const g = reportGauges(corpus, paramSetV1("mock"));
    expect(g.turns).toBe(1);
    expect(g.flips).toBe(0);
    expect(g.believedHitRatio).toBe(null);   // no cache records → null, never fabricated
    expect(g.deadTokenShare).toBe(null);     // no item forecasts → null
  });
});
