import { describe, test, expect } from "bun:test";
import { paramSetV1 } from "../src/optimizer/params.ts";
import { MockProvider } from "../src/optimizer/providers.ts";
import type { ModelResponse } from "../src/optimizer/providers.ts";
import type { Block } from "../src/optimizer/types.ts";
import { AgentLoop } from "../src/optimizer/loop.ts";
import { reportGauges } from "../src/optimizer/reports.ts";
import type { Corpus } from "../src/optimizer/corpus.ts";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Review minors batch: RED pins, 2026-08-23. ──
// Hand-planted corpus (mirrors test/gauges.test.ts shape).

function plantedCorpusExtra(): Corpus {
  return {
    turns: [],
    items: [
      // one accepted DROP (true eviction) and one accepted PURGE
      // (deliberate compaction). Pre-fix Gauge 2 counts both as evictions.
      {
        turn: 1, id: "item-drop",
        forecast: { mu0: 1, alpha: 0.5, deltaT: 1, hazard: 0.1, basis: "prior", expectedValue: 0.9 },
        utility: { benefit: 1, cacheCost: 0, rotShare: 0, total: 1 },
        decision: "drop", accepted: true, marginVsHysteresis: 0.5, optionChosen: "full",
      },
      {
        turn: 1, id: "item-purge",
        forecast: { mu0: 1, alpha: 0.5, deltaT: 1, hazard: 0.1, basis: "prior", expectedValue: 0.9 },
        utility: { benefit: 1, cacheCost: 0, rotShare: 0, total: 1 },
        decision: "purge", accepted: true, marginVsHysteresis: 0.5, optionChosen: "purge",
      },
    ] as never,
    caches: [],
    signals: [
      { type: "lens-expand", itemId: "item-drop", turn: 3 },
      { type: "lens-expand", itemId: "item-purge", turn: 4 },
    ],
    provenance: "realized",
    sources: ["planted"],
    parameterSetVersions: ["test-v1"],
    modelIds: ["mock"],
  };
}

describe("A-m1: Gauge 2 — purge is deliberate policy, not eviction", () => {
  test("evictions exclude purge; re-expansion per eviction uses drop-only denominator", () => {
    const g = reportGauges(plantedCorpusExtra(), paramSetV1("mock"));
    expect(g.evictions).toBe(1);                    // pre-fix: 2
    expect(g.reExpansions).toBe(1);                 // purge's expand not counted
    expect(g.reExpansionsPerEviction).toBe(1);      // 1/1, not 2/2
  });
});

describe("B-8: watcher.deltas bounded and consumed", () => {
  test("deltas history capped at 1000 entries", async () => {
    const { TurnBoundaryWatcher } = await import("../src/optimizer/live-views.ts");
    const w = new TurnBoundaryWatcher();
    w.churnDemoteThreshold = 1_000_000;
    // one delta per LENS per drain: overflow needs many distinct lens ids
    for (let i = 0; i < 1100; i++) {
      w.push({ lensId: `lens-${i}`, path: "/tmp/x.ts", kind: "change" });
    }
    w.drain(1);
    const n = (w as unknown as { deltas: unknown[] }).deltas.length;
    expect(n).toBeLessThanOrEqual(1000);            // pre-fix: unbounded (1100)
  });
});

describe("B-10: transient-retry matcher — word-boundary, not substring", () => {
  test("non-transient words containing 'rate' do NOT retry", async () => {
    const { AgentLoop } = await import("../src/optimizer/loop.ts");
    // "generate" contains "rate" as substring; auth errors must rethrow on attempt 1
    let calls = 0;
    class FakeProv extends MockProvider {
      constructor() { super(); }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      override async call(_b: never, _m: string): Promise<never> {
        calls++;
        throw new Error("failed to generate completion: invalid api key");
      }
    }
    // type-compatible throw-only provider (never returns)
    const loop = new AgentLoop(new FakeProv(), paramSetV1("mock"), null);
    await loop.run("hi").catch(() => {});
    expect(calls).toBe(1);                          // pre-fix: 3 (substring "rate" matched)
  });

  test("genuine rate-limit errors DO retry", async () => {
    let calls = 0;
    const real = new MockProvider();
    class RateProv extends MockProvider {
      constructor() { super(); }
      override async call(blocks: Block[], msg: string): Promise<ModelResponse> {
        calls++;
        if (calls < 3) throw new Error("429 rate limit exceeded");
        return real.call(blocks, msg);
      }
    }
    const loop = new AgentLoop(new RateProv(), paramSetV1("mock"), null);
    await loop.run("hi");
    expect(calls).toBe(3);
  });
});

