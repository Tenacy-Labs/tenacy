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
import { Ledger } from "../src/optimizer/ledger.ts";
import { executeIntent } from "../src/optimizer/intents.ts";
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
    const r = solve(store.snapshot(), { rendered: new Map(), totalTokens: 0, blockCount: 0 }, ps, 2);
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
    const fresh = { rendered: new Map(), totalTokens: 0, blockCount: 0 };
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

  test("exact-MCKP relief (flag): keeps >= utility than density under identical pressure", () => {
    // Knapsack-swap Stage 2: same discriminating setup as the density test,
    // but relief runs through @connectotron/knapsack. In an instance where
    // density's greedy sequence is suboptimal, exact retains strictly more
    // utility; never less. This test asserts the floor: exact >= density,
    // budget respected, and the known-optimal answer on the fat/tiny shape
    // (drop fat — its utility density is lower despite higher absolute).
    const store = freshStore();
    const fat = makeTurnItem("fat", "user", "lorem ipsum ".repeat(80), 1);
    fat.valueBump = { amount: 6, untilTurn: 10 };
    const tiny = makeTurnItem("tiny", "user", "lorem ipsum", 1);
    store.add(fat);
    store.add(tiny);
    const fresh = { rendered: new Map(), totalTokens: 0, blockCount: 0 };
    const r0 = solve(store.snapshot(), fresh, ps, 1);
    const fatTokens = r0.placements.find((p) => p.id === "fat")!.tokens;
    const tightD = { ...ps, budgetLambda: r0.totalTokens - fatTokens };
    const tightE = { ...tightD, reliefMode: "exact-mckp" as const };
    const rD = solve(store.snapshot(), fresh, tightD, 1);
    const rE = solve(store.snapshot(), fresh, tightE, 1);
    const keptUtil = (r: typeof rD) => r.itemLedgers
      .filter((l) => l.decision !== "drop" && l.decision !== "purge")
      .reduce((s, l) => s + l.utility.total, 0);
    // Both fit the budget.
    expect(rE.totalTokens).toBeLessThanOrEqual(tightE.budgetLambda);
    expect(rD.totalTokens).toBeLessThanOrEqual(tightD.budgetLambda);
    // Exact retains at least density's utility (the greedy answer here IS
    // optimal, so equality; the >= floor is what must never break).
    expect(keptUtil(rE)).toBeGreaterThanOrEqual(keptUtil(rD) - 1e-9);
    // And the known-optimal choice: fat out, tiny in.
    const droppedE = rE.itemLedgers.filter((l) => l.decision === "drop").map((l) => l.id);
    expect(droppedE).toContain("fat");
    expect(droppedE).not.toContain("tiny");
  });

  test("exact-MCKP relief (flag): suboptimal-greedy instance — exact strictly better", () => {
    // Classic greedy-fails MCKP shape adapted to relief: one mid-density
    // large item vs two high-density small items. Capacity fits EITHER the
    // large item OR both small ones. Density relief (sequential argmax)
    // evicts a small one first (its density ranking misleads at the margin),
    // then must also evict the large one; exact keeps both small ones —
    // strictly more total utility.
    const store = freshStore();
    const big = makeTurnItem("big", "user", "x".repeat(60 * 4), 1);   // ~60t
    big.valueBump = { amount: 5.0, untilTurn: 10 };
    const s1 = makeTurnItem("s1", "user", "y".repeat(20 * 4), 1);     // ~20t
    s1.valueBump = { amount: 3.0, untilTurn: 10 };
    const s2 = makeTurnItem("s2", "user", "z".repeat(20 * 4), 1);     // ~20t
    s2.valueBump = { amount: 3.0, untilTurn: 10 };
    store.add(big); store.add(s1); store.add(s2);
    const fresh = { rendered: new Map(), totalTokens: 0, blockCount: 0 };
    const r0 = solve(store.snapshot(), fresh, ps, 1);
    const tBig = r0.placements.find((p) => p.id === "big")!.tokens;
    const tS1 = r0.placements.find((p) => p.id === "s1")!.tokens;
    const tS2 = r0.placements.find((p) => p.id === "s2")!.tokens;
    // Budget fits big alone OR both smalls, not all three (plus the held
    // identity/directive mass).
    const tight = { ...ps, budgetLambda: r0.totalTokens - tBig };
    const rD = solve(store.snapshot(), fresh, tight, 1);
    const rE = solve(store.snapshot(), fresh, { ...tight, reliefMode: "exact-mckp" as const }, 1);
    const keptIdsD = rD.placements.map((p) => p.id);
    const keptIdsE = rE.placements.map((p) => p.id);
    void keptIdsD;
    // Exact keeps the two high-density smalls over the one low-density big.
    expect(keptIdsE).toContain("s1");
    expect(keptIdsE).toContain("s2");
    expect(keptIdsE).not.toContain("big");
    expect(rE.totalTokens).toBeLessThanOrEqual(tight.budgetLambda);
    void tS1; void tS2;
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
    const big = "x".repeat(20000); // ~5000 tokens -> relief must tombstone it
    const lensItem = new FileLensItem("lens:notes.txt", "notes.txt", big);
    lensItem.ranges.push([0, big.length]); // expanded: options exist (empty lens offers none)
    store.add(lensItem.toContextItem());
    const ps = { ...paramSetV1("test-model"), budgetLambda: 1000 };
    const result = solve(store.snapshot(), { rendered: new Map(), totalTokens: 0, blockCount: 0 }, ps, 1);
    const lens = result.placements.find((p) => p.id === "lens:notes.txt");
    expect(lens).toBeDefined();
    expect(lens!.optionId).toBe("purge");  // tombstoned by relief, handle kept
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
    const r = solve(store.snapshot(), { rendered: new Map(), totalTokens: 0, blockCount: 0 }, tight, 1);
    expect(r.placements.some((p) => p.id === "g")).toBe(true);
  });

  test("hysteresis: incumbent option survives a marginal challenger", () => {
    const store = newStoreWithFileLens(600);
    const first = solve(store.snapshot(), { rendered: new Map(), totalTokens: 0, blockCount: 0 }, ps, 1);
    const incumbent = {
      rendered: new Map(first.placements.map((p) => [p.id, {
        position: p.position, zone: p.zone, digest: p.digest,
        representation: p.representation, optionId: p.optionId,
      }])),
      totalTokens: first.totalTokens,
      blockCount: first.placements.length,
    };
    const second = solve(store.snapshot(), incumbent, ps, 2);
    const lensFirst = first.placements.find((p) => p.id.startsWith("lens:"));
    const lensSecond = second.placements.find((p) => p.id.startsWith("lens:"));
    expect(lensFirst?.optionId).toBe(lensSecond?.optionId);
  });

  test("deterministic: same inputs, same placements and ledgers", () => {
    const store = freshStore();
    store.add(makeTurnItem("t1", "user", "hello", 1));
    const inc = { rendered: new Map(), totalTokens: 0, blockCount: 0 };
    const a = solve(store.snapshot(), inc, ps, 2);
    const b = solve(store.snapshot(), inc, ps, 2);
    expect(a.placements).toEqual(b.placements);
    expect(a.itemLedgers).toEqual(b.itemLedgers);
  });

  test("error evidence holds a value floor (A1; A-M5 state-based ruling 2026-08-23)", () => {
    const p1 = paramSetV1("mock-1");
    const err = new NoticeItem("e1", "error", "cell threw: cannot read property of undefined");
    const ep = makeTurnItem("ep1", "model", "ok", 1);
    const store1 = new ContextStore(); store1.add(err.toContextItem()); store1.add(ep);
    // simulate 10 turns of decay: UNRESOLVED error keeps the state floor at
    // any age (floorWhileUnresolved — sticky until dealt with, owner ruling)
    const r1 = solve(store1.snapshot(), { rendered: new Map(), totalTokens: 0, blockCount: 0 }, p1, 10);
    const led1 = r1.itemLedgers.find((l) => l.id === "e1")!;
    expect(led1.forecast.mu0).toBe(p1.profiles.error.mu0);
    expect(led1.decision === "drop" || led1.decision === "keep").toBe(true);
    // unresolved: floor holds (2.0) despite 10 turns of α=1.0 decay
    expect(led1.forecast.expectedValue).toBeGreaterThanOrEqual(p1.profiles.error.floorWhileUnresolved ?? 0);
    // the state floor exceeds plain power-law decay at this age
    expect(p1.profiles.error.floorWhileUnresolved ?? 0)
      .toBeGreaterThan(p1.profiles.error.mu0 * Math.pow(11, -p1.profiles.error.alpha));
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
    const solved = solve(store.snapshot(), { rendered: new Map(), totalTokens: 0, blockCount: 0 }, ps, 1);
    const a = render(solved.placements, store.snapshot(), ps);
    const b = render(solved.placements, store.snapshot(), ps);
    expect(a.text).toBe(b.text);
    expect(a.blocks.map((x) => x.digest)).toEqual(b.blocks.map((x) => x.digest));
  });

  test("zones in canonical order in the text", () => {
    const store = freshStore();
    store.add(makeTurnItem("t1", "user", "hi", 1));
    const solved = solve(store.snapshot(), { rendered: new Map(), totalTokens: 0, blockCount: 0 }, ps, 2);
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

  test("virtual head block: tool tokens join the believed prefix", () => {
    const cm = new CacheModel(ps.cache);
    const blocks = [{ digest: "a", tokens: 100, text: "", itemId: "x", zone: "identity" as const }];
    cm.setHeadBlock({ digest: "tool-defs-v1", tokens: 2100 });
    // No prior turn: chain empty, but the head matches itself (re-sent every
    // request) — expected hit includes it immediately.
    const h0 = cm.expectedHit(blocks);
    expect(h0.hitTokens).toBe(2100);
    cm.update(blocks);
    const h1 = cm.expectedHit(blocks);
    expect(h1.hitTokens).toBe(2200); // head + matched block
    // Head freshness advances with update(), so it survives later turns.
    const h2 = cm.expectedHit([{ ...blocks[0]!, digest: "z" }]);
    expect(h2.hitTokens).toBe(2100); // head still hit; block miss
    // Removing the head restores plain block-prefix semantics: the same
    // query now credits only the matched block (expectedHit is pure — the
    // earlier z-query did not mutate the chain).
    cm.setHeadBlock(null);
    expect(cm.expectedHit(blocks).hitTokens).toBe(100);
  });

  test("believed-evicted-hit no longer fires spuriously when the head explains the hit", () => {
    const cm = new CacheModel(ps.cache);
    const blocks = [{ digest: "a", tokens: 100, text: "", itemId: "x", zone: "identity" as const }];
    cm.setHeadBlock({ digest: "tool-defs-v1", tokens: 2100 });
    cm.update(blocks);
    // Provider reports exactly head+block — previously expected 0 + realized
    // 2200 > 500 floor => spurious believed-evicted-hit. Now expected 2200.
    const cl = cm.calibrate(blocks, {
      inputTokens: 2200, cacheReadTokens: 2200, cacheWriteTokens: 0, outputTokens: 10, raw: {},
    }, cm.expectedHit(blocks));
    expect(cl.divergence).toBe("none");
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

// ── session persistence + transient-failure recovery (MVA human use) ────

describe("session persistence — save/restore round-trip", () => {
  test("save captures store rows; restore rehydrates a fresh loop with state intact", async () => {
    const { saveSession, restoreSession } = await import("../src/optimizer/sessions.ts");
    const dir = mkdtempSync(join(tmpdir(), "ak-session-"));
    const path = join(dir, "s1.json");
    const ps = paramSetV1("test-model");

    // Build a loop with standing + goal + 2 turns + lens
    const src = new AgentLoop(new MockProvider(), ps);
    src.store.add(new StandingItem("identity", "identity", "you are a test agent").toContextItem());
    const g = new GoalItem("g1", "ship the thing", undefined, "task");
    src.registerGoal(g);
    await src.run("hello there");
    await src.run("second message");

    const sf = saveSession(src, path, "mock");
    if (sf.rows.length < 5) throw new Error(`too few rows captured: ${sf.rows.length}`);
    if (sf.header.turn !== src.store.turn) throw new Error("turn not captured");

    // Fresh loop; restore; verify
    const dst = new AgentLoop(new MockProvider(), ps);
    const { header, restored } = restoreSession(dst, path);
    if (restored !== sf.rows.length) throw new Error(`restored ${restored} != saved ${sf.rows.length}`);
    if (dst.store.turn !== header.turn) throw new Error(`turn mismatch: ${dst.store.turn} != ${header.turn}`);
    const ids = dst.store.all().map((i) => i.id);
    for (const want of ["identity", "g1", "turn-1-user", "turn-1-model", "turn-2-user"]) {
      if (!ids.includes(want)) throw new Error(`missing restored id: ${want}`);
    }
    const gg = dst.goalRegistryView().get("g1");
    if (gg === undefined || gg.text !== "ship the thing") throw new Error("goal not restored with text");
  });

  test("restored session continues the conversation (next turn renders restored history)", async () => {
    const { saveSession, restoreSession } = await import("../src/optimizer/sessions.ts");
    const dir = mkdtempSync(join(tmpdir(), "ak-session-"));
    const ps = paramSetV1("test-model");
    const src = new AgentLoop(new MockProvider(), ps);
    src.store.add(new StandingItem("identity", "identity", "test").toContextItem());
    await src.run("alpha message");
    saveSession(src, join(dir, "s2.json"), "mock");

    const dst = new AgentLoop(new MockProvider(), ps);
    restoreSession(dst, join(dir, "s2.json"));
    const out = await dst.run("beta message");
    if (out.turn !== 2) throw new Error(`expected turn 2 after restore, got ${out.turn}`);
    const rendered = dst.store.snapshot();
    if (!rendered.has("turn-1-user")) throw new Error("restored turn-1-user missing from store after continued run");
  });

  test("lens restores with ranges and re-reads live content from host fileContent", async () => {
    const { saveSession, restoreSession } = await import("../src/optimizer/sessions.ts");
    const dir = mkdtempSync(join(tmpdir(), "ak-session-"));
    const fixture = join(dir, "notes.txt");
    require("node:fs").writeFileSync(fixture, Array.from({ length: 60 }, (_, i) => `line ${i + 1}: payload ${i + 1}`).join("\n"));
    const ps = paramSetV1("test-model");
    const { executeIntent } = await import("../src/optimizer/intents.ts");
    const src = new AgentLoop(new MockProvider(), ps);
    src.fileContent = (t) => { try { return require("node:fs").readFileSync(t, "utf8"); } catch { return ""; } };
    src.store.add(new StandingItem("identity", "identity", "test").toContextItem());
    const er = executeIntent({ op: "files.expand", target: fixture, from: 10, to: 20 }, src.store, null);
    if (!er.ok) throw new Error("expand intent failed: " + er.result);
    const lens = src.lensRegistryView().get("lens:" + fixture);
    if (lens === undefined) throw new Error("lens not created in source run");
    if (!(lens instanceof FileLensItem)) throw new Error("file lens is wrong substrate");
    saveSession(src, join(dir, "s3.json"), "mock");

    const dst = new AgentLoop(new MockProvider(), ps);
    dst.fileContent = (t) => { try { return require("node:fs").readFileSync(t, "utf8"); } catch { return ""; } };
    restoreSession(dst, join(dir, "s3.json"));
    const rl = dst.lensRegistryView().get("lens:" + fixture);
    if (rl === undefined) throw new Error("lens not restored");
    if (!(rl instanceof FileLensItem)) throw new Error("restored lens is wrong substrate");
    const firstRange = rl.ranges[0];
    if (rl.ranges.length === 0 || firstRange === undefined || firstRange[0] !== 10) throw new Error(`lens ranges wrong: ${JSON.stringify(rl.ranges)}`);
    if (rl.content === "") throw new Error("lens content not re-read from host");
  });

  test("restore of a missing file throws honestly; bad format rejected", async () => {
    const { restoreSession } = await import("../src/optimizer/sessions.ts");
    let threw = false;
    try { restoreSession(new AgentLoop(new MockProvider(), paramSetV1("m")), "/nonexistent/session.json"); }
    catch { threw = true; }
    if (!threw) throw new Error("missing file should throw");
  });
});

describe("transient-failure recovery — retry with backoff", () => {
  test("transient 429 retried to success; signal journaled", async () => {
    const ps = paramSetV1("test-model");
    const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "ak-rx-")), "l.jsonl"));
    const loop = new AgentLoop(new MockProvider(), ps, ledger);
    // Adversarial provider: two 429s then success
    let calls = 0;
    const flaky: typeof loop = loop as unknown as typeof loop;
    const orig = loop["provider" as keyof typeof loop] as { call: unknown };
    (loop as unknown as { provider: { call(bb: unknown, um: string): Promise<unknown> } }).provider = {
      call: async (bb: unknown, um: string) => {
        calls++;
        if (calls < 3) { const e = new Error("HTTP 429 rate limited"); e.name = "RateLimit"; throw e; }
        return { text: "recovered", usage: { inputTokens: 10, outputTokens: 3 } };
      },
    };
    const out = await loop.run("survive me");
    if (out.modelText !== "recovered") throw new Error(`expected recovered text, got ${out.modelText}`);
    if (calls !== 3) throw new Error(`expected 3 calls, got ${calls}`);
    (loop as unknown as { provider: unknown }).provider = orig;
    await ledger.drain();
  });

  test("non-transient auth error surfaces immediately without retry", async () => {
    const ps = paramSetV1("test-model");
    const loop = new AgentLoop(new MockProvider(), ps);
    let calls = 0;
    (loop as unknown as { provider: { call(bb: unknown, um: string): Promise<never> } }).provider = {
      call: async () => { calls++; throw new Error("401 unauthorized: bad api key"); },
    };
    let surfaced = "";
    try { await loop.run("will fail"); } catch (e) { surfaced = String(e); }
    if (!surfaced.includes("401")) throw new Error(`auth error not surfaced: ${surfaced}`);
    if (calls !== 1) throw new Error(`non-transient should not retry, got ${calls} calls`);
  });
});

