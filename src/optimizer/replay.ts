/**
 * Replay harness skeleton — ADR-0003 §2. Instrument-first: ships with the
 * loop milestone.
 *
 * HONESTY BOUNDARY: cost-counterfactual only. Replay re-renders the
 * journaled store states under a chosen parameter set and reports what the
 * SAME decisions would have cost. It never claims behavior differences —
 * the journal holds only what happened; quality claims need live A/B.
 *
 * Inputs: the JSONL ledger (turn/item/cache/signal records). Outputs:
 * report 1 (cache belief) and report 6 (cost vs baselines) series.
 */
import { readFile } from "node:fs/promises";
import type { CacheLedger, ItemLedger, TurnLedger } from "./types.ts";
import type { ParamSet } from "./params.ts";

export interface LedgerFile {
  turns: TurnLedger[];
  items: ItemLedger[];
  caches: CacheLedger[];
}

export async function loadLedger(path: string): Promise<LedgerFile> {
  const raw = await readFile(path, "utf8");
  const turns: TurnLedger[] = [];
  const items: ItemLedger[] = [];
  const caches: CacheLedger[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const rec = JSON.parse(line) as unknown as Record<string, unknown>;
    if (rec.t === "turn") turns.push(rec as unknown as TurnLedger);
    else if (rec.t === "item") items.push(rec as unknown as ItemLedger);
    else if (rec.t === "cache") caches.push(rec as unknown as CacheLedger);
  }
  return { turns, items, caches };
}

/** Report 1: cache belief vs realized — accuracy series per turn. */
export function reportCacheBelief(caches: CacheLedger[]): CacheBeliefReport {
  let compared = 0, meanAbsError = 0;
  const classes: Record<string, number> = {};
  for (const c of caches) {
    classes[c.divergence] = (classes[c.divergence] ?? 0) + 1;
    if (c.realized !== null) {
      compared += 1;
      meanAbsError += Math.abs(c.expected.hitTokens - c.realized.hitTokens);
    }
    // turn-number distribution
  }
  return {
    report: "cache-belief",
    turns: caches.length,
    compared,
    meanAbsErrorTokens: compared > 0 ? meanAbsError / compared : null,
    divergenceClasses: classes,
  };
}

export interface CacheBeliefReport {
  report: string;
  turns: number;
  comparableTurns?: number;
  compared: number;
  meanAbsErrorTokens: number | null;
  divergenceClasses: Record<string, number>;
}

/** Report 6: cost vs baselines (accumulator control, analytic floor, incumbent). */
export function reportCostVsBaselines(
  caches: CacheLedger[],
  ps: ParamSet,
): CostVsBaselinesReport {
  // Accumulator control: everything verbatim, no drops — naive accumulation.
  // Floor: sum of realized output + unavoidable input at cached price for held items.
  // Incumbent: what the solver actually paid.
  let incumbentInputCost = 0;
  let floorInputCost = 0;
  let expectedHitTokens = 0;
  for (const c of caches) {
    const uncached = (c.expected.hitTokens / 1000) * ps.cache.pricePer1kCached;
    incumbentInputCost += uncached;
    expectedHitTokens += c.expected.hitTokens;
  }
  // second pass for floor: each turn's full render at uncached price would be the accumulator
  let accumulatorCost = 0;
  for (const c of caches) {
    accumulatorCost += ((c.expected.hitTokens * 10) / 1000) * ps.cache.pricePer1kCached; // proxy: hit*10 ≈ total
  }
  floorInputCost = incumbentInputCost * 0.5; // v1 analytic proxy — refined by refit pipeline
  return {
    report: "cost-vs-baselines",
    turns: caches.length,
    incumbentInputCost,
    accumulatorControlCost: accumulatorCost,
    analyticFloorCost: floorInputCost,
    note: "accumulator proxy: hit×10; floor proxy: 0.5×incumbent — honest v1 proxies, refined by the refit pipeline (0003 §4)",
  };
}

export interface CostVsBaselinesReport {
  report: string;
  turns: number;
  incumbentInputCost: number;
  accumulatorControlCost: number;
  analyticFloorCost: number;
  note: string;
}
