/**
 * Startup cache probe tests — keyless, fake wires.
 */
import { describe, expect, test } from "bun:test";
import { probeToolsCache } from "../src/optimizer/probe.ts";
import type { ProviderWire, WireResult } from "../src/optimizer/registry.ts";

function fakeWire(cacheReads: number[]): ProviderWire {
  let i = 0;
  return async (): Promise<WireResult> => ({
    text: "ok",
    usage: { input: 10, output: 1, cacheRead: cacheReads[Math.min(i++, cacheReads.length - 1)] },
    stopReason: "stop",
  });
}

describe("startup cache probe", () => {
  test("tools in cached prefix: warm delta >= threshold", async () => {
    const r = await probeToolsCache("fake", fakeWire([0, 2368]), fakeWire([0, 0]), { toolTokens: 2101 });
    expect(r.toolsCached).toBe(true);
    expect(r.hitWithTools).toBe(2368);
    expect(r.hitWithout).toBe(0);
    expect(r.delta).toBe(2368);
  });

  test("tools NOT cached: warm deltas equal", async () => {
    const r = await probeToolsCache("fake", fakeWire([0, 120]), fakeWire([0, 120]), { toolTokens: 2101 });
    expect(r.toolsCached).toBe(false);
    expect(r.delta).toBe(0);
  });

  test("unreported counters are inconclusive, never guessed", async () => {
    const noReport: ProviderWire = async () => ({
      text: "ok", usage: { input: 10, output: 1 }, stopReason: "stop",
    });
    const r = await probeToolsCache("fake", noReport, noReport, { toolTokens: 2101 });
    expect(r.toolsCached).toBeNull();
    expect(r.note).toContain("inconclusive");
  });

  test("wire failure on a leg returns partial with note", async () => {
    const failing: ProviderWire = async () => { throw new Error("boom"); };
    const r = await probeToolsCache("fake", failing, fakeWire([0, 0]), { toolTokens: 2101 });
    expect(r.toolsCached).toBeNull();
    expect(r.note).toContain("with-tools leg failed");
  });
});
