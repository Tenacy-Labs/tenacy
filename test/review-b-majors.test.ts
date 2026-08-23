import { describe, test, expect } from "bun:test";
import { paramSetV1 } from "../src/optimizer/params.ts";
import { executeIntent } from "../src/optimizer/intents.ts";
import { MockProvider } from "../src/optimizer/providers.ts";
import { AgentLoop } from "../src/optimizer/loop.ts";
import { NoticeItem } from "../src/optimizer/items.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Review B-batch majors: RED pins, 2026-08-23. Each pin names its defect. ──

describe("B-2: session restore stamps — never the save-time truth", () => {
  test("restored turns keep their ORIGINAL created/lastTouch stamps", async () => {
    const { saveSession, restoreSession } = await import("../src/optimizer/sessions.ts");
    const dir = mkdtempSync(join(tmpdir(), "ak-b2a-"));
    const ps = paramSetV1("mock-1");
    const src = new AgentLoop(new MockProvider(), ps);
    await src.run("first message");
    await src.run("second message");
    await src.run("third message");
    const savedTurn = src.store.get("turn-2-user");
    expect(savedTurn!.createdTurn).toBe(2);
    expect(savedTurn!.lastTouchTurn).toBe(2);
    saveSession(src, join(dir, "s.json"), "mock");
    const dst = new AgentLoop(new MockProvider(), ps);
    restoreSession(dst, join(dir, "s.json"));
    const restored = dst.store.get("turn-2-user");
    expect(restored).toBeDefined();
    expect(restored!.createdTurn).toBe(2);
    expect(restored!.lastTouchTurn).toBe(2);
  });

  test("restored notices keep save-time stamps (not raw store.add)", async () => {
    const { saveSession, restoreSession } = await import("../src/optimizer/sessions.ts");
    const dir = mkdtempSync(join(tmpdir(), "ak-b2b-"));
    const ps = paramSetV1("mock-1");
    const src = new AgentLoop(new MockProvider(), ps);
    src.setTurn(7);                      // notice minted mid-session, not at turn 0
    const n = new NoticeItem("note-1", "notice", "watch this");
    src.store.add(n.toContextItem());    // stamps: created=lastTouch=7
    saveSession(src, join(dir, "s.json"), "mock");
    const dst = new AgentLoop(new MockProvider(), ps);
    restoreSession(dst, join(dir, "s.json"));
    const r = dst.store.get("note-1");
    expect(r).toBeDefined();
    expect(r!.lastTouchTurn).toBe(7);
    expect(r!.createdTurn).toBe(7);
  });
});

describe("B-3: blockWriteTurns carry-forward — digest-keyed, not positional", () => {
  test("merge-inserted group does not shift later blocks' write turns", async () => {
    const loop = new AgentLoop(new MockProvider(), paramSetV1("mock-1"));
    await loop.run("one");
    await loop.run("two");
    await loop.run("three");
    await loop.run("four");
    const before = loop.incumbentWriteTurns().slice();
    // Merge turn 1: the group block (foundational zone) inserts BEFORE the
    // turn blocks; turn-1 members render in-merge (0 bytes). Every later
    // block's digest is unchanged — its write turn must carry forward.
    const m = executeIntent({ op: "convo.merge", from: 1, to: 1 }, loop.store, null);
    expect(m.ok).toBe(true);
    await loop.run("fifth");
    const after = loop.incumbentWriteTurns();
    // Tail: [t4u, t4m, t5u, t5m] → turn-4 blocks keep write turn 4 (not the
    // predecessor's 3), turn-5 blocks stamp 5. Pre-fix positional zip gives
    // t4u the stamp of t3m (3) — provenance shifted, TTL inverted.
    const n = after.length;
    expect(after[n - 1]).toBe(5);
    expect(after[n - 2]).toBe(5);
    expect(after[n - 3]).toBe(4);
    expect(after[n - 4]).toBe(4);
    expect(before.length).toBeGreaterThan(0);
  });
});

