/**
 * Model providers — the boundary where context meets a server (ADR-0002 §2).
 *
 * MockProvider: deterministic, offline, honest usage (CI-safe).
 * ScriptedProvider: step-scripted replies + model-proposed intents —
 *   the envelope the benchmark harness drives tool use through.
 * AnthropicProvider: live wire client (src/optimizer/anthropic.ts) —
 *   never instantiated in CI.
 */
import type { Block } from "./types.ts";
import type { UsageReport } from "./cache-model.ts";
import type { SteeringIntent } from "./intents.ts";

export interface ModelResponse {
  text: string;
  usage: UsageReport;
  stopReason: "end_turn" | "max_tokens" | "abuse";
  /** Model-proposed tool operations, applied by the loop after the reply (proposer/applier split). */
  intents?: SteeringIntent[] | undefined;
}

export interface Provider {
  readonly modelId: string;
  call(blocks: Block[], userMessage: string): Promise<ModelResponse>;
}

/** Shared offline prefix-cache simulation: LCP of block digests = hit. */
export class PrefixCacheSim {
  #chain: string[] = [];
  hit(blocks: Block[]): number {
    let hit = 0;
    for (let i = 0; i < blocks.length && i < this.#chain.length; i++) {
      if (blocks[i]!.digest === this.#chain[i]) hit += blocks[i]!.tokens;
      else break;
    }
    return hit;
  }
  commit(blocks: Block[]): void {
    this.#chain = blocks.map((b) => b.digest);
  }
}

function estTok(s: string): number {
  return Math.ceil(s.length / 4);
}

/** Deterministic mock — echoes a summary of what it "saw", reports honest usage. */
export class MockProvider implements Provider {
  readonly modelId = "mock-1";
  #sim = new PrefixCacheSim();
  #calls = 0;

  async call(blocks: Block[], userMessage: string): Promise<ModelResponse> {
    this.#calls += 1;
    const totalTokens = blocks.reduce((s, b) => s + b.tokens, 0);
    const reply = this.#reply(blocks, userMessage);
    const hit = this.#sim.hit(blocks);
    this.#sim.commit(blocks);
    return {
      text: reply,
      usage: {
        inputTokens: totalTokens + estTok(userMessage),
        cacheReadTokens: hit,
        cacheWriteTokens: Math.max(0, totalTokens - hit),
        outputTokens: estTok(reply),
        raw: { provider: "mock", call: this.#calls },
      },
      stopReason: "end_turn",
    };
  }

  #reply(blocks: Block[], userMessage: string): string {
    const lastZone = blocks[blocks.length - 1]?.zone ?? "evolving";
    return `Acknowledged: ${blocks.length} context blocks (tail zone: ${lastZone}); your message: "${userMessage.slice(0, 80)}". I have considered the rendered context and respond coherently.`;
  }
}

export interface ScriptStep {
  text?: string;
  intents?: SteeringIntent[] | undefined;
}

/**
 * ScriptedProvider — step-scripted responses for reproducible agentic tasks.
 * Each call consumes one step; exhausted script yields a terminal marker.
 * Usage reporting is honest (same prefix-cache sim as MockProvider), so
 * cache-belief calibration runs identically against scripted tasks.
 */
export class ScriptedProvider implements Provider {
  readonly modelId = "mock-scripted";
  #sim = new PrefixCacheSim();
  #steps: ScriptStep[];

  constructor(steps: ScriptStep[]) {
    this.#steps = [...steps];
  }

  async call(blocks: Block[], userMessage: string): Promise<ModelResponse> {
    const step = this.#steps.shift() ?? { text: "[script exhausted]" };
    const text = step.text ?? "";
    const totalTokens = blocks.reduce((s, b) => s + b.tokens, 0);
    const hit = this.#sim.hit(blocks);
    this.#sim.commit(blocks);
    return {
      text,
      intents: step.intents,
      usage: {
        inputTokens: totalTokens + estTok(userMessage),
        cacheReadTokens: hit,
        cacheWriteTokens: Math.max(0, totalTokens - hit),
        outputTokens: estTok(text),
        raw: { provider: "scripted", stepsLeft: this.#steps.length },
      },
      stopReason: "end_turn",
    };
  }
}
