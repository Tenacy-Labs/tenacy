/**
 * Native tool-calling surface tests (2026-08-26 ruling: fenced-block
 * intents retired; SDK tools are the only intent path).
 *
 * End-to-end: MockLanguageModelV3 emits a native tool-call part →
 * generateText (with intentTools + stepCountIs(1)) → wireModel →
 * providerFromWire → the kernel Provider contract receives structured
 * intents. Unknown tool names are dropped honestly.
 */
import { describe, expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { wireModel, providerFromWire } from "../src/optimizer/registry.ts";
import { intentTools, intentsFromToolCalls, opToToolName, toolNameToOp } from "../src/optimizer/tools.ts";

describe("intent tool surface", () => {
  test("op ↔ tool-name mapping is bijective over the op vocabulary", () => {
    const tools = intentTools();
    const names = Object.keys(tools);
    for (const n of names) {
      expect(opToToolName(toolNameToOp(n))).toBe(n);
      expect(n).toMatch(/^[a-zA-Z0-9_]+$/);
    }
    expect(names.length).toBeGreaterThan(30);
  });

  test("intentsFromToolCalls: known ops pass through, unknown dropped, non-object input dropped", () => {
    const out = intentsFromToolCalls([
      { toolName: "files_expand", input: { target: "notes.txt", from: 1, to: 40 } },
      { toolName: "no_such_tool", input: { x: 1 } },
      { toolName: "say", input: null },
      { toolName: "goals_set", input: { id: "g1", text: "verify" } },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ op: "files.expand", target: "notes.txt", from: 1, to: 40 });
    expect(out[1]).toEqual({ op: "goals.set", id: "g1", text: "verify" });
  });

  test("wire: native tool call flows through generateText into the kernel Provider contract", async () => {
    const mock = new MockLanguageModelV3({
      doGenerate: async () => ({
        finishReason: { unified: "tool-calls" as const, raw: undefined },
        usage: { inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 20, text: 20, reasoning: undefined }, totalUsage: undefined },
        warnings: [],
        content: [
          { type: "text" as const, text: "Pulling the first chunk." },
          {
            type: "tool-call" as const,
            toolCallId: "call-1",
            toolName: "files_expand",
            input: JSON.stringify({ target: "notes.txt", from: 180, to: 195 }),
          },
        ],
      }),
    });
    const provider = providerFromWire("mock-native", wireModel("mock-native", mock));
    const res = await provider.call(
      [{ digest: "d1", tokens: 10, text: "identity", itemId: "identity", zone: "identity" }],
      "find the launch code",
    );
    expect(res.text).toBe("Pulling the first chunk.");
    expect(res.intents).toEqual([{ op: "files.expand", target: "notes.txt", from: 180, to: 195 }]);
    expect(res.stopReason).toBe("end_turn"); // tool-calls is not a terminal kernel stop reason
  });

  test("wire: plain text reply carries no intents", async () => {
    const mock = new MockLanguageModelV3({
      doGenerate: async () => ({
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: { inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 10, text: 10, reasoning: undefined }, totalUsage: undefined },
        warnings: [],
        content: [{ type: "text" as const, text: "All done." }],
      }),
    });
    const provider = providerFromWire("mock-native", wireModel("mock-native", mock));
    const res = await provider.call(
      [{ digest: "d1", tokens: 10, text: "identity", itemId: "identity", zone: "identity" }],
      "hello",
    );
    expect(res.text).toBe("All done.");
    expect(res.intents).toBeUndefined();
  });
});
