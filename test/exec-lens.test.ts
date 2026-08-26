/**
 * Exec lens tests — collection + per-run lens model (Daniel ruling
 * 2026-08-26: runs are a collection; each run is its own Lens object).
 * Deterministic injected runner; never a real shell in unit tests.
 */
import { describe, expect, test } from "bun:test";
import { ExecCollection, ExecRunLens, type ExecRunner } from "../src/optimizer/exec-lens.ts";
import { NSLensItem } from "../src/optimizer/ns-lens.ts";
import { executeIntent, bindHost, type IntentHost } from "../src/optimizer/intents.ts";
import { ContextStore } from "../src/optimizer/store.ts";

const fakeRunner: ExecRunner = (cmd: string) =>
  cmd === "fail" ? { exit: 1, out: "boom" } : { exit: 0, out: `ran: ${cmd}` };

const attached: ExecRunLens[] = [];
const mkCollection = () => new ExecCollection(fakeRunner, (l) => attached.push(l));

describe("ExecCollection", () => {
  test("run materializes its OWN lens, attached via callback", () => {
    const c = mkCollection();
    const l = c.run("bun test", 3);
    expect(l).toBeInstanceOf(ExecRunLens);
    expect(l.id).toBe("lens:exec#1");
    expect(l.run.exit).toBe(0);
    expect(attached).toContain(l);
    expect(c.listingLines()[0]).toBe("#1  exit=0  bun test");
  });

  test("each run gets a distinct lens id and object identity", () => {
    const c = mkCollection();
    const a = c.run("a", 1);
    const b = c.run("b", 2);
    expect(a.id).toBe("lens:exec#1");
    expect(b.id).toBe("lens:exec#2");
    expect(a).not.toBe(b);
    expect(c.lenses.size).toBe(2);
  });

  test("per-run lens renders its own content via the Lens template", () => {
    const c = mkCollection();
    const l = c.run("bun test", 3);
    expect(l.fullText()).toContain("#. bun test (exit 0, t3)");
    expect(l.fullText()).toContain("ran: bun test");
    expect(l.compactText()).toBe("⟨exec #1: exit=0, bun test⟩");
    // options() from the base class: FULL-only first write (no base yet)
    const opts = l.options();
    expect(opts.some((o) => o.id === "full")).toBe(true);
  });

  test("drop removes runs and lenses from the collection", () => {
    const c = mkCollection();
    c.run("a", 1); c.run("b", 2);
    expect(c.drop([1])).toBe(true);
    expect(c.runs.length).toBe(1);
    expect(c.lenses.has(1)).toBe(false);
    expect(c.drop([1])).toBe(false);
  });

  test("failed run carries exit code honestly", () => {
    const c = mkCollection();
    const l = c.run("fail", 1);
    expect(l.run.exit).toBe(1);
    expect(l.fullText()).toContain("boom");
  });

  test("nsProducer: children list runs; commitsSince replays additions", () => {
    const c = mkCollection();
    c.run("a", 2); c.run("b", 5);
    const p = c.nsProducer();
    const kids = p.children("exec");
    expect(kids.map((k) => k.path)).toEqual(["exec/#1", "exec/#2"]);
    expect(kids[0]?.kind).toBe("value");
    const commits = p.commitsSince(2);
    expect(commits.some((x) => x.turn === 5 && x.changes[0]?.path === "exec/#2")).toBe(true);
    expect(p.commitsSince(5).length).toBe(0);
  });

  test("integration through NSLensItem: focus exec lists runs", () => {
    const c = mkCollection();
    c.run("bun test", 3);
    const ns = new NSLensItem("lens:ns:exec", "exec", c.nsProducer());
    ns.focus("exec");
    expect(ns.listingLines().some((x) => x.includes("exec/#1"))).toBe(true);
    ns.projection = "content";
    expect(ns.listingLines().some((x) => x.includes("exit=0"))).toBe(true);
  });
});

describe("exec intents (wired through the host)", () => {
  const setup = () => {
    const store = new ContextStore();
    const collection = new ExecCollection(fakeRunner);
    const host = {
      fileLens: () => { throw new Error("unused"); },
      writePatch: () => ({ ok: false, detail: "" }),
      writeReplace: () => ({ ok: false, detail: "" }),
      writeAppend: () => ({ ok: false, detail: "" }),
      isWritable: () => false,
      dirLens: () => { throw new Error("unused"); },
      codeLens: () => { throw new Error("unused"); },
      nsLens: () => { throw new Error("unused"); },
      exec: () => collection,
      convoTurn: () => undefined,
      convoTurnIds: () => [],
      goal: () => undefined,
      setGoal: () => {},
      addStoreItem: () => {},
    } as unknown as IntentHost;
    bindHost(host);
    return { store, collection };
  };

  test("exec.run returns receipt naming the per-run lens", () => {
    const { store } = setup();
    const r = executeIntent({ op: "exec.run", cmd: "bun test" }, store, null);
    expect(r.ok).toBe(true);
    expect(r.result).toContain("#1 exit=0");
    expect(r.result).toContain("lens:exec#1");
  });

  test("exec.list lists runs", () => {
    const { store } = setup();
    executeIntent({ op: "exec.run", cmd: "bun test" }, store, null);
    const r = executeIntent({ op: "exec.list" }, store, null);
    expect(r.ok).toBe(true);
    expect(r.result).toContain("#1");
  });

  test("exec.release drops run + removes its store item", () => {
    const { store, collection } = setup();
    const lens = executeIntent({ op: "exec.run", cmd: "bun test" }, store, null);
    expect(lens.ok).toBe(true);
    const r = executeIntent({ op: "exec.release", ids: [1] }, store, null);
    expect(r.ok).toBe(true);
    expect(collection.runs.length).toBe(0);
  });

  test("shellRunner timeout yields honest marker", async () => {
    const { shellRunner } = await import("../src/optimizer/exec-lens.ts");
    const r = shellRunner("sleep 5", 300);
    expect([124, 137]).toContain(r.exit);
    expect(r.out).toContain("timeout");
  });

  test("shellRunner captures stdout and stderr", async () => {
    const { shellRunner } = await import("../src/optimizer/exec-lens.ts");
    const r = shellRunner("echo hi; echo err >&2", 3000);
    expect(r.exit).toBe(0);
    expect(r.out).toContain("hi");
    expect(r.out).toContain("err");
  });
});