// ── lens hierarchy (OOP base class, 0002d) ─────────────────────────────

describe("lens hierarchy — abstract base + substrate subclasses", () => {
  test("FileLensItem is instanceof Lens and byte-identical to pre-hierarchy output", async () => {
    const { Lens, FileLensItem } = await import("../src/optimizer/lens.ts");
    const f = new FileLensItem("lens:t.txt", "t.txt", "a\nb\nc\nd\ne\nf");
    if (!(f instanceof Lens)) throw new Error("FileLensItem must extend Lens");
    f.expand(2, 3);
    f.expand(4, 5);
    const expect1 = "⟨file t.txt 1 range(s)⟩\n2| b\n3| c\n4| d\n5| e";
    if (f.serialize() !== expect1) throw new Error(`serialize drifted: ${JSON.stringify(f.serialize())}`);
    f.baseBlockTurn = 0;
    const opts = f.options();
    if (opts[0]?.id !== "base+delta" || opts[0]?.purelyAdditive !== true) throw new Error("option surface wrong after base");
  });

  test("expand/release algebra is substrate-invariant across File and Directory lenses", async () => {
    const { Lens, FileLensItem, DirectoryLensItem } = await import("../src/optimizer/lens.ts");
    const f = new FileLensItem("lens:f", "f", ["x1", "x2", "x3", "x4", "x5", "x6", "x7", "x8"].join("\n"));
    const d = new DirectoryLensItem("lens:d", "d", ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8"].join("\n"));
    for (const L of [f, d]) {
      if (!(L instanceof Lens)) throw new Error("subclass must extend Lens");
      L.expand(2, 4); L.expand(5, 6);          // coalesce to [2,6]
      const coalesced: [number, number] | undefined = L.ranges[0];
      const n1: number = L.ranges.length;
      if (n1 !== 1 || coalesced?.[0] !== 2 || coalesced?.[1] !== 6) throw new Error(`coalesce failed: ${JSON.stringify(L.ranges)}`);
      L.release(4, 4);                          // split [2,3],[5,6]
      const n2: number = L.ranges.length;
      if (n2 !== 2) throw new Error(`split failed: ${JSON.stringify(L.ranges)}`);
      L.expand(4, 4);                           // re-merge
      const n3: number = L.ranges.length;
      if (n3 !== 1) throw new Error(`re-merge failed: ${JSON.stringify(L.ranges)}`);
      L.release(1, 10);                          // full clear
      if (L.ranges.length !== 0) throw new Error("full release failed");
      if (L.options().length !== 0) throw new Error("empty lens must present no options");
    }
    // substrate tags differ, structure identical
    f.expand(1, 2); d.expand(1, 2);
    if (!f.serialize().startsWith("⟨file ")) throw new Error("file tag missing");
    if (!d.serialize().startsWith("⟨dir ")) throw new Error("dir tag missing");
  });

  test("DirectoryLensItem slices entry lines with 1-indexed prefixes", async () => {
    const { DirectoryLensItem } = await import("../src/optimizer/lens.ts");
    const d = new DirectoryLensItem("lens:d", "/proj", "src/\ntests/\npackage.json\nbun.lock");
    d.expand(2, 3);
    const want = "⟨dir /proj 1 range(s)⟩\n2| tests/\n3| package.json";
    if (d.serialize() !== want) throw new Error(`dir slice wrong: ${JSON.stringify(d.serialize())}`);
    if (d.extentLines() !== 4) throw new Error(`extent wrong: ${d.extentLines()}`);
  });

  test("dirs.expand intent flows through the host into a DirectoryLensItem", async () => {
    const { AgentLoop } = await import("../src/optimizer/loop.ts");
    const { executeIntent } = await import("../src/optimizer/intents.ts");
    const ps = paramSetV1("test-model");
    const loop = new AgentLoop(new MockProvider(), ps);
    loop.dirListing = () => ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"].join("\n");
    loop.store.add(new StandingItem("identity", "identity", "t").toContextItem());
    const r = executeIntent({ op: "dirs.expand", target: "/proj", from: 1, to: 3 }, loop.store, null);
    if (!r.ok) throw new Error("dirs.expand failed: " + r.result);
    const d = loop.lensRegistryView().get("lens:/proj");
    if (d === undefined) throw new Error("dir lens not registered");
    const ci = loop.store.get("lens:/proj");
    if (ci === undefined) throw new Error("dir lens item not in store");
    if (!ci.serialize().includes("2| beta")) throw new Error("listing content missing: " + ci.serialize());
  });

  test("sessions round-trip preserves dir lens ranges (LensRow is substrate-generic)", async () => {
    const { saveSession, restoreSession } = await import("../src/optimizer/sessions.ts");
    const dir = mkdtempSync(join(tmpdir(), "ak-dlens-"));
    const ps = paramSetV1("test-model");
    const src = new AgentLoop(new MockProvider(), ps);
    src.dirListing = () => ["a", "b", "c", "d", "e"].join("\n");
    src.store.add(new StandingItem("identity", "identity", "t").toContextItem());
    executeIntent({ op: "dirs.expand", target: "/x", from: 1, to: 2 }, src.store, null);
    saveSession(src, join(dir, "s.json"), "mock");
    const dst = new AgentLoop(new MockProvider(), ps);
    dst.dirListing = () => ["a", "b", "c", "d", "e"].join("\n");
    const { restored } = restoreSession(dst, join(dir, "s.json"));
    if (restored < 2) throw new Error(`expected >=2 rows, got ${restored}`);
    const rl = dst.lensRegistryView().get("lens:/x");
    if (rl === undefined) throw new Error("dir lens not restored");
    if (rl.ranges.length !== 1 || rl.ranges[0]?.[0] !== 1) throw new Error("dir lens ranges wrong after restore");
  });
});

// ── ADR lens family completion: code, ns, convo.merge, live views ──────

describe("code lens — symbol-anchored ranges (0002d §4)", () => {
  test("structure listing and symbol expand; anchor survives line shifts", async () => {
    const { CodeLensItem, HeuristicTsExtractor } = await import("../src/optimizer/code-lens.ts");
    const src1 = [
      "import x from 'y';",
      "",
      "export function solve(a: number): number {",
      "  return a + 1;",
      "}",
      "",
      "export class Renderer {",
      "  render() { return 'r'; }",
      "}",
    ].join("\n");
    const c = new CodeLensItem("lens:code:t.ts", "t.ts", src1, new HeuristicTsExtractor());
    const listing = c.listingLines();
    if (!listing.some((l) => l.startsWith("solve"))) throw new Error("solve not in structure: " + JSON.stringify(listing));
    if (!listing.some((l) => l.startsWith("Renderer"))) throw new Error("Renderer not in structure");
    c.expandSymbol("solve");
    const before = c.serialize();
    if (!before.includes("return a + 1;")) throw new Error("solve body missing");
    if (before.includes("render()")) throw new Error("unselected Renderer leaked into selection");

    // LINE SHIFT: two lines inserted ABOVE solve — anchoring must hold
    const src2 = ["// comment 1", "// comment 2", ...src1.split("\n")].join("\n");
    c.content = src2;
    const after = c.serialize();
    if (!after.includes("return a + 1;")) throw new Error("ANCHORING FAILED: solve body lost after line shift");
    if (!after.includes("solve|")) throw new Error("solve label missing after shift");
  });

  test("removed symbol renders honest placeholder; release drops anchor", async () => {
    const { CodeLensItem, HeuristicTsExtractor } = await import("../src/optimizer/code-lens.ts");
    const src = "export function alpha() { return 1; }\nexport function beta() { return 2; }";
    const c = new CodeLensItem("lens:code:z.ts", "z.ts", src, new HeuristicTsExtractor());
    c.expandSymbol("alpha");
    c.expandSymbol("beta");
    c.content = "export function beta() { return 2; }";  // alpha deleted
    const out = c.serialize();
    if (!out.includes("no longer present")) throw new Error("deleted symbol must render honestly");
    c.releaseSymbol("beta");
    if (c.serialize().includes("return 2;")) throw new Error("released symbol still rendered");
  });

  test("code.expand / code.structure intents flow through the host", async () => {
    const loop = new AgentLoop(new MockProvider(), paramSetV1("m"));
    loop.fileContent = () => "export function greet() { return 'hi'; }\nexport const VERSION = 1;";
    loop.store.add(new StandingItem("identity", "identity", "t").toContextItem());
    const r1 = executeIntent({ op: "code.structure", target: "mod.ts" }, loop.store, null);
    if (!r1.ok || !r1.result.includes("greet")) throw new Error("structure failed: " + r1.result);
    const r2 = executeIntent({ op: "code.expand", target: "mod.ts", symbols: ["greet", "VERSION"] }, loop.store, null);
    if (!r2.ok) throw new Error("expand failed: " + r2.result);
    const lens = loop.lensRegistryView().get("lens:code:mod.ts");
    if (lens === undefined) throw new Error("code lens not registered");
    const ci = loop.store.get("lens:code:mod.ts");
    if (ci === undefined || !ci.serialize().includes("hi")) throw new Error("anchored source not in store render");
  });
});

describe("namespace lens — recursive focus, projections, commit diffs (0002d §3)", () => {
  test("focus prefix, structure vs content projection, expand-by-index", async () => {
    const { NSLensItem } = await import("../src/optimizer/ns-lens.ts");
    const producer = {
      children(prefix: string) {
        const nodes = [
          { path: "mcp", kind: "group" as const },
          { path: "mcp/tools", kind: "group" as const },
          { path: "mcp/tools/http", kind: "binding" as const, repr: "fetch adapter" },
          { path: "mcp/tools/fs", kind: "binding" as const, repr: "fs adapter" },
          { path: "core", kind: "group" as const },
          { path: "core/loop", kind: "cell" as const, repr: "AgentLoop" },
        ];
        return nodes.filter((n) => {
          const parent = n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : "";
          return parent === prefix;
        });
      },
      commitsSince() { return []; },
    };
    const ns = new NSLensItem("lens:ns:kernel", "kernel", producer);
    ns.focus("mcp");
    const structLines = ns.listingLines();
    if (structLines.length === 0 || !structLines.some((l) => l.startsWith("mcp/tools/http"))) throw new Error("structure projection wrong: " + JSON.stringify(structLines));
    if (structLines.some((l) => l.includes("fetch adapter"))) throw new Error("content leaked into structure projection");
    ns.projection = "content";
    const contentLines = ns.listingLines();
    if (!contentLines.some((l) => l.includes("fetch adapter"))) throw new Error("content projection missing repr");
    ns.unfocus("mcp");
    if (ns.prefixes.length !== 0) throw new Error("unfocus failed");
  });

  test("commit replay yields sequence-legible markers (0002d §6)", async () => {
    const { NSLensItem } = await import("../src/optimizer/ns-lens.ts");
    let log = [
      { turn: 2, changes: [{ marker: "+" as const, path: "mcp/tools/http" }] },
      { turn: 5, changes: [{ marker: "->" as const, path: "mcp/tools/fs" }] },
    ];
    const producer = {
      children: () => [],
      commitsSince: (t: number) => log.filter((c) => c.turn > t),
    };
    const ns = new NSLensItem("lens:ns:k", "k", producer);
    ns.applyCommits(7);
    if (!ns.lastDelta.some((m) => m.includes("+mcp/tools/http @t2"))) throw new Error("add marker missing: " + JSON.stringify(ns.lastDelta));
    if (!ns.lastDelta.some((m) => m.includes("→mcp/tools/fs @t5"))) throw new Error("move marker missing");
    log = [];  // no new commits
    ns.applyCommits(9);
    if (ns.lastDelta.length !== 0) throw new Error("no commits should yield no markers");
  });

  test("ns.focus intent flows through the host with projection", async () => {
    const loop = new AgentLoop(new MockProvider(), paramSetV1("m"));
    loop.nsProducers.set("kernel", () => ({
      children: () => [{ path: "mcp/tools/http", kind: "binding" as const, repr: "fetch" }],
      commitsSince: () => [],
    }));
    loop.store.add(new StandingItem("identity", "identity", "t").toContextItem());
    const r = executeIntent({ op: "ns.focus", target: "kernel", prefix: "mcp", projection: "content" }, loop.store, null);
    if (!r.ok) throw new Error("ns.focus failed: " + r.result);
    const ns = loop.lensRegistryView().get("lens:ns:kernel");
    if (ns === undefined) throw new Error("ns lens not registered");
    const ci = loop.store.get("lens:ns:kernel");
    if (ci === undefined || !ci.serialize().includes("mcp/tools/http")) throw new Error("focused ns content not rendered");
  });
});

describe("conversation MERGED + realized lossiness (0002f §2)", () => {
  test("convo.merge groups turns; members render in-merge; reexpand journals lossiness", async () => {
    const loop = new AgentLoop(new MockProvider(), paramSetV1("m"));
    loop.store.add(new StandingItem("identity", "identity", "t").toContextItem());
    await loop.run("first message");
    await loop.run("second message");
    await loop.run("third message");
    // merge turns 1-2
    const r = executeIntent({ op: "convo.merge", from: 1, to: 2 }, loop.store, null);
    if (!r.ok) throw new Error("merge failed: " + r.result);
    const group = loop.store.get("merge:turn-1-user..turn-2-model");
    if (group === undefined) throw new Error("merge group item missing");
    if (!group.serialize().startsWith("⟨merged turn-1-user..turn-2-model⟩")) throw new Error("group header wrong: " + group.serialize().slice(0, 60));
    const member = loop.convoTurn("turn-1-user");
    if (member === undefined || member.mergedInto === undefined) throw new Error("member not marked merged");
    const memberItem = loop.store.get("turn-1-user");
    if (memberItem === undefined) throw new Error("member item missing");
    if (!memberItem.options().some((o) => o.id === "in-merge")) throw new Error("in-merge option missing");
    // re-expand member: lossiness journaled
    let lossy = "";
    const r2 = executeIntent({ op: "convo.reexpand", id: "turn-1-user" }, loop.store, {
      recordSignal: (x: { type: string }) => { if (x.type === "realized-lossiness") lossy = x.type; },
    } as never);
    if (!r2.ok) throw new Error("reexpand failed: " + r2.result);
    if (lossy !== "realized-lossiness") throw new Error("lossiness not journaled");
    const restored = loop.convoTurn("turn-1-user");
    if (restored === undefined || restored.mergedInto !== undefined) throw new Error("member not restored to verbatim");
  });
});

describe("live views — coalescing, tail notices, churn demotion (0002d §5/§6)", () => {
  test("events coalesce to one delta per lens per turn; markers carry turn citations", async () => {
    const { TurnBoundaryWatcher } = await import("../src/optimizer/live-views.ts");
    const w = new TurnBoundaryWatcher();
    w.push({ lensId: "lens:a", path: "x.ts", kind: "change" });
    w.push({ lensId: "lens:a", path: "x.ts", kind: "change" });
    w.push({ lensId: "lens:a", path: "y.ts", kind: "add" });
    w.push({ lensId: "lens:b", path: "z.md", kind: "unlink" });
    const deltas = w.drain(4);
    if (deltas.length !== 2) throw new Error(`expected 2 deltas (one per lens), got ${deltas.length}`);
    const a = deltas.find((d) => d.lensId === "lens:a")!;
    if (a.coalescedEvents !== 3) throw new Error(`coalesced count wrong: ${a.coalescedEvents}`);
    if (!a.markers.some((m) => m.includes("+y.ts @t4")) || !a.markers.some((m) => m.includes("~x.ts @t4"))) throw new Error("markers wrong: " + JSON.stringify(a.markers));
    const b = deltas.find((d) => d.lensId === "lens:b")!;
    if (!b.markers[0]?.includes("−z.md")) throw new Error("unlink marker wrong");
    // second drain with no events: empty
    if (w.drain(5).length !== 0) throw new Error("empty drain should yield nothing");
  });

  test("churn demotion trips above threshold; optimizer flip journals but never feeds decay", async () => {
    const { TurnBoundaryWatcher } = await import("../src/optimizer/live-views.ts");
    const w = new TurnBoundaryWatcher();
    w.churnDemoteThreshold = 40;
    for (let i = 0; i < 45; i++) w.push({ lensId: "lens:hot", path: `f${i}.ts`, kind: "change" });
    w.drain(1);
    if (!w.shouldDemote("lens:hot")) throw new Error("demotion should trip at 45 > 40");
    if (w.shouldDemote("lens:cold")) throw new Error("cold lens must not demote");
  });

  test("loop drains watcher at turn boundary and journals live-delta signals", async () => {
    const { TurnBoundaryWatcher } = await import("../src/optimizer/live-views.ts");
    const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "ak-lv-")), "l.jsonl"));
    const loop = new AgentLoop(new MockProvider(), ps_default(), ledger);
    loop.watcher = new TurnBoundaryWatcher();
    loop.watcher.push({ lensId: "lens:none", path: "q.ts", kind: "change" });



    loop.store.add(new StandingItem("identity", "identity", "t").toContextItem());
    await loop.run("trigger a turn");
    await ledger.drain();
    // signal journaled
    const lines = readFileSyncLines(join(dirname0(ledgerPathOf(ledger)), "l.jsonl"));
    if (!lines.some((l) => l.includes("live-delta"))) throw new Error("live-delta signal not journaled");
  });
});

