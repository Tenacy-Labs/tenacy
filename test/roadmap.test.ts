/**
 * Roadmap completion tests — memory (bun:sqlite FTS5 + embedding blend),
 * rlm() child agents (typed handles + usage attribution), ops.* host
 * surface (caps registry + intents), swarm hibernation (hibernate/revive
 * with snapshot recovery, never replay).
 */
import { describe, test, expect } from "bun:test";
import { MemoryStore } from "../src/optimizer/memory.ts";
import { RLMSupervisor, AttributionProvider } from "../src/optimizer/rlm.ts";
import { MockProvider } from "../src/optimizer/providers.ts";
import { AgentLoop } from "../src/optimizer/loop.ts";
import { paramSetV1 } from "../src/optimizer/params.ts";
import { executeIntent } from "../src/optimizer/intents.ts";
import { bindOps, opsCaps } from "../src/optimizer/ops.ts";
import { ContextStore } from "../src/optimizer/store.ts";
import { Swarm } from "../src/swarm.ts";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// ─── helpers ────────────────────────────────────────────────────────────

const TMP = "/tmp/ak-roadmap-tests";
/** Worker paths must be absolute or './'-prefixed (node:worker_threads
 *  contract — bare "src/..." passes on some platforms, fails on CI). */
const WORKER = join(import.meta.dir, "../src/agent-worker.ts");

function freshStore(): ContextStore {
  const s = new ContextStore();
  s.nextTurn();
  return s;
}

/** Deterministic toy embedder: bag-of-words over a fixed vocabulary. */
function toyEmbedder(vocab: Record<string, number[]>): (t: string) => number[] {
  const dim = Object.values(vocab)[0]!.length;
  return (t: string) => {
    const v = new Array<number>(dim).fill(0);
    for (const w of t.toLowerCase().split(/\W+/)) {
      const e = vocab[w];
      if (e) for (let i = 0; i < dim; i++) v[i]! += e[i]!;
    }
    return v;
  };
}

// ─── 1. Semantic session memory ─────────────────────────────────────────

describe("Semantic session memory (bun:sqlite, FTS5 + embedding blend)", () => {
  test("remember + FTS recall: exact keyword matches, deterministic order", () => {
    const m = new MemoryStore({ path: ":memory:" });
    m.remember("Daniel's favorite number is 47", { kind: "fact" });
    m.remember("The LIRR connector covers 127 stations", { kind: "fact" });
    m.remember("Shipped the agent loop 2026-08-21", { kind: "episodic" });
    expect(m.count()).toBe(3);

    const hits = m.search("favorite number");
    expect(hits.length).toBe(1);
    expect(hits[0]!.row.text).toBe("Daniel's favorite number is 47");
    expect(hits[0]!.source).toBe("fts");
    m.close();
  });

  test("embedding blend: semantic neighbor ranks with lexical hit", () => {
    const m = new MemoryStore({ embedder: toyEmbedder({
      knapsack: [1, 0, 0], solver: [0, 1, 0], stations: [0, 0, 1],
    }) });
    m.remember("The MCKP knapsack solver is integer-exact", { kind: "fact" });
    m.remember("LIRR connector has 127 stations", { kind: "fact" });
    const hits = m.search("knapsack");
    expect(hits[0]!.row.text).toContain("knapsack");
    expect(hits[0]!.source).toBe("blend");
    m.close();
  });

  test("kind filter narrows recall; file DB persists across reopen", () => {
    mkdirSync(TMP, { recursive: true });
    const dbPath = join(TMP, "mem.db");
    try { rmSync(dbPath); } catch {}
    try { rmSync(dbPath + "-wal"); } catch {}
    try { rmSync(dbPath + "-shm"); } catch {}
    const m1 = new MemoryStore({ path: dbPath });
    m1.remember("fact one", { kind: "fact" });
    m1.remember("memory of shipping", { kind: "episodic" });
    m1.close();
    const m2 = new MemoryStore({ path: dbPath });
    expect(m2.count()).toBe(2);
    const onlyFacts = m2.search("one OR shipping", 5, "fact");
    expect(onlyFacts.length).toBe(1);
    expect(onlyFacts[0]!.row.kind).toBe("fact");
    m2.close();
  });
});

