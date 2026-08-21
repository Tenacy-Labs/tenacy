/**
 * ContextStore — kernel-resident, typed, journaled. Collections of
 * ContextItems, never rendered directly (ADR-0002 §2).
 *
 * Single-writer discipline: all mutations flow through here at turn
 * boundaries; the solver reads a stable snapshot. The model operates the
 * store only through materialized tool modules (files / ctx / goals).
 */
import type { ContextItem, ItemKind, Zone } from "./types.ts";
import { ZONE_ORDER } from "./types.ts";

export class ContextStore {
  private items = new Map<string, ContextItem>();
  private journalListeners: Array<(e: StoreJournalEvent) => void> = [];
  turn = 0;

  add(item: ContextItem): void {
    if (this.items.has(item.id)) throw new Error(`duplicate item id: ${item.id}`);
    this.items.set(item.id, { ...item, createdTurn: this.turn, lastTouchTurn: this.turn });
  }

  get(id: string): ContextItem | undefined {
    return this.items.get(id);
  }

  remove(id: string): boolean {
    return this.items.delete(id);
  }

  all(): ContextItem[] {
    return [...this.items.values()];
  }

  /** Snapshot for the solver — stable while render runs. */
  snapshot(): Map<string, ContextItem> {
    return new Map(this.items);
  }

  nextTurn(): void {
    this.turn += 1;
  }

  onJournal(fn: (e: StoreJournalEvent) => void): void {
    this.journalListeners.push(fn);
  }

  /** Value bump — ctx.promote / explicit invocation (0002g). Decay-exempt adder. */
  bump(id: string, amount: number, untilTurn: number): void {
    const it = this.items.get(id);
    if (!it) return;
    it.valueBump = { amount, untilTurn };
    this.#emit({ type: "value-bump", itemId: id, amount, untilTurn });
  }

  /** Toggle flip — ADR-0002d §7. Model-authored flips feed calibration; optimizer's never. */
  setWatch(id: string, mode: "live" | "polled" | "frozen"): void {
    const it = this.items.get(id);
    if (!it) return;
    if (mode !== "live" && mode !== "polled" && mode !== "frozen") throw new Error(`bad watch mode: ${mode}`);
    it.watch = mode;
    this.#emit({ type: "watch-flip", itemId: id, mode, author: "model-authored" });
  }

  /** DAG invalidation — ADR-0002c §5: invalidating a leaf covers the subtree. */
  invalidateUpstream(id: string): string[] {
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const it = this.items.get(cur);
      if (!it) continue;
      for (const up of it.upstreams ?? []) {
        stack.push(up);
      }
    }
    for (const sid of seen) {
      const it = this.items.get(sid);
      if (it) it.lastTouchTurn = this.turn;
      this.#emit({ type: "dag-invalidate", itemId: sid });
    }
    return [...seen];
  }

  touch(id: string): void {
    const it = this.items.get(id);
    if (it) it.lastTouchTurn = this.turn;
  }

  #emit(e: StoreJournalEvent): void {
    for (const fn of this.journalListeners) fn(e);
  }
}

export type StoreJournalEvent =
  | { type: "value-bump"; itemId: string; amount: number; untilTurn: number }
  | { type: "watch-flip"; itemId: string; mode: "live" | "polled" | "frozen"; author: "model-authored" }
  | { type: "dag-invalidate"; itemId: string };

/** Kind to default zone mapping (solver may override per option; zones are the cache layout). */
export function kindZone(kind: ItemKind, velocity: ContextItem["velocity"]): Zone {
  if (kind === "identity" || kind === "goal") return "identity";
  if (kind === "directive" || kind === "reference" || kind === "error") return "foundational";
  if (kind === "artifact" || kind === "kernelView") return "stable";
  if (kind === "lens") return velocity === "volatile" ? "volatile" : "evolving";
  return "evolving";
}

export { ZONE_ORDER };