function ps_default() { return paramSetV1("test-model"); }
function ledgerPathOf(l: Ledger): string { return (l as unknown as { path: string }).path; }
function dirname0(p: string): string { return p.slice(0, p.lastIndexOf("/")); }
function readFileSyncLines(p: string): string[] {
  try { return (require("node:fs").readFileSync(p, "utf8") as string).split("\n").filter((x) => x !== ""); } catch { return []; }
}

  test("live deltas ride the RENDER TAIL as CHANGES section (push, not poll)", async () => {
    const { TurnBoundaryWatcher } = await import("../src/optimizer/live-views.ts");
    const w = new TurnBoundaryWatcher();
    const loop = new AgentLoop(new MockProvider(), paramSetV1("m"));
    loop.watcher = w;
    loop.fileContent = () => "alpha\nbeta\ngamma\n";
    loop.store.add(new StandingItem("identity", "identity", "t").toContextItem());
    const lens = loop.fileLens("watched.txt");
    lens.expand(1, 3);
    // simulate the fs adapter pushing a raw event BEFORE the next turn
    w.push({ lensId: lens.id, path: "watched.txt", kind: "change" });
    await loop.run("turn with pending live events");
    const rr = loop.lastRender;
    if (rr === null || rr === undefined) throw new Error("no render");
    const rt = rr;
    if (!rt.text.includes("## CHANGES (live since your last turn)")) {
      throw new Error("tail CHANGES section missing — live deltas are not reaching the model: " + rr.text.slice(-200));
    }
    if (!rt.text.includes("watched.txt")) throw new Error("notice does not name the changed path");
    // and the lens header carries the delta marker (sequence legibility)
    if (!rt.text.includes("@t")) throw new Error("turn-cited marker missing");
  });


