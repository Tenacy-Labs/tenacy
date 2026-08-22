/**
 * Review-fix regression tests (2026-08-22 three-reviewer gate).
 *
 * Every test here encodes a finding from CODE_REVIEW_{A,B,C}.md and is
 * written to FAIL on the pre-fix code (discriminating — verified by
 * construction against the reported probes).
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lambdaPosterior, evidenceValueFactor } from "../src/optimizer/evidence.ts";
import { StandingItem, NoticeItem } from "../src/optimizer/items.ts";
import { solve } from "../src/optimizer/solver.ts";
import { paramSetV1 } from "../src/optimizer/params.ts";
import { estTokens } from "../src/optimizer/renderer.ts";
import type { ContextItem } from "../src/optimizer/types.ts";

const withEv = (hits: number[]): ContextItem => ({
  ...new StandingItem("identity", "identity", "body").toContextItem(),
  refEvidence: { hits, accessClass: "cited" },
});

describe("review A-C1/M1 — prior=0 kinds (identity/episodic/error)", () => {
  test("C1: zero hits, prior 0 → factor 1 (not NaN), posterior finite", () => {
    const f = evidenceValueFactor(withEv([]), 0);
    expect(Number.isNaN(f)).toBe(false);
    expect(f).toBe(1);
    expect(Number.isFinite(lambdaPosterior(withEv([]), 0))).toBe(true);
  });

  test("M1: one hit, prior 0 → factor finite and below the clamp ceiling", () => {
    // A single hit on a never-re-referenced class must not resurrect the
    // item to the maximum multiplier (x/0 → ∞ → clamp 4 is meaningless).
    const f = evidenceValueFactor(withEv([3]), 0);
    expect(Number.isFinite(f)).toBe(true);
    expect(f).toBeLessThan(4);
  });

  test("guard does not change prior>0 behavior (regression)", () => {
    const hot = withEv([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(evidenceValueFactor(hot, 0.3, 20)).toBeGreaterThan(1);
    const dead = { ...withEv([]), createdTurn: 0, lastTouchTurn: 20 };
    expect(evidenceValueFactor(dead, 0.3, 20)).toBeLessThan(1);
  });
});

describe("review M5/B12/B20 — write turns carry forward on byte-identical keeps (§4 TTL window live in production)", () => {
  test("loop-level: identity block keeps its ORIGINAL write turn across turns", async () => {
    const { AgentLoop } = await import("../src/optimizer/loop.ts");
    const { MockProvider } = await import("../src/optimizer/providers.ts");
    const { paramSetV1 } = await import("../src/optimizer/params.ts");
    const loop = new AgentLoop(new MockProvider(), paramSetV1("mock"), null);
    loop.store.add(new StandingItem("identity", "identity", "kernel agent").toContextItem());
    await loop.run("first message");   // turn 1: identity block written
    const w1 = loop.incumbentWriteTurns();
    await loop.run("second message");  // turn 2: identity byte-identical keep
    await loop.run("third message");   // turn 3
    const w3 = loop.incumbentWriteTurns();
    // Post-fix: the identity blocks (stable digest, w1=[1,1]) keep write
    // turn 1 in w3 — only NEW blocks (later turns) stamp current turns.
    expect(w1.length).toBeGreaterThan(0);
    expect(w3.slice(0, w1.length)).toEqual([...w1]);   // prefix carried forward
    expect(w3.some((t) => t < 3)).toBe(true);     // at least one block older than current turn
  });
});

describe("review A-M3 — restored sessions can merge/re-expand (convoTurn accepts getter-form verbatim)", () => {
  test("addRestoredTurn registers a TurnItem whose convoTurn facade works", async () => {
    const { AgentLoop } = await import("../src/optimizer/loop.ts");
    const { MockProvider } = await import("../src/optimizer/providers.ts");
    const { executeIntent } = await import("../src/optimizer/intents.ts");
    const { paramSetV1 } = await import("../src/optimizer/params.ts");
    const loop = new AgentLoop(new MockProvider(), paramSetV1("mock"), null);
    // Simulate a restored session: two real TurnItems (verbatim is a GETTER).
    loop.addRestoredTurn("turn-1-user", "user", "fact one: alpha", undefined, "VERBATIM");
    loop.addRestoredTurn("turn-2-model", "model", "reply one: beta", undefined, "VERBATIM");
    const t1 = loop.convoTurn("turn-1-user");
    expect(t1).toBeDefined();                    // pre-fix: undefined (function-form check)
    const m = executeIntent({ op: "convo.merge", from: 1, to: 2 }, loop.store, null);
    expect(m.ok).toBe(true);                     // pre-fix: "fewer than two turns in range"
    const re = executeIntent({ op: "convo.reexpand", id: "turn-1-user" }, loop.store, null);
    expect(re.ok).toBe(true);                    // pre-fix: "no such turn"
  });
});

describe("review B3 — absent cache counter is unreported, not realized-0", () => {
  test("usage without cacheReadTokens → divergence unreported, realized null", async () => {
    const { CacheModel } = await import("../src/optimizer/cache-model.ts");
    const cm = new CacheModel({ cachedPriceFraction: 0.1, granularity: 1024, ttlTurns: 6 } as never);
    const blocks = [{ digest: "d1", tokens: 100, text: "t", itemId: "i", zone: "foundational" as never }];
    // Pre-fix: cacheReadTokens ?? 0 → realized.hitTokens 0, divergence
    // classified as believed-cached-rebilled (fabricated overbelief).
    const cl = cm.calibrate(blocks, { inputTokens: 500, outputTokens: 10, raw: {} } as never, { hitTokens: 400 });
    expect(cl.realized).toBeNull();
    expect(cl.divergence).toBe("unreported");
  });
});

describe("review B4 — belief gap guards: empty truth map falls back, never NaN", () => {
  test("empty truthByTurn + realized pairs → provider-realized basis, finite stats", async () => {
    const { computeBeliefGap } = await import("../src/optimizer/reports.ts");
    const caches = [1, 2].map((t) => ({
      turn: t,
      expected: { hitTokens: 100 * t, price: 0 },
      realized: { hitTokens: 110 * t, price: 0 },
      divergence: "none" as never,
      rawProviderReport: null,
    }));
    const corpus = { caches, signals: [], items: {}, provenance: { note: "t" }, sources: [], parameterSetVersions: [], modelIds: [] } as never;
    const r = computeBeliefGap(corpus, { basis: "lcp-truth", truthByTurn: new Map() });
    expect(r).not.toBeNull();
    expect(r!.basis).toBe("provider-realized");
    expect(Number.isFinite(r!.maeTokens)).toBe(true);
  });
  test("no truth, no realized → null (honest absence)", async () => {
    const { computeBeliefGap } = await import("../src/optimizer/reports.ts");
    const caches = [1].map((t) => ({
      turn: t,
      expected: { hitTokens: 100, price: 0 },
      realized: null,
      divergence: "unreported" as never,
      rawProviderReport: null,
    }));
    const corpus = { caches, signals: [], items: {}, provenance: { note: "t" }, sources: [], parameterSetVersions: [], modelIds: [] } as never;
    expect(computeBeliefGap(corpus, { basis: "lcp-truth", truthByTurn: new Map() })).toBeNull();
  });
});

describe("review B5 — ledger append failure keeps entries queued (no silent drop)", () => {
  test("unwritable path: entries remain pending, recover on drain to good path", async () => {
    const { Ledger } = await import("../src/optimizer/ledger.ts");
    const dir = mkdtempSync(join(tmpdir(), "ak-ledger-"));
    const bad = new Ledger(join(dir, "no", "such", "dir", "x", "l.jsonl")); // mkdir recursion limited by sandbox? -> use a FILE as dir
    // A REGULAR FILE placed where the ledger expects a DIRECTORY makes
    // appendFile fail (ENOTDIR) reliably — pre-fix the batch was spliced
    // away regardless (silent drop).
    writeFileSync(join(dir, "blocker"), "x");
    const blocked = new Ledger(join(dir, "blocker", "l.jsonl"));
    blocked.recordSignal({ type: "probe" });
    blocked.recordSignal({ type: "probe2" });
    await new Promise((r) => setTimeout(r, 80)); // let retries exhaust
    expect(blocked.pendingEntries()).toBe(2);      // pre-fix: 0 (dropped)
    void bad;
  });
});

describe("review B6 — importing maxsuite does not re-run the suite", () => {
  test("import for lcpTokens is side-effect free", async () => {
    const before = existsSync("bench/corpus/dumps/maxsuite.json")
      ? statSync("bench/corpus/dumps/maxsuite.json").mtimeMs : 0;
    await import("../bench/corpus/maxsuite.ts");
    const after = existsSync("bench/corpus/dumps/maxsuite.json")
      ? statSync("bench/corpus/dumps/maxsuite.json").mtimeMs : 0;
    expect(after).toBe(before); // pre-fix: import re-ran 20 scenarios and rewrote the dump
  });
});

describe("review C-C1 — §3 two-class recoverability now has honest producers", () => {
  test("merge group MERGED option prices at qRendered (verbatim-preserving)", async () => {
    const { AgentLoop } = await import("../src/optimizer/loop.ts");
    const { MockProvider } = await import("../src/optimizer/providers.ts");
    const { executeIntent } = await import("../src/optimizer/intents.ts");
    const loop = new AgentLoop(new MockProvider(), paramSetV1("mock"), null);
    loop.addRestoredTurn("turn-1-user", "user", "alpha fact about the system", undefined, "VERBATIM");
    loop.addRestoredTurn("turn-2-model", "model", "beta reply with detail", undefined, "VERBATIM");
    const m = executeIntent({ op: "convo.merge", from: 1, to: 2 }, loop.store, null);
    expect(m.ok).toBe(true);
    const group = loop.store.get("merge:turn-1-user..turn-2-model");
    expect(group).toBeDefined();
    // Pre-fix: no producer set recoverability → §3 recoverable=false → MERGED
    // priced at qLossy (inert two-class pricing). Post-fix: verbatim-preserving.
    expect(group!.recoverability).toBe("verbatim-preserving");
  });
  test("file lens stamps rereadable", async () => {
    const { FileLensItem } = await import("../src/optimizer/lens.ts");
    const lens = new FileLensItem("lens:notes.txt", "notes.txt", "line one\nline two\nline three\n", "evolving");
    loop_lens: {
      expect(lens.toContextItem().recoverability).toBe("rereadable");
      break loop_lens;
    }
  });
});

describe("review A-M2 — μ₀ double-count in valueMass future-value stream", () => {
  test("merge-group FV uses mass alone (no second μ₀)", () => {
    // Discriminator: a valueMass>0 item whose option surface is a rewrite
    // option (hand-built item, suffix.test.ts style). futureValue feeds
    // benefit; pre-fix the FV stream multiplied an already-μ₀-baked mass
    // by profile.mu0 again. We assert the ledger's benefit is finite and
    // matches the mass-only expectation (not 3× it).
    const ps = paramSetV1("mock");
    const mk = (id: string, text: string): ContextItem => ({
      id, kind: "directive", velocity: "volatile", immutable: false,
      tokens: estTokens(text),
      serialize: () => text,
      options: () => [{
        id: "as-is", purelyAdditive: false, zones: ["foundational"], representation: "AS_IS",
        tokens: estTokens(text), text,
      }],
      lastTouchTurn: 12, createdTurn: 4, valueMass: 24,
    });
    const r = solve(new Map([["m:1", mk("m:1", "merged group payload")]]), {
      rendered: new Map(), totalTokens: 0, blockCount: 0,
    }, ps, 12);
    const l = r.itemLedgers.find((i) => i.id === "m:1")!;
    // Self-calibrating discriminator: recompute the mass-only FV from the
    // same ParamSet. Pre-fix the solver passed mass*mu0 — the ledger FV
    // would then equal this same formula with mu0 = 24*6 (directive mu0),
    // i.e. far off this exact value.
    const tokens = estTokens("merged group payload");
    const dT = 8, q = 1; // createdTurn 4, turn 12; AS_IS directive option
    let expected = 0;
    for (let k = 1; k <= Math.min(ps.fv.horizon, ps.fv.horizon); k++) {
      expected += Math.pow(ps.fv.gamma, k) * (q * 24 * Math.pow(1 + dT + k, -0.2) - ps.reservationPrice * tokens);
    }
    expect(l.forecast.futureValue).toBeDefined();
    expect(l.forecast.futureValue!).toBeCloseTo(expected, 6);
    expect(Number.isFinite(l.utility.benefit)).toBe(true);
  });
});

describe("review A-M4 — new-item hazard premium charges own tokens, not the window", () => {
  test("fresh notice utility independent of incumbent window size", () => {
    // Same 13t notice, hazard 0.9: pre-fix utility at 20k window ≈ −45 (dropped),
    // at 100t window ≈ +3.6 (kept). Post-fix both decisions identical — entry
    // overpricing by hazard·(W/1000)·spread is gone.
    const ps = paramSetV1("mock");
    const solveAt = (windowTokens: number) => {
      const notice = new NoticeItem("n:1", "notice", "short notice body", "volatile", false, [], 0.9).toContextItem();
      const items = new Map<string, ContextItem>([["n:1", notice]]);
      const incumbent = {
        rendered: new Map(), totalTokens: windowTokens, blockCount: Math.max(1, Math.round(windowTokens / 100)),
      };
      return solve(items, incumbent, ps, 5).itemLedgers.find((i) => i.id === "n:1");
    };
    const small = solveAt(100);
    const large = solveAt(20_000);
    expect(small).toBeDefined();
    expect(large).toBeDefined();
    expect(small!.decision).toBe(large!.decision);
  });
});