describe("B-4: merge-group lifecycle", () => {
  test("failed merge strands no members (validation before mutation)", () => {
    const loop = new AgentLoop(new MockProvider(), paramSetV1("mock-1"), null);
    loop.addRestoredTurn("turn-3-user", "user", "only one turn", undefined, "VERBATIM");
    const m = executeIntent({ op: "convo.merge", from: 3, to: 3 }, loop.store, null);
    expect(m.ok).toBe(false);
    const t = loop.convoTurn("turn-3-user");
    expect(t!.mergedInto).toBeUndefined(); // pre-fix: stamped before validation
  });

  test("merged members upstreams point at the group (solver coupling)", () => {
    const loop = new AgentLoop(new MockProvider(), paramSetV1("mock-1"), null);
    loop.addRestoredTurn("turn-1-user", "user", "alpha", undefined, "VERBATIM");
    loop.addRestoredTurn("turn-1-model", "model", "beta", undefined, "VERBATIM");
    const m = executeIntent({ op: "convo.merge", from: 1, to: 1 }, loop.store, null);
    expect(m.ok).toBe(true);
    const member = loop.store.get("turn-1-user");
    expect(member!.upstreams).toEqual(["merge:turn-1-user..turn-1-model"]);
  });

  test("merge group round-trips through save/restore with valueMass", async () => {
    const { saveSession, restoreSession } = await import("../src/optimizer/sessions.ts");
    const dir = mkdtempSync(join(tmpdir(), "ak-b4-"));
    const ps = paramSetV1("mock-1");
    const src = new AgentLoop(new MockProvider(), ps);
    await src.run("alpha message");
    await src.run("beta message");
    const m = executeIntent({ op: "convo.merge", from: 1, to: 1 }, src.store, null);
    expect(m.ok).toBe(true);
    const savedGroup = src.store.get("merge:turn-1-user..turn-1-model") as { valueMass?: number };
    expect(savedGroup!.valueMass).toBeGreaterThan(0);
    saveSession(src, join(dir, "s.json"), "mock");
    const dst = new AgentLoop(new MockProvider(), ps);
    restoreSession(dst, join(dir, "s.json"));
    const group = dst.store.get("merge:turn-1-user..turn-1-model") as { valueMass?: number; memberIds?: readonly string[] };
    expect(group).toBeDefined();
    // pre-fix: no group row type — restores as a bare TurnItem, valueMass lost
    expect(group!.valueMass).toBeCloseTo(savedGroup!.valueMass!, 6);
  });
});

describe("B-5: live-delta wiring — noteLiveDelta reaches the lattice", () => {
  test("watcher delta arms pendingDeltas on a based lens", async () => {
    const loop = new AgentLoop(new MockProvider(), paramSetV1("mock-1"));
    loop.fileContent = () => ["alpha", "beta", "gamma"].join("\n");
    loop.attachLens("lens-x", "/tmp/b5-probe.txt", [[1, 3]], 1, "FULL", undefined, { selected: ["1-3"] });
    await loop.run("first");   // establishes base via commitConsolidation on placement
    // attach watcher and push an event
    const { TurnBoundaryWatcher } = await import("../src/optimizer/live-views.ts");
    const w = new TurnBoundaryWatcher();
    loop.watcher = w;
    loop.fileContent = () => ["alpha", "beta CHANGED", "gamma"].join("\n");
    w.push({ lensId: "lens-x", path: "/tmp/b5-probe.txt", kind: "change" });
    await loop.run("second");
    const lensItem = loop.lensRegistryView().get("lens-x") as unknown as { pendingDeltas?: Array<{ turn: number }> };
    expect(lensItem).toBeDefined();
    // pre-fix: drain loop never calls noteLiveDelta -> pendingDeltas stays empty
    expect(lensItem!.pendingDeltas!.length).toBeGreaterThan(0);
  });
});
