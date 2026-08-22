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


/**
 * MERGED group formation (ADR-0002f §2): contiguous runs of aged episodic
 * turns merge under one group item — one transform amortized over the run.
 * Members keep verbatim in the store; only their option surface changes
 * (in-merge). Deterministic given the store and the age threshold.
 */
export interface MergeGroupPlan {
  groupId: string;
  memberIds: string[];
  mergedText: string;
}

export function planMergeGroups(
  items: Array<{ id: string; kind: string; createdTurn: number; serialize(): string }>,
  turn: number,
  minAgeTurns = 6,
  minGroupSize = 2,
): MergeGroupPlan[] {
  const aged = items
    .filter((i) => i.kind === "episodic" && turn - i.createdTurn >= minAgeTurns && i.id.startsWith("turn-"))
    .sort((a, b) => a.createdTurn - b.createdTurn || a.id.localeCompare(b.id));
  const plans: MergeGroupPlan[] = [];
  let run: typeof aged = [];
  const flush = (): void => {
    if (run.length >= minGroupSize) {
      const ids = run.map((r) => r.id);
      const groupId = `merge:${ids[0]}..${ids[ids.length - 1]}`;
      const mergedText = run.map((r) => firstSentence(r.serialize())).join(" ");
      plans.push({ groupId, memberIds: ids, mergedText });
    }
    run = [];
  };
  let prevTurn: number | null = null;
  for (const it of aged) {
    if (prevTurn !== null && it.createdTurn - prevTurn > 1) flush();
    run.push(it);
    prevTurn = it.createdTurn;
  }
  flush();
  return plans;
}

function firstSentence(text: string): string {
  const m = /[.!?]\s/.exec(text);
  return m === null ? text.slice(0, 200) : text.slice(0, m.index + 1);
}

/**
 * Realized lossiness (ADR-0002f §2): a re-expansion after summarization —
 * the model restoring verbatim is reporting the summary was premature.
 * Journaled so the A6 confidence ramp and the 0003 value audit can learn.
 */
export function realizedLossiness(item: { id: string; summary?: string; mergedInto?: string }): boolean {
  return item.summary !== undefined || item.mergedInto !== undefined;
}
