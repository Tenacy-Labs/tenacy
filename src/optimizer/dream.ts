/**
 * Dreaming transforms — ADR-0002f §4: lossy-in-render, never-in-store.
 *
 * Dream turns run between turns (async, off the hot path): old episodic
 * records gain a SUMMARY option the solver can choose (it pays the A6
 * fidelity penalty; the ramp earns aggressiveness through observed regret).
 * The verbatim store record is never modified — re-expansion is always
 * possible and its lossiness feeds calibration.
 */
import type { ContextItem, RenderOption } from "./types.ts";
import { estTokens } from "./renderer.ts";

export interface DreamResult {
  itemId: string;
  summaryText: string;
  /** Honest ratio — feeds the A6 confidence ramp via the ledger. */
  compressionRatio: number;
}

/**
 * Heuristic dream v1: first sentence + trailing clause (deterministic).
 * Real summarizers slot in as an injected function later (0003 T4: buy
 * the commodity representation, keep the differentiated core).
 */
export function heuristicDream(item: ContextItem, keep = 1): DreamResult {
  const text = item.serialize();
  const sentences = text.split(/(?<=[.!?])\s+/);
  const kept = sentences.slice(0, keep).join(" ");
  const summaryText = `[${item.id} summarized] ${kept}`;
  return {
    itemId: item.id,
    summaryText,
    compressionRatio: item.tokens > 0 ? estTokens(summaryText) / item.tokens : 1,
  };
}

/**
 * Attach a SUMMARY option to an episodic item (the dream output). The
 * store record stays verbatim — only the option surface grows.
 */
export function attachSummaryOption(
  item: { summary?: string },
  summary: string,
): void {
  item.summary = summary;
}

/**
 * Run a dream pass over the store: items older than minAgeTurns whose kind
 * is dreamable gain summary options. Deterministic — same store, same pass.
 */
export function dreamPass(items: ContextItem[], turn: number, minAgeTurns = 3): DreamResult[] {
  const results: DreamResult[] = [];
  for (const item of items) {
    if (item.kind !== "episodic") continue;
    if (turn - item.createdTurn < minAgeTurns) continue;
    // TurnItem instances expose `summary`; generic ContextItems do not —
    // only dream items that opted in by having a mutable summary slot.
    if (!("summary" in item)) continue;
    const dreamt = heuristicDream(item);
    attachSummaryOption(item as { summary?: string }, dreamt.summaryText);
    results.push(dreamt);
  }
  return results;
}