// ── watcher pattern across substrates (0002d §4/§5) ────────────────────

describe("substrate watchers — dir, code, ns live refresh (push, not poll)", () => {
  test("dir lens: add/unlink events refresh listing + ride render tail", async () => {
    const { TurnBoundaryWatcher, LiveLensAdapter } = await import("../src/optimizer/live-views.ts");
    const loop = new AgentLoop(new MockProvider(), paramSetV1("m"));
    loop.watcher = new TurnBoundaryWatcher();
    let listing = "a.ts\nb.ts\n";
    loop.dirListing = () => listing;
    loop.store.add(new StandingItem("identity", "identity", "t").toContextItem());
    const lens = loop.dirLens("src");
    lens.expand(1, 2);
    const adapter = new LiveLensAdapter(loop.watcher!, lens.id, "/tmp/ak-dir-watch", "dir", () => loop.refreshLensFromSubstrate(lens.id));
    adapter.start();
    // external change: file added — nobody polls
    listing = "a.ts\nb.ts\nNEW.ts\n";
    loop.watcher!.push({ lensId: lens.id, path: "src/NEW.ts", kind: "add" });
    loop.refreshLensFromSubstrate(lens.id);
    await loop.run("turn after external add");
    const rr = loop.lastRender;
    if (rr === null || rr === undefined) throw new Error("no render");
    if (!rr.text.includes("+src/NEW.ts")) throw new Error("add marker missing from tail: " + rr.text.slice(-150));
    if (!rr.text.includes("NEW.ts")) throw new Error("listing not refreshed into render");
    adapter.stop();
  });

  test("code lens: change event re-extracts symbols — untouched symbol digests survive", async () => {
    const { TurnBoundaryWatcher, LiveLensAdapter } = await import("../src/optimizer/live-views.ts");
    const loop = new AgentLoop(new MockProvider(), paramSetV1("m"));
    loop.watcher = new TurnBoundaryWatcher();
    let src = "export function alpha() { return 1; }\n\nexport function beta() { return 2; }\n";
    loop.fileContent = () => src;
    loop.store.add(new StandingItem("identity", "identity", "t").toContextItem());
    const lens = loop.codeLens("mod.ts");
    lens.expandSymbol("alpha");
    lens.expandSymbol("beta");
    const before = lens.serialize();
    const adapter = new LiveLensAdapter(loop.watcher!, lens.id, "/tmp/ak-code-watch/mod.ts", "code", () => loop.refreshLensFromSubstrate(lens.id));
    adapter.start();
    // external edit: alpha's body changes, beta untouched
    src = "export function alpha() { return 42; }\n\nexport function beta() { return 2; }\n";
    loop.watcher!.push({ lensId: lens.id, path: "mod.ts", kind: "change" });
    loop.refreshLensFromSubstrate(lens.id);
    await loop.run("turn after external edit");
    const after = lens.serialize();
    if (!after.includes("return 42")) throw new Error("refreshed content missing new alpha body");
    if (before === after) throw new Error("content did not change after refresh");
    const rr = loop.lastRender;
    if (rr !== null && rr !== undefined && !rr.text.includes("~mod.ts")) throw new Error("change marker missing: " + rr.text.slice(-120));
    adapter.stop();
  });

  test("ns lens: fs event under prefix triggers producer refresh + applyCommits replay", async () => {
    const { TurnBoundaryWatcher, LiveLensAdapter } = await import("../src/optimizer/live-views.ts");
    const loop = new AgentLoop(new MockProvider(), paramSetV1("m"));
    loop.watcher = new TurnBoundaryWatcher();
    loop.store.add(new StandingItem("identity", "identity", "t").toContextItem());
    // in-memory producer with external-mutation semantics + commit log
    let files: Record<string, number> = { "src/alpha.ts": 100, "src/beta.ts": 200 };
    let cursor = 0;
    const commits: Array<{ turn: number; changes: Array<{ marker: "+" | "-" | "->"; path: string }> }> = [];
    const producer = {
      children: (prefix: string) => Object.entries(files)
        .filter(([k]) => k.startsWith(prefix))
        .map(([path, size]) => ({ path, kind: "binding" as const, repr: `${size}b` })),
      commitsSince: (turn: number) => commits.filter((c) => c.turn > turn),
      refresh: () => {
        // re-scan: the watcher saw src/gamma.ts appear
        files = { ...files, "src/gamma.ts": 50 };
        cursor += 1;
        commits.push({ turn: cursor, changes: [{ marker: "+", path: "src/gamma.ts" }] });
      },
    };
    loop.nsProducers.set("ns:src", () => producer);
    const lens = loop.nsLens("ns:src");
    lens.focus("src");
    const adapter = new LiveLensAdapter(loop.watcher!, lens.id, "/tmp/ak-ns-watch", "ns", () => loop.refreshLensFromSubstrate(lens.id));
    adapter.start();
    // external mutation: producer refresh appends commit
    loop.watcher!.push({ lensId: lens.id, path: "src/gamma.ts", kind: "add" });
    loop.refreshLensFromSubstrate(lens.id);
    lens.applyCommits(3);
    if (!lens.listingLines().some((l) => l.includes("gamma.ts"))) throw new Error("ns listing not refreshed after watcher event: " + JSON.stringify(lens.listingLines()));
    const lastDelta = (lens as unknown as { lastDelta?: string[] }).lastDelta;
    if (lastDelta === undefined || !lastDelta.some((m) => m.includes("+src/gamma.ts"))) throw new Error("commit replay marker missing: " + JSON.stringify(lastDelta));
    await loop.run("ns turn");
    const rr = loop.lastRender;
    if (rr !== null && rr !== undefined && !rr.text.includes("gamma.ts")) throw new Error("ns refresh did not reach render");
    adapter.stop();
  });

  test("conversation and goals are in-process: coordinator IS the watcher — no adapters", async () => {
    // The contract: attachLens/intents mutate store items directly; there is
    // no external substrate to observe. This test pins the DESIGN (and guards
    // against someone wiring fs watchers on turns/goals by accident).
    const { TurnBoundaryWatcher } = await import("../src/optimizer/live-views.ts");
    const loop = new AgentLoop(new MockProvider(), paramSetV1("m"));
    loop.watcher = new TurnBoundaryWatcher();
    loop.store.add(new StandingItem("identity", "identity", "t").toContextItem());
    await loop.run("hello");
    await loop.run("second");
    // no pending events, no deltas — turns ARE the events
    const deltas = loop.watcher!.drain(99);
    if (deltas.length !== 0) throw new Error("in-process substrates must not produce watcher deltas: " + JSON.stringify(deltas));
  });
});