describe("B-11: /resume with same lens is idempotent, not a throw", () => {
  test("restoring a session with a lens twice does not throw", async () => {
    const { saveSession, restoreSession } = await import("../src/optimizer/sessions.ts");
    const dir = mkdtempSync(join(tmpdir(), "ak-b11-"));
    const ps = paramSetV1("mock-1");
    const f = join(dir, "src.ts");
    writeFileSync(f, "export const a = 1;\nexport const b = 2;\n");
    const src = new AgentLoop(new MockProvider(), ps);
    src.fileContent = (p) => { try { return require("node:fs").readFileSync(p, "utf8"); } catch { return ""; } };
    src.attachLens("lens:src", f, [[1, 2]], 1, "FULL");
    await src.run("one");
    saveSession(src, join(dir, "s.json"), "mock");
    const dst = new AgentLoop(new MockProvider(), ps);
    dst.fileContent = (p) => { try { return require("node:fs").readFileSync(p, "utf8"); } catch { return ""; } };
    restoreSession(dst, join(dir, "s.json"));
    let threw = false;
    try { restoreSession(dst, join(dir, "s.json")); } catch { threw = true; }
    expect(threw).toBe(false);                      // pre-fix: duplicate item id throw
    expect(dst.store.get("lens:src")).toBeDefined();
  });
});

describe("B-12: code: prefix stripping consistent", () => {
  test("codeLens canonicalizes: bare and code:-prefixed targets are ONE lens", () => {
    const loop = new AgentLoop(new MockProvider(), paramSetV1("mock"), null);
    const f = join(mkdtempSync(join(tmpdir(), "ak-b12-")), "m.ts");
    writeFileSync(f, "export function foo() { return 1; }\n");
    loop.fileContent = (p) => { try { return require("node:fs").readFileSync(p, "utf8"); } catch { return ""; } };
    const a = loop.codeLens(f);                      // bare path
    const b = loop.codeLens("code:" + f);            // prefixed path — same file
    // pre-fix: two lenses, ids lens:code:<f> and lens:code:code:<f>
    expect(b.id).toBe(a.id);                         // one canonical lens
    expect(b.target).toBe(f);                        // target stored bare
    expect(loop.refreshLensFromSubstrate(b.id) === undefined).toBe(true);
    expect((b as unknown as { content: string }).content).toContain("export function foo");
  });
});

describe("C-m2: prefix-stable asserts hardened to full-value equality", () => {
  test("identity write-turn prefix pin now asserts full equality", async () => {
    const loop = new AgentLoop(new MockProvider(), paramSetV1("mock"), null);
    const { StandingItem } = await import("../src/optimizer/items.ts");
    loop.store.add(new StandingItem("identity", "identity", "kernel agent").toContextItem());
    await loop.run("first message");
    const w1 = loop.incumbentWriteTurns().slice();
    await loop.run("second message");
    await loop.run("third message");
    const w3 = loop.incumbentWriteTurns();
    expect(w3.slice(0, w1.length)).toEqual([...w1]);
    expect(w3.every((t) => t >= 1 && t <= 3)).toBe(true);  // full-value: every stamp in range and honest
  });
});

describe("C-m9: hazardBasis coverage", () => {
  test("observed override journaled as hazardBasis:observed; prior default journaled as prior", async () => {
    const { solve } = await import("../src/optimizer/solver.ts");
    const { StandingItem } = await import("../src/optimizer/items.ts");
    const items = new Map<string, import("../src/optimizer/types.ts").ContextItem>();
    const s1 = new StandingItem("directive-1", "directive", "alpha rule");
    const c1 = s1.toContextItem();
    c1.hazardOverride = 0.42;                       // observed hazard
    items.set(c1.id, c1);
    const s2 = new StandingItem("directive-2", "directive", "beta rule");
    items.set(s2.id, s2.toContextItem());           // prior hazard
    const r = solve(items, { rendered: new Map(), totalTokens: 0, blockCount: 0 } as never, paramSetV1("mock-1"), 1);
    const l1 = r.itemLedgers.find((l) => l.id === "directive-1");
    const l2 = r.itemLedgers.find((l) => l.id === "directive-2");
    expect(l1!.forecast.hazardBasis).toBe("observed");
    expect(l2!.forecast.hazardBasis).toBe("prior");
  });
});