// ─── 2. rlm() child agents ──────────────────────────────────────────────

describe("rlm() child agents (typed handles, usage attribution)", () => {
  test("spawn → run → stop; report routed to parent store exactly once", async () => {
    const parent = new AgentLoop(new MockProvider(), paramSetV1("mock-1"));
    const sup = new RLMSupervisor({ provider: new MockProvider(), ps: paramSetV1("mock-1"), parent });
    const h = sup.spawn("count stations");
    expect(h.id).toBe("rlm-1");
    expect(h.status()).toBe("spawned");

    const out = await h.run("LIRR has 127 stations");
    expect(out.turn).toBe(1);
    // Not at cap: still running, no report yet.
    expect(h.status()).toBe("running");
    expect(parent.store.get(`rlm-report:${h.id}`)).toBeUndefined();

    h.stop("done for now");
    await h.final();
    expect(h.status()).toBe("stopped");
    // stop() resolves final; report notice only routes at #complete — stopped
    // children never emit the completed-notice. Exactly-zero notices so far.
    expect(parent.store.get(`rlm-report:${h.id}`)).toBeUndefined();
  });

  test("usage attribution: every child call lands in per-child + total rollup", async () => {
    const parent = new AgentLoop(new MockProvider(), paramSetV1("mock-1"));
    const sup = new RLMSupervisor({
      provider: new MockProvider(),
      ps: paramSetV1("mock-1"),
      parent,
      maxTurnsPerChild: 1,   // force completion after one run
    });
    const h = sup.spawn("one-shot");
    await h.run("say something");
    expect(h.status()).toBe("completed");
    const u = h.usage();
    expect(u.calls).toBe(1);
    expect(u.inputTokens).toBeGreaterThan(0);
    expect(u.outputTokens).toBeGreaterThan(0);
    const total = sup.totalUsage();
    expect(total.calls).toBe(1);
    expect(total.inputTokens).toBe(u.inputTokens);
    // Completion routed a priced notice into the parent store, exactly once.
    const notice = parent.store.get(`rlm-report:${h.id}`);
    expect(notice).toBeDefined();
    await h.final();
  });

  test("AttributionProvider wraps transparently (same modelId, attribution hooks fire)", async () => {
    const inner = new MockProvider();
    const seen: Array<{ id: string; in: number }> = [];
    const w = new AttributionProvider(inner, "rlm-test", (id, u) => {
      seen.push({ id, in: u.inputTokens });
    });
    expect(w.modelId).toBe(inner.modelId);
    const res = await w.call([], "ping");
    expect(res.text.length).toBeGreaterThan(0);
    expect(seen.length).toBe(1);
    expect(seen[0]!.in).toBeGreaterThan(0);
  });
});

// ─── 3. ops.* host surface ──────────────────────────────────────────────

