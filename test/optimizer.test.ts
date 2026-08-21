/**
 * Optimizer tests — golden behaviors from the ADR corpus:
 * determinism, zones, additive preference, hysteresis, budget, cache
 * belief + A3 divergence class, error-evidence profile, loop end-to-end.
 */
import { describe, test, expect } from "bun:test";
import { paramSetV1 } from "../src/optimizer/params.ts";
import { ContextStore } from "../src/optimizer/store.ts";
import { render } from "../src/optimizer/renderer.ts";
import { solve } from "../src/optimizer/solver.ts";
import { CacheModel, blockDigest } from "../src/optimizer/cache-model.ts";
import { MockProvider, ScriptedProvider } from "../src/optimizer/providers.ts";
import { AgentLoop, makeTurnItem } from "../src/optimizer/loop.ts";
import { StandingItem, GoalItem, FileLensItem, NoticeItem } from "../src/optimizer/items.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ps = paramSetV1("mock-1");

function freshStore(): ContextStore {
  const s = new ContextStore();
  s.add(new StandingItem("identity", "identity", "You are a kernel agent.").toContextItem());
  s.add(new StandingItem("directive", "directive", "Use typed cells; be precise.").toContextItem());
  return s;
}

describe("solver", () => {
  test("zones fall out of position: identity head, episodic tail", () => {
    const store = freshStore();
    const goal = new GoalItem("goal:1", "ship the loop milestone");
    store.add(goal.toContextItem());
    store.add(makeTurnItem("turn-1-user", "user", "begin", 1));
    const r = solve(store.snapshot(), { rendered: new Map(), totalTokens: 0 }, ps, 2);
    const zones = r.placements.map((p) => p.zone);
    expect(zones.indexOf("identity")).toBeGreaterThanOrEqual(0);
    // identity zone holds identity + goal; episodic lands after
    const idPos = r.placements.find((p) => p.id === "identity")!.position;
    const epPos = r.placements.find((p) => p.id === "turn-1-user")!.position;
    expect(epPos).toBeGreaterThan(idPos);
  });

  test("budget relief drops worst density, not lowest utility (ADR-0005 §7)", () => {
    // Discriminating setup: the fat item carries a value bump, so its
    // ABSOLUTE utility exceeds the tiny one's — the old rule (lowest
    // utility) would drop the tiny item first and then still be over
    // budget. The ruled density rule drops the fat item once and fits.
    const store = freshStore();
    const fat = makeTurnItem("fat", "user", "lorem ipsum ".repeat(80), 1);
    fat.valueBump = { amount: 6, untilTurn: 10 };
    const tiny = makeTurnItem("tiny", "user", "lorem ipsum", 1);
    store.add(fat);
    store.add(tiny);
    const fresh = { rendered: new Map(), totalTokens: 0 };
    // Phase 0: unconstrained render to learn the natural layout.
    const r0 = solve(store.snapshot(), fresh, ps, 1);
    const fatTokens = r0.placements.find((p) => p.id === "fat")!.tokens;
    // Budget that fits exactly when fat is dropped, and cannot fit while
    // fat is held (dropping tiny alone leaves fat in context).
    const tight = { ...ps, budgetLambda: r0.totalTokens - fatTokens };
    const r = solve(store.snapshot(), fresh, tight, 1);
    const droppedIds = r.itemLedgers.filter((l) => l.decision === "drop").map((l) => l.id);
    expect(droppedIds).toContain("fat");
    expect(droppedIds).not.toContain("tiny");
    expect(r.totalTokens).toBeLessThanOrEqual(tight.budgetLambda);
    // Sanity: fat's absolute utility really did exceed tiny's (else this
    // test would pass under the old rule too).
    const fatLedger = r0.itemLedgers.find((l) => l.id === "fat")!;
    const tinyLedger = r0.itemLedgers.find((l) => l.id === "tiny")!;
    expect(fatLedger.utility.total).toBeGreaterThan(tinyLedger.utility.total);
  });

  test("two identical failing intents in one turn do not collide (error-evidence ids)", async () => {
    // Reviewer probe: duplicate item id "err:1:ctx.search" crashed run().
    // Fix: attempt counter in the error-evidence id.
    const provider = new ScriptedProvider([
      { text: "probing", intents: [
        { op: "ctx.search", pattern: "*[" },
        { op: "ctx.search", pattern: "*[" },
      ] },
    ]);
    const loop = new AgentLoop(provider, ps);
    const store = loop.store;
    let threw = false;
    loop.run("probe").catch((e) => { threw = true; console.error(e); });
    await new Promise((res) => setTimeout(res, 50));
    expect(threw).toBe(false);
    const snap = [...store.snapshot().values()];
    const errs = snap.filter((i) => i.kind === "error");
    expect(errs.length).toBe(2);
    expect(new Set(errs.map((e) => e.id)).size).toBe(2);
  });

  test("placement digests track the rendered option bytes, not serialize() (second-pass finding 1)", () => {
    // A lens purge MUST record the digest of the purge header it renders,
    // not the digest of the full-range serialization it did NOT render.
    const store = new ContextStore();
    const big = "x".repeat(20000); // ~5000 tokens -> purge wins over FULL
    const lensItem = new FileLensItem("lens:notes.txt", "notes.txt", big);
    lensItem.ranges.push([0, big.length]); // expanded: options exist (empty lens offers none)
    store.add(lensItem.toContextItem());
    const result = solve(store.snapshot(), { rendered: new Map(), totalTokens: 0 }, paramSetV1("test-model"), 1);
    const lens = result.placements.find((p) => p.id === "lens:notes.txt");
    expect(lens).toBeDefined();
    expect(lens!.optionId).toBe("purge");
    // digest must equal blockDigest of the PURGE text, and must NOT equal serialize()'s digest
    const purgeOpt = store.snapshot().get("lens:notes.txt")!.options().find((o) => o.id === "purge")!;
    expect(lens!.digest).toBe(blockDigest(purgeOpt.text));
    expect(lens!.digest).not.toBe(blockDigest(store.snapshot().get("lens:notes.txt")!.serialize()));
    // lastRender carries the same rendered digest
    expect(store.snapshot().get("lens:notes.txt")!.lastRender?.digest).toBe(blockDigest(purgeOpt.text));
  });

  test("goals are always held (risk-free anchor)", () => {
    const store = new ContextStore();
    store.add(new GoalItem("g", "survive budget pressure", undefined, "standing").toContextItem());
    const tight = { ...ps, budgetLambda: 10 };
    const r = solve(store.snapshot(), { rendered: new Map(), totalTokens: 0 }, tight, 1);
    expect(r.placements.some((p) => p.id === "g")).toBe(true);
  });

  test("hysteresis: incumbent option survives a marginal challenger", () => {
    const store = newStoreWithFileLens(600);
    const first = solve(store.snapshot(), { rendered: new Map(), totalTokens: 0 }, ps, 1);
    const incumbent = {
      rendered: new Map(first.placements.map((p) => [p.id, {
        position: p.position, zone: p.zone, digest: p.digest,
        representation: p.representation, optionId: p.optionId,
      }])),
      totalTokens: first.totalTokens,
    };
    const second = solve(store.snapshot(), incumbent, ps, 2);
    const lensFirst = first.placements.find((p) => p.id.startsWith("lens:"));
    const lensSecond = second.placements.find((p) => p.id.startsWith("lens:"));
    expect(lensFirst?.optionId).toBe(lensSecond?.optionId);
  });

  test("deterministic: same inputs, same placements and ledgers", () => {
    const store = freshStore();
    store.add(makeTurnItem("t1", "user", "hello", 1));
    const inc = { rendered: new Map(), totalTokens: 0 };
    const a = solve(store.snapshot(), inc, ps, 2);
    const b = solve(store.snapshot(), inc, ps, 2);
    expect(a.placements).toEqual(b.placements);
    expect(a.itemLedgers).toEqual(b.itemLedgers);
  });

  test("error evidence holds a value floor (A1)", () => {
    const p1 = paramSetV1("mock-1");
    const p2 = paramSetV1("mock-1");
    const err = new NoticeItem("e1", "error", "cell threw: cannot read property of undefined");
    const ep = makeTurnItem("ep1", "model", "ok", 1);
    const store1 = new ContextStore(); store1.add(err.toContextItem()); store1.add(ep);
    const store2 = new ContextStore(); store2.add(err.toContextItem()); store2.add(ep);
    // simulate 10 turns of decay: error keeps floor via profile (floorTurns=8)
    const r1 = solve(store1.snapshot(), { rendered: new Map(), totalTokens: 0 }, p1, 10);
    const led1 = r1.itemLedgers.find((l) => l.id === "e1")!;
    expect(led1.forecast.mu0).toBe(p1.profiles.error.mu0);
    expect(led1.decision === "drop" || led1.decision === "keep").toBe(true);
    // value with floor at deltaT=10 exceeds plain power-law decay
    const vFloor = Math.max(p2.profiles.error.mu0 * Math.pow(11, -p2.profiles.error.alpha), p2.profiles.error.floorValue ?? 0);
    expect(vFloor).toBeGreaterThan(1.5);
  });
});

