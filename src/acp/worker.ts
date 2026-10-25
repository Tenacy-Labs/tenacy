import { parentPort, workerData } from "node:worker_threads";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { AgentLoop } from "../optimizer/loop.ts";
import { MockProvider, type Provider, type ModelResponse } from "../optimizer/providers.ts";
import { loadHarnessConfig, paramSetFor } from "../optimizer/harness-config.ts";
import { StandingItem } from "../optimizer/items.ts";
import { TOOL_PROTOCOL_DOC } from "../optimizer/tools.ts";
import { untilCancelled } from "./cancellation.ts";
import type { WorkerReply } from "./session.ts";

const { cwd, provider, model } = workerData as { cwd: string; provider: string; model?: string };
const inner = provider === "mock" ? new MockProvider() : (await import("../optimizer/registry.ts")).buildProvider(provider, model ? { model } : {});
let active: AbortController | undefined;
let stopReason: ModelResponse["stopReason"] = "end_turn";
// Cancel at the model boundary. Late provider results cannot apply tool intents.
// The provider API has no abort parameter; its network request may finish later.
const cancellable: Provider = {
  modelId: inner.modelId,
  async call(blocks, message) {
    const signal = active!.signal;
    signal.throwIfAborted();
    const response = await untilCancelled(() => inner.call(blocks, message), signal);
    signal.throwIfAborted();
    stopReason = response.stopReason;
    return response;
  },
};
const loop = new AgentLoop(cancellable, paramSetFor(inner.modelId, loadHarnessConfig()));
loop.store.add(new StandingItem("identity", "identity", "You are the Tenacy agent. " + TOOL_PROTOCOL_DOC).toContextItem());
loop.fileContent = (target) => readFileSync(resolve(cwd, target), "utf8");
loop.dirListing = (target) => readdirSync(resolve(cwd, target)).sort().join("\n");

parentPort!.on("message", async (message: { type: "prompt"; text: string } | { type: "cancel" }) => {
  if (message.type === "cancel") { active?.abort(); return; }
  active = new AbortController();
  let reply: WorkerReply;
  try {
    const out = await loop.run(message.text);
    reply = { result: { text: out.modelText, tools: out.toolResults, stopReason: stopReason === "abuse" ? "refusal" : stopReason } };
  } catch (error) {
    reply = active.signal.aborted
      ? { result: { text: "", tools: [], stopReason: "cancelled" } }
      : { error: String(error) };
  } finally {
    active = undefined;
  }
  parentPort!.postMessage(reply);
});