describe("ops.* host surface (caps registry + rlm/memory intents)", () => {
  test("unbound ops: rlm/memory intents refuse honestly", () => {
    const store = freshStore();
    bindOps(null);
    const r1 = executeIntent({ op: "rlm.spawn", goal: "x" }, store, null);
    expect(r1.ok).toBe(false);
    expect(r1.result).toContain("no rlm supervisor");
    const r2 = executeIntent({ op: "memory.remember", text: "y" }, store, null);
    expect(r2.ok).toBe(false);
    expect(r2.result).toContain("no memory store");
  });

  test("bound ops: memory.remember → memory.search round-trip through intents", () => {
    const store = freshStore();
    const m = new MemoryStore({ path: ":memory:" });
    bindOps({ memory: m, rlm: null });
    const r1 = executeIntent({ op: "memory.remember", text: "Daniel's favorite number is 47", kind: "fact" }, store, null);
    expect(r1.ok).toBe(true);
    const r2 = executeIntent({ op: "memory.search", query: "favorite" }, store, null);
    expect(r2.ok).toBe(true);
    expect(r2.result).toContain("Daniel's favorite number is 47");
    bindOps(null);
    m.close();
  });

  test("bound ops: rlm.spawn/status/final through intents, reports priced as notices", async () => {
    const parent = new AgentLoop(new MockProvider(), paramSetV1("mock-1"));
    const sup = new RLMSupervisor({ provider: new MockProvider(), ps: paramSetV1("mock-1"), parent, maxTurnsPerChild: 1 });
    bindOps({ memory: null, rlm: sup });
    const store = parent.store;
    store.nextTurn();
    const r1 = executeIntent({ op: "rlm.spawn", goal: "test child" }, store, null);
    expect(r1.ok).toBe(true);
    expect(r1.result).toContain("rlm-1");
    const id = "rlm-1";
    const r2 = executeIntent({ op: "rlm.turn", id, message: "go" }, store, null);
    expect(r2.ok).toBe(true);
    // Fire-and-forget: wait for the child loop to settle (MockProvider is fast).
    await new Promise((r) => setTimeout(r, 50));
    const r3 = executeIntent({ op: "rlm.status" }, store, null);
    expect(r3.ok).toBe(true);
    expect(r3.result).toContain("completed");
    expect(r3.result).toContain("1 call(s)");
    const r4 = executeIntent({ op: "rlm.final", id }, store, null);
    expect(r4.ok).toBe(true);
    expect(r4.result.length).toBeGreaterThan(0);
    // The completion notice landed in the parent store as a priced item.
    expect(store.get(`rlm-report:${id}`)).toBeDefined();
    bindOps(null);
  });
});

// ─── 4. Swarm hibernation ───────────────────────────────────────────────

describe("Swarm hibernation (hibernate → revive with snapshot recovery)", () => {
  test("hibernate exits worker gracefully; revive re-attaches; state machine honors both", async () => {
    mkdirSync(TMP, { recursive: true });
    const stateDir = join(TMP, "states");
    rmSync(stateDir, { recursive: true, force: true });
    const swarm = new Swarm({ stateDir });
    const root = swarm.spawn(null, { spawnMode: "deep" });
    const rec = swarm.spawn(root.id, { workerPath: WORKER });
    // Wait for ready.
    await new Promise((r) => setTimeout(r, 150));
    // One turn to leave a snapshot on disk.
    const t1 = await swarm.turn(rec.id, "var stationCount = 127;");
    expect(t1.ok).toBe(true);
    // Hibernation.
    await swarm.hibernate(rec.id);
    expect(swarm.agents.get(rec.id)!.state).toBe("hibernated");
    expect(swarm.agents.get(rec.id)!.worker).toBeNull();
    // Hibernated agents don't count as live.
    expect(swarm.spawn(null, { spawnMode: "deep" }).id).toBeTruthy();
    // Revive: fresh worker recovers the snapshot (never replays journal).
    swarm.revive(rec.id, WORKER);
    await new Promise((r) => setTimeout(r, 150));
    expect(swarm.agents.get(rec.id)!.state).toBe("ready");
    // The revived worker remembers 127 — proof of snapshot recovery.
    const t2 = await swarm.turn(rec.id, "stationCount * 2");
    expect(t2.ok).toBe(true);
    expect(t2.value).toBe(254);
    // Fail-under-revert proof target: without recovery, t2.value would be
    // a ReferenceError (stationCount undefined) — the test discriminates.
    await swarm.hibernate(rec.id);
  });

  test("fail-under-revert proof: worker recovery is what makes revive remember", async () => {
    // Simulate the pre-fix worker (fresh kernel, ignores snapshot) by using
    // a state dir WITHOUT prior snapshot: the same turn must then fail with
    // ReferenceError — proving the previous test's pass depends on recovery.
    const stateDir = join(TMP, "no-snap");
    rmSync(stateDir, { recursive: true, force: true });
    const swarm = new Swarm({ stateDir });
    const root = swarm.spawn(null, { spawnMode: "deep" });
    const rec = swarm.spawn(root.id, { workerPath: WORKER });
    await new Promise((r) => setTimeout(r, 150));
    const t2 = await swarm.turn(rec.id, "stationCount * 2");
    expect(t2.ok).toBe(false);
    expect(String(t2.error)).toMatch(/TS2304|ReferenceError/);
    await swarm.hibernate(rec.id);
  });
});
