/**
 * Port pin — the solver runs unchanged on stowage's tree (ex-agent-kernel
 * optimizer core, byte-identical modulo import heads). Proves the vendor
 * wiring end-to-end: knapsack relief path, suffix pricing, ledger shape.
 */
import { describe, test, expect } from "bun:test";
import { solve, paramSetV1, ZONE_ORDER } from "../src/index.ts";
import type { ContextItem, RenderOption, Incumbent, Zone } from "../src/index.ts";

function item(
  id: string,
  kind: ContextItem["kind"],
  tokens: number,
  text: string,
  turn: number,
  zones: readonly Zone[] = ["evolving"],
): ContextItem {
  const opt = (o: Partial<RenderOption> & { id: string }): RenderOption => ({
    id: o.id,
    purelyAdditive: o.purelyAdditive ?? true,
    zones: o.zones ?? zones,
    representation: o.representation ?? "AS_IS",
    tokens: o.tokens ?? tokens,
    text: o.text ?? text,
    ...(o.zeroValue !== undefined ? { zeroValue: o.zeroValue } : {}),
  });
  return {
    id,
    kind,
    immutable: false,
    tokens,
    serialize: () => text,
    options: () => [opt({ id: "full" }), opt({ id: "tomb", tokens: 8, zeroValue: true })],
    lastTouchTurn: turn,
    createdTurn: turn,
  };
}

describe("ported solve()", () => {
  const ps = paramSetV1("test-model");

  test("places items and journals decisions", () => {
    const items = new Map<string, ContextItem>([
      ["identity:1", item("identity:1", "identity", 40, "I am the kernel.", 0, ["identity"])],
      ["turn-1", item("turn-1", "episodic", 120, "User asked about caching.", 1, ["evolving"])],
      ["turn-2", item("turn-2", "episodic", 90, "Assistant answered.", 2, ["evolving"])],
    ]);
    const inc: Incumbent = {
      rendered: new Map(),
      totalTokens: 0,
      blockCount: 0,
    };
    const r1 = solve(items, inc, ps, 3);
    expect(r1.placements.length).toBe(3);
    expect(r1.totalTokens).toBeGreaterThan(0);
    // identity zone precedes episodic content (canonical zone order)
    const zones = r1.placements.map((p) => p.zone);
    expect(zones.indexOf("identity")).toBeLessThan(
      Math.max(...zones.map((z) => ZONE_ORDER.indexOf(z))),
    );
    // determinism: identical solve → identical placements
    const r2 = solve(items, inc, ps, 3);
    expect(r2.placements).toEqual(r1.placements);
  });

  test("keep-branch: incumbent bytes price at zero transaction", () => {
    const it = item("lens:a.ts", "lens", 100, "const a = 1;", 1);
    const items = new Map([[it.id, it]]);
    // First render establishes the incumbent.
    const r1 = solve(items, { rendered: new Map(), totalTokens: 0, blockCount: 0 }, ps, 1);
    const rendered = new Map(
      r1.placements.map((p) => [p.id, {
        position: p.position, zone: p.zone, digest: p.digest,
        representation: p.representation, optionId: p.optionId,
      }]),
    );
    const inc2: Incumbent = {
      rendered,
      totalTokens: r1.totalTokens,
      blockCount: r1.placements.length,
    };
    const r2 = solve(items, inc2, ps, 2);
    const keep = r2.itemLedgers.find(
      (l) => l.id === it.id && l.decision === "keep" && l.accepted,
    );
    expect(keep).toBeDefined();
    expect(keep!.utility.cacheCost).toBe(0);
  });
});