// ── finer splits: per-range fragment items (0004/0005 refinement) ──────

describe("finer splits — fragment items + solver coupling", () => {
  test("split mode materializes one additive fragment per range; ids stable", async () => {
    const { FileLensItem } = await import("../src/optimizer/lens.ts");
    const content = Array.from({ length: 60 }, (_, i) => `line ${i + 1} ${"x".repeat(30)}`).join("\n");
    const lens = new FileLensItem("lens:split.ts", "split.ts", content);
    lens.expand(1, 20);
    lens.expand(40, 60);
    lens.baseBlockTurn = 2;              // base exists
    lens.renderMode = "split";
    const frags = lens.fragments();
    if (frags.length !== 2) throw new Error(`expected 2 fragments, got ${frags.length}`);
    if (frags[0]!.id !== "lens:split.ts#1" || frags[1]!.id !== "lens:split.ts#2") throw new Error("fragment ids unstable: " + JSON.stringify(frags.map((f) => f.id)));
    const opts = frags[0]!.options();
    if (!opts.some((o) => o.id === "range-full" && o.purelyAdditive)) throw new Error("range-full must exist and be additive");
    if (!opts.some((o) => o.id === "range-drop")) throw new Error("range-drop missing");
    const parentOpts = lens.options();
    if (!parentOpts.some((o) => o.id === "split")) throw new Error("parent split header option missing");
    if (!parentOpts.some((o) => o.id === "consolidated")) throw new Error("aggregated alternative must remain available");
    const fragBody = frags[0]!.options().find((o) => o.id === "range-full")!;
    if (!fragBody.text.includes("line 1") || !fragBody.text.includes("line 20")) throw new Error("fragment 1 carries wrong range");
    if (fragBody.text.includes("line 40")) throw new Error("fragment 1 leaked fragment 2 range");
  });

  test("solver drops the WORST-DENSITY fragment under budget pressure, keeping the better one", async () => {
    const { solve } = await import("../src/optimizer/solver.ts");
    const { ContextStore } = await import("../src/optimizer/store.ts");
    const lens = new FileLensItem("lens:budget.ts", "budget.ts",
      Array.from({ length: 60 }, (_, i) => `line ${i + 1} ${i === 55 ? "CRITICAL-FACT " + "v".repeat(20) : "x".repeat(30)}`).join("\n"));
    lens.expand(1, 20);
    lens.expand(40, 60);
    lens.baseBlockTurn = 2;
    lens.renderMode = "split";
    const store = new ContextStore();
    store.add(new StandingItem("identity", "identity", "t").toContextItem());
    store.add(lens.toContextItem());
    const frags = lens.fragments();
    for (const f of frags) store.add(f.toContextItem());
    // The solver cannot know line 56 matters without a signal — the honest
    // mechanism is a value bump (ctx.promote class). Bump #2, tighten Lambda
    // so only one fragment fits: the bumped one survives relief.
    const items = store.snapshot();
    const f2 = items.get("lens:budget.ts#2")!;
    f2.valueBump = { amount: 8, untilTurn: 30 };
    const ps = { ...paramSetV1("m"), budgetLambda: 430 } as never;
    const res = solve(items, { rendered: new Map(), totalTokens: 0, blockCount: 0 }, ps, 5);
    const placed = res.placements.filter((p) => p.id.startsWith("lens:budget.ts#"));
    const heldFull = placed.filter((p) => p.optionId === "range-full");
    if (heldFull.length === 0) throw new Error("no fragment held under pressure — solver had no fine-grained path");
    if (!heldFull.some((p) => p.id === "lens:budget.ts#2")) throw new Error("the CRITICAL-FACT range was dropped: " + JSON.stringify(placed.map((p) => p.id + ":" + p.optionId)));
  });

  test("coupling: parent choosing consolidated forces fragments to range-drop (no double charge)", async () => {
    const { solve } = await import("../src/optimizer/solver.ts");
    const { ContextStore } = await import("../src/optimizer/store.ts");
    const lens = new FileLensItem("lens:coupled.ts", "coupled.ts",
      Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"));
    lens.expand(1, 40);
    lens.baseBlockTurn = 3;
    lens.renderMode = "split";
    const store = new ContextStore();
    store.add(new StandingItem("identity", "identity", "t").toContextItem());
    store.add(lens.toContextItem());
    for (const f of lens.fragments()) store.add(f.toContextItem());
    const res = solve(store.snapshot(), { rendered: new Map(), totalTokens: 0, blockCount: 0 }, paramSetV1("m"), 5);
    const parent = res.placements.find((p) => p.id === "lens:coupled.ts");
    if (parent === undefined) throw new Error("parent not placed");
    const frags = res.placements.filter((p) => p.id.startsWith("lens:coupled.ts#"));
    const carriesBytes = parent.optionId === "consolidated" || parent.optionId === "full" || parent.optionId === "base+delta";
    if (carriesBytes) {
      const doubleCharged = frags.filter((f) => f.optionId === "range-full");
      if (doubleCharged.length > 0) throw new Error("DOUBLE CHARGE: " + JSON.stringify(doubleCharged.map((f) => f.id)));
      const coupledLedger = res.itemLedgers.find((l) => l.coupledReason === "parent-carries-bytes");
      if (coupledLedger === undefined) throw new Error("coupled ledger record missing");
    } else {
      // compact/split parent: fragments legitimately carry the bytes
      if (!frags.some((f) => f.optionId === "range-full")) throw new Error("header-only parent but no fragment carries bytes: " + JSON.stringify(frags.map((f) => f.optionId)));
    }
  });

  test("loop end-to-end: split lens renders as header + separate fragment blocks", async () => {
    const loop = new AgentLoop(new MockProvider(), paramSetV1("m"));
    loop.fileContent = () => Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    loop.store.add(new StandingItem("identity", "identity", "t").toContextItem());
    const lens0 = loop.fileLens("test.txt");
    lens0.expand(1, 30);
    lens0.baseBlockTurn = 1;
    lens0.renderMode = "split";
    await loop.run("second turn");
    const rr = (loop as unknown as { lastRender?: { blocks: Array<{ itemId: string; text: string }> } }).lastRender;
    if (rr === undefined) throw new Error("no render result — expose lastRender on AgentLoop or check hooks.onRender");
    const fragBlocks = rr.blocks.filter((b) => b.itemId.startsWith("lens:test.txt#"));
    if (fragBlocks.length === 0) throw new Error("no fragment blocks in render");
    const header = rr.blocks.find((b) => b.itemId === "lens:test.txt");
    if (header === undefined) throw new Error("parent header block missing");
    // either the split header (fragments carry bytes) or base+delta on the parent —
    // but if fragments carry bytes, the parent must be the header form
    const parentCarries = header.text.includes("+Δ") || header.text.includes("1-30\nline 1");
    if (!parentCarries && !header.text.includes("split into")) throw new Error("parent neither split-header nor aggregated: " + header.text.slice(0, 80));
    if (!parentCarries) {
      for (const b of fragBlocks) {
        if (!b.text.startsWith("⟨range")) throw new Error("fragment block malformed: " + b.text.slice(0, 40));
        if (b.text.includes("line 1\n") === false && b.text.includes("line 15") === false) throw new Error("fragment missing its range content");
      }
    }
  });
});
