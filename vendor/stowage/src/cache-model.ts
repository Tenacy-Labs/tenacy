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

/**
 * Review B7: divergence classification thresholds, pinned and named.
 * Values unchanged from their inline ancestors — this is a pin, not a retune.
 */
export const DIVERGENCE_THRESHOLDS = {
  /** cacheRead > 2.5× true inputTokens ⇒ provider sums internal reads (A3). */
  cacheReadMultipleOfInput: 2.5,
  /** rebilled class only fires on a material expected base (tokens). */
  expectedFloor: 200,
  /** realized < 25% of expected ⇒ believed-cached block was rebilled. */
  rebilledFraction: 0.25,
  /** expected 0 but realized > this ⇒ an eviction we did not model. */
  evictedHitFloor: 500,
} as const;

export function blockDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

interface BelievedBlock {
  digest: string;
  tokens: number;
  turn: number;
  wallTimeMs?: number | undefined;
}

/** Number of provider billing quanta touched by a token mass. */
export function billingQuanta(tokens: number, granularity: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  if (!Number.isFinite(granularity) || granularity <= 0) throw new RangeError("granularity must be positive");
  return Math.ceil(tokens / granularity);
}

/** Price at the next explicit provider billing breakpoint. */
export function breakpointPrice(tokens: number, pricePer1k: number, granularity: number): number {
  return (billingQuanta(tokens, granularity) * granularity / 1000) * pricePer1k;
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
  /** Virtual head block — prefix tokens outside the render (tool defs).
   *  Positioned at 0 because providers render tools before system. */
  private head: BelievedBlock | null = null;

  constructor(private params: CacheModelParams) {}

  /** Install/replace the virtual head (probe-measured tool-prefix tokens). */
  setHeadBlock(head: { digest: string; tokens: number } | null): void {
    this.head = head === null ? null : { ...head, turn: this.turn };
  }

  headBlockTokens(): number {
    return this.head?.tokens ?? 0;
  }

  /** Expected cached prefix for a candidate render chain. */
  expectedHit(blocks: Block[], wallTimeMs?: number): { hitTokens: number; price: number } {
    // The head rides BOTH sides: it is re-sent verbatim every request, so it
    // matches itself at position 0; render blocks then align shifted by one.
    const chain: readonly BelievedBlock[] = this.head === null ? this.chain : [this.head, ...this.chain];
    const cand: ReadonlyArray<{ digest: string; tokens: number }> = this.head === null
      ? blocks
      : [{ digest: this.head.digest, tokens: this.head.tokens }, ...blocks];
    let hit = 0;
    for (let i = 0; i < cand.length && i < chain.length; i++) {
      const b = cand[i]!;
      const believed = chain[i]!;
      const hasWallClock = this.params.ttlMs !== undefined
        && wallTimeMs !== undefined
        && believed.wallTimeMs !== undefined;
      const fresh = hasWallClock
        ? wallTimeMs - believed.wallTimeMs! <= this.params.ttlMs!
        : this.turn - believed.turn <= this.params.ttlTurns;
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
      // Review B7: divergence thresholds pinned as named constants (ADR
      // discipline: every classification boundary is inspectable).
      const anomalous = usage.cacheReadTokens > DIVERGENCE_THRESHOLDS.cacheReadMultipleOfInput * usage.inputTokens;   // summed internal reads (A3; 2.5×)
      if (anomalous) divergence = "provider-usage-semantics";
      else if (expected.hitTokens > DIVERGENCE_THRESHOLDS.expectedFloor && realized.hitTokens < expected.hitTokens * DIVERGENCE_THRESHOLDS.rebilledFraction)
        divergence = "believed-cached-rebilled";
      else if (expected.hitTokens === 0 && realized.hitTokens > DIVERGENCE_THRESHOLDS.evictedHitFloor)
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
  update(blocks: Block[], wallTimeMs?: number): void {
    this.turn += 1;
    // The head (tool defs) is re-sent verbatim each request, refreshing its
    // provider cache entry — advance its freshness with the turn.
    if (this.head !== null) this.head.turn = this.turn;
    this.chain = blocks.map((b) => ({
      digest: b.digest,
      tokens: b.tokens,
      turn: this.turn,
      ...(wallTimeMs === undefined ? {} : { wallTimeMs }),
    }));
  }

  believedChain(): readonly string[] {
    return this.chain.map((b) => b.digest);
  }
}
