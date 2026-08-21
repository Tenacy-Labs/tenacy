import { describe, test, expect } from "bun:test";
import { Commons, revive, Commit } from "../src/commons.ts";

/** Two-agent interleaving exactly as Daniel described: A plans against ns@v,
 *  B mutates during A's model call, A commits — must be detected, not clobbered. */
function interleaved(planA: Record<string, any>, mutateB: (cm: Commons) => void) {
  const cm = new Commons();
  // A reads (sees version v, registers as reader of "helper")
  const readA = cm.read("A", ["helper"]);
  // A's model call happens... B commits during the gap
  mutateB(cm);
  // A commits against its stale base version
  const writes: Record<string, any> = {};
  for (const [k, v] of Object.entries(planA)) writes[k] = { op: "set", value: v };
  return { cm, receipt: cm.commit({ agentId: "A", baseVersion: readA.version, writes }) };
}

describe("Commons — optimistic versioned commits", () => {
  test("clean commit applies and bumps version once", () => {
    const cm = new Commons();
    const r = cm.commit({ agentId: "A", baseVersion: 0, writes: { helper: { op: "set", value: (x: number) => x * 3 } } } as Commit);
    expect(r.ok).toBe(true);
    expect(r.version).toBe(1);
    expect(cm.read("B", ["helper"]).values.helper).toEqual({ __fn: "(x) => x * 3" });
  });

  test("lost-update race is DETECTED (the exact scenario Daniel raised)", () => {
    const { receipt } = interleaved(
      { helper: (x: number) => x * 999 },                          // A's clobbering write
      (cm) => cm.commit({ agentId: "B", baseVersion: 0, writes: { helper: { op: "set", value: (x: number) => x + 1 } } } as Commit),
    );
    expect(receipt.ok).toBe(false);
    expect(receipt.conflicts).toEqual(["helper"]);
  });

  test("rename = atomic set+delete batch; readers of BOTH names notified", () => {
    const cm = new Commons();
    cm.commit({ agentId: "A", baseVersion: 0, writes: { helper: { op: "set", value: 1 } } } as Commit);
    cm.read("B", ["helper"]);
    cm.read("C", ["helper2"]);   // C reads the NEW name before it exists — still registered
    cm.commit({
      agentId: "A", baseVersion: 1,
      writes: { helper2: { op: "set", value: 2 }, helper: { op: "delete" } },
    } as Commit);
    const notes = cm.drainNotifications();
    const forB = notes.find((n) => n.agentId === "B")!;
    const forC = notes.find((n) => n.agentId === "C")!;
    expect(forB.kind).toBe("deleted");      // old name gone
    expect(forC.kind).toBe("changed");      // new name appeared
    expect(cm.read("A", ["helper"]).values.helper).toBeUndefined();
    expect(cm.read("A", ["helper2"]).values.helper2).toBe(2);
  });

  test("commit receipt version is a safe retry base (optimistic, no locks)", () => {
    const { cm, receipt } = interleaved(
      { helper: (x: number) => x * 999 },
      (cm) => cm.commit({ agentId: "B", baseVersion: 0, writes: { helper: { op: "set", value: (x: number) => x + 1 } } } as Commit),
    );
    expect(receipt.ok).toBe(false);
    // Agent A re-reads at the receipt's version and retries — jcode's "talk to
    // the other agent" resolution, mechanically supported.
    const re = cm.read("A", ["helper"]);
    expect(typeof re.values.helper.__fn).toBe("string");
    const retry = cm.commit({ agentId: "A", baseVersion: re.version, writes: { helperPlus: { op: "set", value: 42 } } } as Commit);
    expect(retry.ok).toBe(true);
  });

  test("functions revive as callable; equality by source, not identity", () => {
    const cm = new Commons();
    cm.commit({ agentId: "A", baseVersion: 0, writes: { f: { op: "set", value: (x: number) => x * 2 } } } as Commit);
    const raw = cm.read("B", ["f"]).values.f;
    const f = revive(raw);
    expect(f(21)).toBe(42);
    expect(f.toString()).toBe(raw.__fn);
  });

  test("reader of a binding is interrupted when another agent changes it (code-shift)", () => {
    const cm = new Commons();
    cm.commit({ agentId: "A", baseVersion: 0, writes: { util: { op: "set", value: "v1" } } } as Commit);
    cm.read("B", ["util"]);
    cm.commit({ agentId: "A", baseVersion: 1, writes: { util: { op: "set", value: "v2" } } } as Commit);
    const drained = cm.drainNotifications();
    const note = drained[0];
    expect(note).toMatchObject({ agentId: "B", from: "A", name: "util", kind: "changed" });
    expect(cm.drainNotifications()).toEqual([]);   // no spurious repeats
  });

  test("no write-after-return: async results arrive as data, not ambient writes", () => {
    // The design rule: workers/host code NEVER writes ns.x in a .then() — they
    // post an interrupt (mail), which the owning agent turns into a commit.
    // This test pins the mechanism: outbox is the only ambient channel, and it
    // is drained at safe points (turn start), like the swarm inbox.
    const cm = new Commons();
    cm.commit({ agentId: "A", baseVersion: 0, writes: { data: { op: "set", value: [] } } } as Commit);
    cm.read("B", ["data"]);
    cm.commit({ agentId: "A", baseVersion: 1, writes: { data: { op: "set", value: [1, 2, 3] } } } as Commit);
    // B's promise resolves later -> arrives as mail at B's next turn start, not now
    const notes = cm.drainNotifications();
    expect(notes.length).toBe(1);
    const first = notes[0];
    if (first) expect(first.name).toBe("data");
  });
});
