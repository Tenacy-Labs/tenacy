/**
 * Decision ledger write path — ADR-0002e §1–2, ADR-0004 §8.
 *
 * Append-only JSONL; written asynchronously, never blocking render;
 * the numbers the solver already computed, decomposed for attribution.
 * The ledger is journal, not store — entries never render.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Block, CacheLedger, ItemLedger, RenderResult, TurnLedger } from "./types.ts";
import type { ParamSet } from "./params.ts";
import type { UsageReport } from "./cache-model.ts";

export class Ledger {
  private queue: string[] = [];
  private flushing = false;
  turns = 0;

  constructor(private path: string) {}

  /** Record one render decision step (turn + items). Non-blocking. */
  recordTurn(rr: RenderResult, ps: ParamSet, turn: number, itemLedgers: ItemLedger[]): void {
    const tl: TurnLedger = {
      turn,
      layout: rr.placements.map((p) => ({ id: p.id, position: p.position, tokens: p.tokens, state: p.representation })),
      cacheBelief: {
        blockDigestChain: rr.blocks.map((b) => b.digest),
        checkpoints: [0],
        ttlTurns: ps.cache.ttlTurns,
        providerGranularity: ps.cache.granularity,
      },
      budgetLambda: ps.budgetLambda,
      parameterSetVersion: ps.version,
      modelId: ps.modelId,
      zoneHistograms: rr.zoneHistograms,
    };
    this.queue.push(JSON.stringify({ t: "turn", ...tl }));
    for (const il of itemLedgers) this.queue.push(JSON.stringify({ t: "item", ...il }));
    this.turns += 1;
    void this.#flush();
  }

  recordCache(cl: CacheLedger): void {
    this.queue.push(JSON.stringify({ t: "cache", ...cl }));
    void this.#flush();
  }

  recordSignal(e: { type: string; [k: string]: unknown }): void {
    this.queue.push(JSON.stringify({ t: "signal", ...e }));
    void this.#flush();
  }

  async #flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, 256).join("\n") + "\n";
        await mkdir(dirname(this.path), { recursive: true });
        await appendFile(this.path, batch);
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Await pending writes (call at session end / before exit). */
  async drain(): Promise<void> {
    // A pending flush needs a macrotask tick (fs callback); awaiting resolved
    // microtask promises alone would starve it. Yield with a real timer.
    for (let guard = 0; guard < 10_000 && (this.flushing || this.queue.length > 0); guard++) {
      if (this.flushing) {
        await new Promise((r) => setTimeout(r, 1));
        continue;
      }
      await this.#flush();
    }
  }
}

/** Blocks → believed-cached digest chain snapshot (for the CacheLedger). */
export function blocksToChain(blocks: Block[]): string[] {
  return blocks.map((b) => b.digest);
}
