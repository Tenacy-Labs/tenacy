/**
 * CacheModel — our belief about the server's KV cache (ADR-0002 §2),
 * self-calibrating against reported usage every call (ADR-0002e §1).
 *
 * Belief substrate: the digest chain of emitted blocks. A block is believed
 * cached when its digest sits in the chain and TTL has not expired. The
 * longest common prefix between the previous render's chain and the next
 * render's chain is the expected cache hit.
 */
import type { Block, CacheLedger, DivergenceClass } from "./types.ts";
import type { CacheModelParams } from "./params.ts";
import { createHash } from "node:crypto";

export function blockDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

interface BelievedBlock {
  digest: string;
  tokens: number;
  turn: number;
}

export interface UsageReport {
  inputTokens: number;        // TRUE context length — the A3 standing rule reads this
  cacheReadTokens?: number;   // provider-reported cache hits (may be summed/internally inflated)
  cacheWriteTokens?: number;
  outputTokens: number;
  raw: unknown;
}

export class CacheModel {
  private chain: BelievedBlock[] = [];
  private turn = 0;

  constructor(private params: CacheModelParams) {}

  /** Expected cached prefix for a candidate render chain. */
  expectedHit(blocks: Block[]): { hitTokens: number; price: number } {
    let hit = 0;
    for (let i = 0; i < blocks.length && i < this.chain.length; i++) {
      const b = blocks[i]!;
      const believed = this.chain[i]!;
      const fresh = this.turn - believed.turn <= this.params.ttlTurns;
      if (b.digest === believed.digest && fresh) hit += b.tokens;
      else break; // prefix property: first mismatch ends the cached run
    }
    const price = (hit / 1000) * this.params.pricePer1kCached;
    return { hitTokens: hit, price };
  }

  /** Re-prefill cost: uncached suffix tokens at the uncached-minus-cached spread. */
  rePrelillCost(totalTokens: number, hitTokens: number): number {
    const miss = Math.max(0, totalTokens - hitTokens);
    return (miss / 1000) * (this.params.pricePer1kUncached - this.params.pricePer1kCached);
  }

  /**
   * Calibrate belief against realized usage — the closed loop (ADR-0002 §4).
   * A3 standing rule: classification reads true inputTokens, never summed
   * cache-read counters; the semantics divergence class fires when the
   * provider's cache-read figure exceeds the true context (~5x anomaly).
   */
  calibrate(blocks: Block[], usage: UsageReport | null, expected: { hitTokens: number }): CacheLedger {
    let divergence: DivergenceClass = "none";
    let realized: CacheLedger["realized"] = null;

    if (usage === null) {
      divergence = "unreported";
    } else if (usage.cacheReadTokens === undefined) {
      // Review B3: an absent cache counter is UNREPORTED, not "realized 0".
      // Recording 0 fabricated overbelief evidence in Gauge 6 on live
      // corpora whose providers omit the counter.
      realized = null;
      divergence = "unreported";
    } else {
      realized = {
        hitTokens: usage.cacheReadTokens,
        price: (usage.cacheReadTokens / 1000) * this.params.pricePer1kCached,
      };
      const anomalous = usage.cacheReadTokens > 2.5 * usage.inputTokens;      // summed internal reads (A3)
      if (anomalous) divergence = "provider-usage-semantics";
      else if (expected.hitTokens > 200 && realized.hitTokens < expected.hitTokens * 0.25)
        divergence = "believed-cached-rebilled";
      else if (expected.hitTokens === 0 && realized.hitTokens > 500)
        divergence = "believed-evicted-hit";
    }

    return {
      turn: this.turn,
      expected: { hitTokens: expected.hitTokens, price: (expected.hitTokens / 1000) * this.params.pricePer1kCached },
      realized,
      divergence,
      rawProviderReport: usage?.raw ?? null,
    };
  }

  /** Commit the new chain as belief (call after each model call). */
  update(blocks: Block[]): void {
    this.turn += 1;
    this.chain = blocks.map((b) => ({ digest: b.digest, tokens: b.tokens, turn: this.turn }));
  }

  believedChain(): readonly string[] {
    return this.chain.map((b) => b.digest);
  }
}
