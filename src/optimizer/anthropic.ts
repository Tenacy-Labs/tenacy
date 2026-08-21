/**
 * AnthropicProvider — the live wire (ADR-0002 §2 provider boundary).
 *
 * Bring your own key: ANTHROPIC_API_KEY env; never instantiated in CI.
 * Honest usage: reads usage.input_tokens (the A3 standing rule) and passes
 * provider cache counters as-is for calibration, never summed into
 * eviction/compaction triggers. Native fetch; zero runtime deps.
 *
 * Zone mapping: identity+foundational ride the system prompt (the stable
 * head a provider caches hardest); stable/evolving/volatile ride the final
 * user turn in render order. Cache breakpoints follow zone boundaries;
 * provider granularity (1024t) means short segments never get a marker.
 */
import type { Block } from "./types.ts";
import type { UsageReport } from "./cache-model.ts";
import type { ModelResponse, Provider } from "./providers.ts";

const DEFAULT_BASE = "https://api.anthropic.com";
const DEFAULT_MODEL = "claude-sonnet-4-5";

export interface AnthropicConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  systemPrefix?: string;
}

interface AnthropicUsage {
  input_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens: number;
}

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
  stop_reason?: string;
  usage: AnthropicUsage;
}

export class AnthropicProvider implements Provider {
  readonly modelId: string;
  readonly #cfg: AnthropicConfig;
  readonly #granularity: number;

  constructor(cfg: AnthropicConfig = {}, granularity = 1024) {
    this.#cfg = cfg;
    this.modelId = cfg.model ?? DEFAULT_MODEL;
    this.#granularity = granularity;
  }

  async call(blocks: Block[], userMessage: string): Promise<ModelResponse> {
    const key = this.#cfg.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (key === undefined || key === "") {
      throw new Error("ANTHROPIC_API_KEY not set — AnthropicProvider is bring-your-own-key");
    }

    const head = blocks.filter((b) => b.zone === "identity" || b.zone === "foundational");
    const tail = blocks.filter((b) => b.zone !== "identity" && b.zone !== "foundational");

    const systemParts: string[] = [];
    if (this.#cfg.systemPrefix !== undefined) systemParts.push(this.#cfg.systemPrefix);
    for (const b of head) systemParts.push(b.text);
    const system = systemParts.join("\n\n");

    const tailText = tail.map((b) => b.text).join("\n\n");
    const userTurn = tailText !== "" ? tailText + "\n\n## CURRENT REQUEST\n" + userMessage : userMessage;

    const body = {
      model: this.modelId,
      max_tokens: this.#cfg.maxTokens ?? 2048,
      system: this.#cacheControlled(system, head),
      messages: [{ role: "user", content: this.#cacheControlled(userTurn, tail) }],
    };

    const res = await fetch((this.#cfg.baseUrl ?? DEFAULT_BASE) + "/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`anthropic ${res.status}: ${text.slice(0, 300)}`);
    }

    const json = (await res.json()) as AnthropicResponse;
    const text = json.content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text!)
      .join("\n");

    // A3: input_tokens is the true context length; cache counters pass through raw.
    const usage: UsageReport = {
      inputTokens: json.usage.input_tokens,
      outputTokens: json.usage.output_tokens,
      raw: json.usage,
    };
    if (json.usage.cache_read_input_tokens !== undefined) usage.cacheReadTokens = json.usage.cache_read_input_tokens;
    if (json.usage.cache_creation_input_tokens !== undefined) usage.cacheWriteTokens = json.usage.cache_creation_input_tokens;

    const stop: ModelResponse["stopReason"] =
      json.stop_reason === "max_tokens" ? "max_tokens"
      : json.stop_reason === "refusal" ? "abuse"
      : "end_turn";

    return { text, usage, stopReason: stop };
  }

  /**
   * Attach cache_control to the trailing content block when the segment
   * clears provider granularity. Segments under granularity are left bare —
   * a marker there would never be honored and only adds bookkeeping noise.
   */
  #cacheControlled(text: string, blocks: Block[]): Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> {
    const out: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> = [
      { type: "text", text },
    ];
    const estTokens = Math.ceil(text.length / 4);
    const smallest = Math.min(...blocks.map((b) => b.tokens), estTokens);
    if (smallest >= this.#granularity) {
      out[0]!.cache_control = { type: "ephemeral" };
    }
    return out;
  }
}