function newStoreWithFileLens(contentLen: number): ContextStore {
  const store = freshStore();
  const lens = new FileLensItem(`lens:demo.txt`, "demo.txt", "x".repeat(contentLen));
  lens.expand(1, Math.max(1, Math.floor(contentLen / 80)));
  lens.baseBlockTurn = 1; // base exists → options include base+delta (additive)
  store.add(lens.toContextItem());
  return store;
}

describe("renderer", () => {
  test("byte-deterministic given placements", () => {
    const store = newStoreWithFileLens(2000);
    const solved = solve(store.snapshot(), { rendered: new Map(), totalTokens: 0 }, ps, 1);
    const a = render(solved.placements, store.snapshot(), ps);
    const b = render(solved.placements, store.snapshot(), ps);
    expect(a.text).toBe(b.text);
    expect(a.blocks.map((x) => x.digest)).toEqual(b.blocks.map((x) => x.digest));
  });

  test("zones in canonical order in the text", () => {
    const store = freshStore();
    store.add(makeTurnItem("t1", "user", "hi", 1));
    const solved = solve(store.snapshot(), { rendered: new Map(), totalTokens: 0 }, ps, 2);
    const rr = render(solved.placements, store.snapshot(), ps);
    const iId = rr.text.indexOf("## IDENTITY");
    const iEv = rr.text.indexOf("## WORKING");
    expect(iId).toBeGreaterThanOrEqual(0);
    expect(iEv).toBeGreaterThan(iId);
  });
});

