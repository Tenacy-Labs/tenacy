import { test, expect } from "bun:test";
import { client, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

// Drive the shipped executable through the official SDK, with no model keys.
test("ACP stdio negotiates, isolates sessions, validates requests, and shuts down", async () => {
  const child = Bun.spawn([process.execPath, "src/acp/stdio.ts", "mock"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const updates: Array<{ sessionId: string; text: string }> = [];
  const connection = client({ name: "tenacy-test" })
    .onNotification("session/update", ({ params }) => {
      if (params.update.sessionUpdate === "agent_message_chunk" && params.update.content.type === "text") {
        updates.push({ sessionId: params.sessionId, text: params.update.content.text });
      }
    }).connect(ndJsonStream(new WritableStream<Uint8Array>({
      write(chunk) { child.stdin.write(chunk); child.stdin.flush(); },
      close() { child.stdin.end(); },
    }), child.stdout));
  try {
    const ctx = connection.agent;
    const init = await ctx.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(init.agentCapabilities?.loadSession).toBe(false);
    const a = await ctx.request("session/new", { cwd: process.cwd(), mcpServers: [] });
    const b = await ctx.request("session/new", { cwd: process.cwd(), mcpServers: [] });
    expect(a.sessionId).not.toBe(b.sessionId);
    const results = await Promise.all([a, b].map((s, i) => ctx.request("session/prompt", {
      sessionId: s.sessionId, prompt: [{ type: "text", text: `unique-${i}` }],
    })));
    expect(results.map((r) => r.stopReason)).toEqual(["end_turn", "end_turn"]);
    expect(updates.find((u) => u.sessionId === a.sessionId)?.text).toContain("unique-0");
    expect(updates.find((u) => u.sessionId === b.sessionId)?.text).toContain("unique-1");
    expect((await ctx.request("session/prompt", { sessionId: a.sessionId, prompt: [{ type: "text", text: "follow-up" }] })).stopReason).toBe("end_turn");
    await expect(ctx.request("session/prompt", { sessionId: "missing", prompt: [] })).rejects.toMatchObject({ code: -32602 });
    await expect(ctx.request("session/prompt", { sessionId: a.sessionId, prompt: [{ type: "image", data: "", mimeType: "image/png" }] })).rejects.toMatchObject({ code: -32602 });
    await expect(ctx.request("session/new", { cwd: "relative", mcpServers: [] })).rejects.toMatchObject({ code: -32602 });
    await expect(ctx.request("session/new", { cwd: process.cwd(), mcpServers: [{ name: "unsupported", command: "x", args: [], env: [] }] })).rejects.toMatchObject({ code: -32602 });
    await ctx.notify("session/cancel", { sessionId: a.sessionId });
    child.stdin.end();
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
  } finally {
    await connection.close();
    child.kill();
  }
}, 15000);

import { untilCancelled } from "../src/acp/cancellation.ts";
import { AgentLoop } from "../src/optimizer/loop.ts";
import { MockProvider, type ModelResponse } from "../src/optimizer/providers.ts";
import { loadHarnessConfig, paramSetFor } from "../src/optimizer/harness-config.ts";

test("cancellation prevents late model tool intents and permits another turn", async () => {
  const mock = new MockProvider();
  const controller = new AbortController();
  let finish!: (value: ModelResponse) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let first = true;
  const loop = new AgentLoop({
    modelId: mock.modelId,
    call: (blocks, text) => {
      if (!first) return mock.call(blocks, text);
      first = false;
      return untilCancelled(() => new Promise<ModelResponse>((resolve) => { finish = resolve; started(); }), controller.signal);
    },
  }, paramSetFor(mock.modelId, loadHarnessConfig()));
  const turn = loop.run("cancel me");
  await ready;
  controller.abort();
  await expect(turn).rejects.toThrow("cancelled");
  finish({ ...(await mock.call([], "late")), intents: [{ op: "goals.set", id: "late-goal", text: "must not run" }] });
  await Promise.resolve();
  expect(loop.goalItem("late-goal")).toBeUndefined();
  expect((await loop.run("next turn")).modelText).toContain("next turn");
});
