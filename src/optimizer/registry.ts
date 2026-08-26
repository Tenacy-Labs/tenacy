/**
 * Provider registry — wide-array wiring over the Vercel AI SDK (`ai` v7).
 *
 * Direct packages: openai, anthropic, xai (grok). `@ai-sdk/openai-compatible`
 * covers everything speaking the OpenAI protocol: z.ai (GLM Coding Plan,
 * endpoint https://api.z.ai/api/coding/paas/v4), deepseek, qwen, openrouter,
 * and any custom base URL. Keys from env only. Usage is honest per A3:
 * input tokens read directly; cache counters passed as-is or unreported —
 * never fabricated.
 */
import { generateText, stepCountIs } from "ai";
import type { LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createXai } from "@ai-sdk/xai";
import { intentTools, intentsFromToolCalls } from "./tools.ts";
import type { ModelResponse, Provider } from "./providers.ts";
import type { SteeringIntent } from "./intents.ts";
import { PrefixCacheSim } from "./providers.ts";
import type { Block } from "./types.ts";
import type { UsageReport } from "./cache-model.ts";
import { loadHarnessConfig, paramSetFor } from "./harness-config.ts";
export { loadHarnessConfig, paramSetFor };
export type { HarnessConfig, HarnessProviderConfig } from "./harness-config.ts";

export interface ProviderSpec {
  name: string;
  defaultModel: string;
  envKey: string;
  build: (cfg: { apiKey: string; model: string; baseUrl?: string | undefined }) => ProviderWire;
}

export interface WireResult {
  text: string;
  usage: { input?: number | undefined; output?: number | undefined; cacheRead?: number | undefined; cacheWrite?: number | undefined };
  stopReason: string;
  /** Model-proposed intents from native tool calls (proposer/applier split:
   *  the SDK proposes; the coordinator applies). */
  toolCalls?: ReadonlyArray<{ toolName: string; input: unknown }>;
}

export type ProviderWire = (system: string, user: string) => Promise<WireResult>;

/** One generic adapter: AI SDK LanguageModel → kernel Provider contract.
 *  Intent ops are exposed as native tools (2026-08-26 ruling — fenced blocks
 *  retired). stopWhen: stepCountIs(1) keeps execution at the coordinator. */
export function wireModel(modelId: string, m: LanguageModel): ProviderWire {
  return async (system, user) => {
    const r = await generateText({
      model: m,
      system,
      prompt: user,
      tools: intentTools(),
      stopWhen: stepCountIs(1),
    });
    return {
      text: r.text,
      usage: {
        input: r.usage.inputTokens,
        output: r.usage.outputTokens,
        cacheRead: r.usage.inputTokenDetails?.cacheReadTokens,
        cacheWrite: r.usage.inputTokenDetails?.cacheWriteTokens,
      },
      stopReason: r.finishReason,
      toolCalls: r.toolCalls.map((c) => ({ toolName: c.toolName, input: c.input })),
    };
  };
}

/** Adapt a wire into the kernel Provider contract (zones → system/user split). */
export function providerFromWire(modelId: string, wire: ProviderWire): Provider {
  const sim = new PrefixCacheSim();
  return {
    modelId,
    call: async (blocks: Block[], userMessage: string): Promise<ModelResponse> => {
      const head = blocks.filter((b) => b.zone === "identity" || b.zone === "foundational");
      const tail = blocks.filter((b) => b.zone !== "identity" && b.zone !== "foundational");
      const system = head.map((b) => b.text).join("\n\n");
      const tailText = tail.map((b) => b.text).join("\n\n");
      const userTurn = tailText !== "" ? tailText + "\n\n## CURRENT REQUEST\n" + userMessage : userMessage;

      const out = await wire(system, userTurn);

      const usage: UsageReport = {
        inputTokens: out.usage.input ?? Math.ceil((system.length + userTurn.length) / 4),
        outputTokens: out.usage.output ?? Math.ceil(out.text.length / 4),
        raw: out.usage,
      };
      if (out.usage.cacheRead !== undefined) usage.cacheReadTokens = out.usage.cacheRead;
      if (out.usage.cacheWrite !== undefined) usage.cacheWriteTokens = out.usage.cacheWrite;

      const stop: ModelResponse["stopReason"] =
        out.stopReason === "length" ? "max_tokens"
        : out.stopReason === "content-filter" ? "abuse"
        : "end_turn";

      sim.commit(blocks);
      // Native tool calls become model-proposed intents (the coordinator
      // applies them after the reply — proposer/applier split).
      const intents = out.toolCalls !== undefined && out.toolCalls.length > 0
        ? intentsFromToolCalls(out.toolCalls)
        : undefined;
      return { text: out.text, usage, stopReason: stop, intents };
    },
  };
}

