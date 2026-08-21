/**
 * Model providers — the boundary where context meets a server (ADR-0002 §2).
 *
 * MockProvider: deterministic, offline, reports plausible usage (CI-safe).
 * AnthropicProvider: wire-shaped (messages API); bring your own key.
 */
import type { Block } from "./types.ts";
import type { UsageReport } from "./cache-model.ts";

export interface ModelResponse {
  text: string;
  usage: UsageReport;
  stopReason: "end_turn" | "max_tokens" | "abuse";
}

export interface Provider {
  readonly modelId: string;
  /** Send rendered blocks (context) + latest user message; get a response. */
  call(blocks: Block[], userMessage: string): Promise<ModelResponse>;
}

/** Deterministic mock — echoes a summary of what it "saw", reports honest usage. */
export class MockProvider implements Provider {
  readonly modelId = "mock-1";
  #calls = 0;
  /** Simulated prefix-cache: digest→turn; evicts all on any prefix change (LRU of 1 render). */
  #believedServer: { chain: string[]; totalTokens: number } = { chain: [], totalTokens: 0 };

  constructor(private style: "echo" | "scripted" = "echo", private script: string[] = []) {}

  async call(blocks: Block[], userMessage: string): Promise<ModelResponse> {
    this.#calls += 1;
    const totalTokens = blocks.reduce((s, b) => s + b.tokens, 0);

    // Server-side cache simulation: longest common prefix hit
    let hit = 0;
    for (let i = 0; i < blocks.length && i < this.#believedServer.chain.length; i++) {
      if (blocks[i]!.digest === this.#believedServer.chain[i]) hit += blocks[i]!.tokens;
      else break;
    }
    // usage semantics: honest provider (A3 class does not fire)
    const usage: UsageReport = {
      inputTokens: totalTokens + estTok(userMessage),
      cacheReadTokens: hit,
      cacheWriteTokens: Math.max(0, totalTokens - hit),
      outputTokens: estTok(this.#reply(blocks, userMessage)),
      raw: { provider: "mock", call: this.#calls },
    };
    this.#believedServer = { chain: blocks.map((b) => b.digest), totalTokens };

    if (this.style === "scripted" && this.script.length > 0) {
      const text = this.script.shift() ?? "[script exhausted]";
      return { text, usage: { ...usage, outputTokens: estTok(text) }, stopReason: "end_turn" };
    }
    return {
      text: this.#reply(blocks, userMessage),
      usage,
      stopReason: "end_turn",
    };
  }

  #reply(blocks: Block[], userMessage: string): string {
    const lastZone = blocks[blocks.length - 1]?.zone ?? "evolving";
    const nItems = blocks.length;
    return `Acknowledged: ${nItems} context blocks (tail zone: ${lastZone}); your message: "${userMessage.slice(0, 80)}". I have considered the rendered context and respond coherently.`;
  }
}

function estTok(s: string): number {
  return Math.ceil(s.length / 4);
}