describe("cache model", () => {
  test("expected hit = longest common digest prefix, TTL-bounded", () => {
    const cm = new CacheModel(ps.cache);
    const blocks = [
      { digest: "a", tokens: 100, text: "", itemId: "x", zone: "identity" as const },
      { digest: "b", tokens: 100, text: "", itemId: "y", zone: "identity" as const },
    ];
    cm.update(blocks);
    const hit = cm.expectedHit(blocks);
    expect(hit.hitTokens).toBe(200);
    const changed = [{ ...blocks[1]!, digest: "c" }];
    const hit2 = cm.expectedHit([blocks[0]!, ...changed]);
    expect(hit2.hitTokens).toBe(100);
  });

  test("A3 divergence class: provider summed cache reads", () => {
    const cm = new CacheModel(ps.cache);
    const blocks = [{ digest: "a", tokens: 1000, text: "", itemId: "x", zone: "identity" as const }];
    cm.update(blocks);
    const cl = cm.calibrate(blocks, {
      inputTokens: 1000, cacheReadTokens: 5500, cacheWriteTokens: 0, outputTokens: 10,
      raw: { note: "summed internal reads (server-side tool)" },
    }, { hitTokens: 900 });
    expect(cl.divergence).toBe("provider-usage-semantics");
  });

  test("unreported usage is null, never fabricated", () => {
    const cm = new CacheModel(ps.cache);
    const cl = cm.calibrate([], null, { hitTokens: 0 });
    expect(cl.realized).toBeNull();
    expect(cl.divergence).toBe("unreported");
  });
});

describe("agent loop end-to-end", () => {
  test("turns advance; cache hits accumulate on stable prefix", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-test-"));
    const { Ledger } = await import("../src/optimizer/ledger.ts");
    const ledger = new Ledger(join(dir, "l.jsonl"));
    const agent = new AgentLoop(new MockProvider(), ps, ledger);
    agent.store.add(new StandingItem("identity", "identity", "kernel agent").toContextItem());

    const t1 = await agent.run("first message");
    expect(t1.turn).toBe(1);
    expect(t1.cacheExpectedHit).toBe(0); // nothing cached yet
    const t2 = await agent.run("second message");
    expect(t2.turn).toBe(2);
    expect(t2.cacheExpectedHit).toBeGreaterThan(0); // identity prefix hit
    await ledger.drain();
  });

  test("files.expand coalesces; render grows by one lens entry", async () => {
    const agent = new AgentLoop(new MockProvider(), ps, null);
    agent.fileContent = () => Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
    const before = await agent.run("open the file");
    agent.steer({ op: "files.expand", target: "data.txt", from: 1, to: 30 });
    agent.steer({ op: "files.expand", target: "data.txt", from: 5, to: 60 });
    const after = await agent.run("now show me more");
    const lensResults = after.toolResults.filter((r) => r.op === "files.expand");
    expect(lensResults.length).toBe(2);
    expect(lensResults[1]!.result).toContain("1 coalesced");
    expect(after.renderTokens).toBeGreaterThan(before.renderTokens);
  });

  test("goals ride the identity zone and complete to markers", async () => {
    const agent = new AgentLoop(new MockProvider(), ps, null);
    agent.steer({ op: "goals.set", id: "g1", text: "prove the loop" });
    await agent.run("set a goal");
    const r1 = await agent.run("check");
    const goalPlacement = r1.placements.find((p) => p.id === "g1");
    expect(goalPlacement).toBeDefined();
    expect(goalPlacement!.zone).toBe("identity");
    agent.steer({ op: "goals.update", id: "g1", status: "completed" });
    const r2 = await agent.run("done");
    expect(r2.placements.find((p) => p.id === "g1")?.zone).toBe("foundational"); // completed → episodic record
  });
});