export const REGISTRY: Record<string, ProviderSpec> = {
  openai: {
    name: "openai",
    defaultModel: "gpt-5.1",
    envKey: "OPENAI_API_KEY",
    build: ({ apiKey, model }) => wireModel(model, createOpenAI({ apiKey })(model)),
  },
  zai: {
    name: "zai",
    defaultModel: "glm-4.7",
    envKey: "ZAI_API_KEY",
    build: ({ apiKey, model, baseUrl }) => wireModel(
      model,
      createOpenAICompatible({
        name: "zai",
        baseURL: baseUrl ?? "https://api.z.ai/api/coding/paas/v4",
        apiKey,
      }).chatModel(model),
    ),
  },
  grok: {
    name: "grok",
    defaultModel: "grok-4",
    envKey: "XAI_API_KEY",
    build: ({ apiKey, model }) => wireModel(model, createXai({ apiKey })(model)),
  },
  openrouter: {
    name: "openrouter",
    defaultModel: "anthropic/claude-sonnet-4.5",
    envKey: "OPENROUTER_API_KEY",
    build: ({ apiKey, model, baseUrl }) => wireModel(
      model,
      createOpenAICompatible({
        name: "openrouter",
        baseURL: baseUrl ?? "https://openrouter.ai/api/v1",
        apiKey,
      }).chatModel(model),
    ),
  },
  anthropic: {
    name: "anthropic",
    defaultModel: "claude-sonnet-4-5",
    envKey: "ANTHROPIC_API_KEY",
    build: ({ apiKey, model }) => wireModel(model, createAnthropic({ apiKey })(model)),
  },
  deepseek: {
    name: "deepseek",
    defaultModel: "deepseek-chat",
    envKey: "DEEPSEEK_API_KEY",
    build: ({ apiKey, model, baseUrl }) => wireModel(
      model,
      createOpenAICompatible({
        name: "deepseek",
        baseURL: baseUrl ?? "https://api.deepseek.com/v1",
        apiKey,
      }).chatModel(model),
    ),
  },
  qwen: {
    name: "qwen",
    defaultModel: "qwen-max",
    envKey: "QWEN_API_KEY",
    build: ({ apiKey, model, baseUrl }) => wireModel(
      model,
      createOpenAICompatible({
        name: "qwen",
        baseURL: baseUrl ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
        apiKey,
      }).chatModel(model),
    ),
  },
  generic: {
    name: "generic",
    defaultModel: "custom",
    envKey: "GENERIC_API_KEY",
    build: ({ apiKey, model, baseUrl }) => wireModel(
      model,
      createOpenAICompatible({
        name: "generic",
        baseURL: baseUrl ?? "http://localhost:8000/v1",
        apiKey,
      }).chatModel(model),
    ),
  },
};

/** Build a Provider by registry name; throws honestly when the key is absent. */
export function buildProvider(
  name: string,
  opts: { model?: string; baseUrl?: string; apiKey?: string } = {},
): Provider {
  const spec = REGISTRY[name];
  if (spec === undefined) {
    throw new Error(`unknown provider "${name}" — registered: ${Object.keys(REGISTRY).join(", ")}`);
  }
  // credential resolution: explicit > env > harness config file (gitignored)
  const cfg = loadHarnessConfig();
  const cfgProvider = cfg?.providers[name];
  // Empty-string env vars must not mask the config file (review finding B2):
  // "" is defined, so ?? keeps it; treat blank as unset at every tier.
  const envKey = process.env[spec.envKey];
  const optKey = opts.apiKey;
  const apiKey =
    (optKey !== undefined && optKey !== "" ? optKey : undefined) ??
    (envKey !== undefined && envKey !== "" ? envKey : undefined) ??
    cfgProvider?.apiKey ??
    "";
  if (apiKey === "") {
    throw new Error(`${spec.envKey} not set and no harness config entry for "${name}" — bring-your-own-key`);
  }
  const model = (opts.model !== undefined && opts.model !== "" ? opts.model : undefined)
    ?? (cfgProvider?.model !== undefined && cfgProvider?.model !== "" ? cfgProvider.model : undefined)
    ?? spec.defaultModel;
  const baseUrl = opts.baseUrl ?? cfgProvider?.baseUrl;
  return providerFromWire(model, spec.build({ apiKey, model, baseUrl }));
}

/** Which providers have keys present (UI listing) — never returns keys. */
export function availableProviders(): string[] {
  const cfg = loadHarnessConfig();
  return Object.values(REGISTRY)
    .filter((s) => (process.env[s.envKey] ?? "") !== "" || (cfg?.providers[s.name]?.apiKey ?? "") !== "")
    .map((s) => s.name);
}
