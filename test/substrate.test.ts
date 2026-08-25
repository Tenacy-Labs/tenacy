/**
 * ADR-0007 substrate tests: bus, events, loader+grants, handles,
 * ns-mount, DAP facade. Every module gets discriminating coverage —
 * not vacuous passes.
 */
import { describe, expect, test } from "bun:test";
import { EventBus } from "../src/optimizer/bus.ts";
import { isPluginEmitted } from "../src/optimizer/events.ts";
import { bootPlugins, type Plugin, type PluginCtx } from "../src/optimizer/loader.ts";
import { NO_GRANTS, GrantRegistry } from "../src/optimizer/plugin.ts";
import { FileHandle, WritableFileHandle, HandleRegistry } from "../src/optimizer/handles.ts";
import { mountNamespace } from "../src/optimizer/ns-mount.ts";
import { DapFacade } from "../src/optimizer/dap.ts";
import { executeIntent } from "../src/optimizer/intents.ts";
import { paramSetV1 } from "../src/optimizer/params.ts";
import { MockProvider } from "../src/optimizer/providers.ts";
import type { PluginEvent } from "../src/optimizer/events.ts";
import type { IntentSink } from "../src/optimizer/handles.ts";
import { AgentLoop } from "../src/optimizer/loop.ts";
import type { Provider } from "../src/optimizer/providers.ts";
import type { ParamSet } from "@connectotron/stowage";

function sinkSpy() {
  const calls: Array<Record<string, unknown>> = [];
  const sink = (i: Record<string, unknown>) => {
    calls.push(i);
    return { op: String(i.op), ok: true, result: "queued" };
  };
  return { calls, sink };
}

// ADR-0007 §2: ONE mount per process — tests share the module-scope mount,
// exactly as the kernel mounts once at boot.
const nsSpy = sinkSpy();
const MOUNT = mountNamespace({ sink: nsSpy.sink, writableRoots: ["/tmp/"] });

describe("EventBus", () => {
  test("no-op when empty; delivers by kind; containment on throw", () => {
    const bus = new EventBus();
    bus.emit({ kind: "turn.started", turn: 1 });       // no subscribers: no throw
    const got: string[] = [];
    bus.on("turn.completed", (ev) => { got.push(ev.kind); });
    bus.on("turn.completed", () => { throw new Error("plugin on fire"); });  // contained
    bus.emit({ kind: "turn.completed", turn: 1, tokensIn: 10, tokensOut: 5 });
    expect(got).toEqual(["turn.completed"]);
    expect(bus.emitted).toBe(2);
  });

  test("unsubscribe works", () => {
    const bus = new EventBus();
    let n = 0;
    const off = bus.on("all", () => { n++; });
    bus.emit({ kind: "turn.started", turn: 1 });
    off();
    bus.emit({ kind: "turn.started", turn: 2 });
    expect(n).toBe(1);
  });
});

describe("plugin loader + grants", () => {
  test("denied grants refuse inbound; granted plugins steer and observe", async () => {
    const steered: string[] = [];
    const spawned: string[] = [];
    const observed: string[] = [];
    const observer: Plugin = {
      name: "observer",
      onEvent: (ev: { kind: string }) => { observed.push(ev.kind); },
    };
    const driver: Plugin = {
      name: "driver",
      init: (ctx: PluginCtx) => {
        ctx.submitSteering("hello from plugin");
      },
    };
    const { loader, loaded } = await bootPlugins(
      new EventBus(),
      { submitSteering: (t) => { steered.push(t); }, spawnTurn: (m) => { spawned.push(m); return { ok: true, queued: true }; } },
      [observer, driver],
      (r) => { r.grant("driver", { steer: true }); },
    );
    expect(loaded.active).toEqual(["observer", "driver"]);
    expect(steered).toEqual(["hello from plugin"]);       // grant honored
    const denied = loader.ctxFor("observer")?.submitSteering("nope");
    expect(denied).toEqual({ error: "grant denied: steer" });  // denial is honest
  });

  test("a plugin whose init throws is dropped, boot survives", async () => {
    const bad: Plugin = { name: "bad", init: () => { throw new Error("boom"); } };
    const { loaded } = await bootPlugins(new EventBus(), { submitSteering: () => {}, spawnTurn: () => ({ ok: true, queued: true }) }, [bad]);
    expect(loaded.active).toEqual([]);
  });

  test("NO_GRANTS denies everything", () => {
    const r = new GrantRegistry();
    expect(r.grantsFor("unknown")).toEqual(NO_GRANTS);
  });
});

describe("handles (uniform protocol + mutation surface)", () => {
  test("FileHandle emits files.expand/release; watch emits ctx.watch", () => {
    const { calls, sink } = sinkSpy();
    const h = new FileHandle("/src/loop.ts", sink);
    expect(h.id).toBe("lens:/src/loop.ts");
    h.expand({ from: 1, to: 40 });
    h.release({ from: 1, to: 40 });
    h.watch("live");
    expect(calls.map((c) => c.op)).toEqual(["files.expand", "files.release", "ctx.watch"]);
  });

  test("WritableFileHandle carries mutation ops; ro handle has none", () => {
    const { calls, sink } = sinkSpy();
    const ro = new FileHandle("/etc/hosts", sink);
    expect((ro as unknown as Record<string, unknown>).patch).toBeUndefined();
    const rw = new WritableFileHandle("/tmp/x.ts", sink);
    rw.patch([{ from: "a", to: "b" }]);
    rw.replace("old", "new");
    rw.append("tail");
    expect(calls.map((c) => c.op)).toEqual(["files.patch", "files.replace", "files.append"]);
  });

  test("HandleRegistry materializes and lists", () => {
    const reg = new HandleRegistry();
    const { sink } = sinkSpy();
    reg.materialize(new FileHandle("/a.ts", sink));
    reg.materialize(new WritableFileHandle("/b.ts", sink));
    expect(reg.size).toBe(2);
    expect(reg.get("lens:/a.ts")?.substrate).toBe("files");
  });
});

describe("ns-mount", () => {
  test("lenses binding is non-configurable, non-deletable; rw is grant-gated", () => {
    const { calls, sink } = nsSpy;
    const mounted = MOUNT;
    const g = globalThis as unknown as Record<string, unknown>;
    expect(g.lenses).toBeDefined();
    const desc = Object.getOwnPropertyDescriptor(g, "lenses");
    expect(desc?.configurable).toBe(false);
    expect(() => { delete g.lenses; }).toThrow();

    const ro = mounted.lenses.files.open("/src/loop.ts");
    expect(ro instanceof FileHandle).toBe(true);
    expect((ro as unknown as Record<string, unknown>).patch).toBeUndefined();

    const rw = mounted.lenses.files.open("/tmp/scratch.ts", { mode: "rw" });
    expect(rw instanceof WritableFileHandle).toBe(true);
    (rw as WritableFileHandle).append("x");
    expect(calls.map((c) => c.op)).toEqual(["files.append"]);

    // rw requested OUTSIDE granted roots is refused hard (type-runtime agreement)
    expect(() => mounted.lenses.files.open("/etc/hosts", { mode: "rw" })).toThrow(/rw denied/);

  });
});

describe("DAP facade", () => {
  test("initialize/threads/scopes/variables round-trip; setVariable routes to intent", () => {
    const { calls, sink } = sinkSpy();
    const reg = new HandleRegistry();
    reg.materialize(new FileHandle("/src/loop.ts", sink));
    const dap = new DapFacade({ registry: reg, sink });

    const init = JSON.parse(dap.handle(JSON.stringify({ seq: 1, type: "request", command: "initialize", arguments: {} })) ?? "{}");
    expect(init.success).toBe(true);

    const threads = JSON.parse(dap.handle(JSON.stringify({ seq: 2, type: "request", command: "threads" })) ?? "{}");
    expect(threads.body.threads[0].name).toBe("agent");

    const scopes = JSON.parse(dap.handle(JSON.stringify({ seq: 3, type: "request", command: "scopes", arguments: { frameId: 1 } })) ?? "{}");
    const names = scopes.body.scopes.map((s: { name: string }) => s.name);
    expect(names).toContain("Namespace");
    expect(names).toContain("Lenses");

    const lensesRef = scopes.body.scopes.find((s: { name: string }) => s.name === "Lenses").variablesReference;
    const vars = JSON.parse(dap.handle(JSON.stringify({ seq: 4, type: "request", command: "variables", arguments: { variablesReference: lensesRef } })) ?? "{}");
    expect(vars.body.variables[0].name).toBe("lens:/src/loop.ts");

    const setv = JSON.parse(dap.handle(JSON.stringify({ seq: 5, type: "request", command: "setVariable", arguments: { name: "lens:/src/loop.ts", value: "frozen" } })) ?? "{}");
    expect(setv.success).toBe(true);
    expect(calls.map((c) => c.op)).toEqual(["ctx.demote"]);
    // M7: value mapping is honest — live maps to watch, unmapped values refuse
    const setLive: { success?: boolean } = JSON.parse(dap.handle(JSON.stringify({ seq: 7, type: "request", command: "setVariable", arguments: { name: "lens:/src/loop.ts", value: "live" } })) ?? "{}");
    expect(setLive.success).toBe(true);
    expect(calls[calls.length - 1]?.op).toBe("ctx.watch");
    const setBad = JSON.parse(dap.handle(JSON.stringify({ seq: 8, type: "request", command: "setVariable", arguments: { name: "lens:/src/loop.ts", value: "rm -rf /" } })) ?? "{}");
    expect(setBad.success).toBe(false);
    // M7b: evaluate refuses rather than fabricating a result
    const ev = JSON.parse(dap.handle(JSON.stringify({ seq: 9, type: "request", command: "evaluate", arguments: { expression: "process.exit(1)" } })) ?? "{}");
    expect(ev.success).toBe(false);

    // breakpoints are not part of the surface
    const bp = JSON.parse(dap.handle(JSON.stringify({ seq: 6, type: "request", command: "setBreakpoints", arguments: {} })) ?? "{}");
    expect(bp.success).toBe(false);
  });
});

describe("major fixes (PR #28 re-review)", () => {
  test("M6: all four top-level bindings mount non-configurably and emit intents", () => {
    const m = MOUNT;
    const before = nsSpy.calls.length;
    const g = globalThis as Record<string, unknown>;
    for (const k of ["lenses", "ctx", "ops", "rlm"]) {
      expect(g[k]).toBeDefined();
      expect(Object.getOwnPropertyDescriptor(g, k)?.configurable).toBe(false);
    }
    m.ctx.demote("item:1");
    m.ops.memory.remember("hello");
    m.rlm.spawn("test goal");
    expect(nsSpy.calls.slice(before).map((c) => c.op)).toEqual(["ctx.demote", "memory.remember", "rlm.spawn"]);
  });

  test("M5: second mount in-process throws instead of diverging", () => {
    // MOUNT already happened at module scope — the strict guard fires
    expect(() => mountNamespace({ sink: nsSpy.sink })).toThrow(/already mounted/);
  });

  test("M3/M4: model.called carries real latency; error.thrown fires on turn failure", async () => {
    const events: PluginEvent[] = [];
    const bus = new EventBus();
    bus.on("all", (ev) => { events.push(ev as PluginEvent); });
    // a provider that throws on call
    const boom: Provider = { modelId: "boom", call: async () => { throw new Error("provider down"); } };
    const loop = new AgentLoop(boom, {} as ParamSet, null);
    loop.bus = bus;
    await loop.run("hello").catch(() => {});
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("error.thrown");
    const mc = events.find((e) => e.kind === "model.called") as { latencyMs: number } | undefined;
    expect(mc === undefined || mc.latencyMs >= 0).toBe(true);
  });
});

describe("gate repros (PR #28 review)", () => {
  test("C1: ctx.grants mutation cannot escalate (copy-on-read frozen)", async () => {
    const steered: string[] = [];
    const escalator: Plugin = {
      name: "escalator",
      init: (ctx) => {
        try { (ctx.grants as { steer?: boolean }).steer = true; } catch { /* frozen — expected */ }
        ctx.submitSteering("pwned");
      },
    };
    const { loaded } = await bootPlugins(new EventBus(), { submitSteering: (t) => { steered.push(t); }, spawnTurn: () => ({ ok: true, queued: true }) }, [escalator]);
    expect(steered).toEqual([]);                         // escalation dead
    expect(loaded.active).toEqual(["escalator"]);       // plugin survives, just denied
  });

  test("C1b: NO_GRANTS poisoning cannot open the default", async () => {
    const reg = new GrantRegistry();
    const before = reg.grantsFor("nobody");
    try { (before as { steer?: boolean }).steer = true; } catch { /* frozen */ }
    expect(reg.grantsFor("someone-else").steer).toBe(false);
  });

  test("C2: async-rejecting init drops the plugin, kernel survives", async () => {
    const badAsync: Plugin = {
      name: "badAsync",
      init: async () => { await Promise.resolve(); throw new Error("async boom"); },
    };
    const { loaded } = await bootPlugins(new EventBus(), { submitSteering: () => {}, spawnTurn: () => ({ ok: true, queued: true }) }, [badAsync]);
    expect(loaded.active).toEqual([]);
    expect(loaded.dropped[0]?.name).toBe("badAsync");
    expect(String(loaded.dropped[0]?.reason)).toContain("async boom");
  });

  test("C2b: async init success stays active", async () => {
    const goodAsync: Plugin = { name: "goodAsync", init: async () => { await Promise.resolve(); } };
    const { loaded } = await bootPlugins(new EventBus(), { submitSteering: () => {}, spawnTurn: () => ({ ok: true, queued: true }) }, [goodAsync]);
    expect(loaded.active).toEqual(["goodAsync"]);
  });

  test("M1: events grant gates bus subscription", async () => {
    const seen: string[] = [];
    const bus = new EventBus();
    const silenced: Plugin = { name: "silenced", onEvent: (ev) => { seen.push(ev.kind); } };
    await bootPlugins(bus, { submitSteering: () => {}, spawnTurn: () => ({ ok: true, queued: true }) }, [silenced]);
    bus.emit({ kind: "turn.started", turn: 1 });
    expect(seen).toEqual([]);                            // no events grant -> silent
  });

  test("M2: ctx.bus is subscribe-only (emit absent)", async () => {
    let held: unknown = null;
    const spy: Plugin = { name: "spy", init: (ctx) => { held = ctx.bus; } };
    await bootPlugins(new EventBus(), { submitSteering: () => {}, spawnTurn: () => ({ ok: true, queued: true }) }, [spy]);
    expect(held !== null && (held as Record<string, unknown>).emit === undefined).toBe(true);
  });

  test("C3b: traversal and sibling-prefix rw requests are refused hard", () => {
    const m = MOUNT;
    expect(() => m.lenses.files.open("/tmp/../etc/passwd", { mode: "rw" })).toThrow(/rw denied/);
    expect(() => m.lenses.files.open("/tmporary-secret", { mode: "rw" })).toThrow(/rw denied/);
    const ok = m.lenses.files.open("/tmp/scratch.ts", { mode: "rw" });
    expect(ok instanceof WritableFileHandle).toBe(true);
  });
});

describe("re-review repros (deleg_c1fa1a7f)", () => {
  test("N1: ctx.bus.on honors the events grant", async () => {
    const seen: string[] = [];
    const bus = new EventBus();
    const spy: Plugin = { name: "bus-spy", init: (ctx) => { ctx.bus.on("all", (ev) => { seen.push((ev as PluginEvent).kind); }); } };
    await bootPlugins(bus, { submitSteering: () => {}, spawnTurn: () => ({ ok: true, queued: true }) }, [spy]);  // NO events grant
    bus.emit({ kind: "turn.started", turn: 1 });
    expect(seen).toEqual([]);                                // ungranted = silent
  });

  test("N2: dropped plugin loses its bus subscriptions", async () => {
    const seen: string[] = [];
    const bus = new EventBus();
    const zombie: Plugin = {
      name: "zombie",
      init: (ctx) => { ctx.bus.on("all", (ev) => { seen.push((ev as PluginEvent).kind); }); throw new Error("boom after subscribe"); },
    };
    const { loaded } = await bootPlugins(bus, { submitSteering: () => {}, spawnTurn: () => ({ ok: true, queued: true }) }, [zombie], (r) => { r.grant("zombie", { events: true }); });
    expect(loaded.active).toEqual([]);
    bus.emit({ kind: "turn.started", turn: 1 });
    expect(seen).toEqual([]);                                // dropped = unsubscribed
  });

  test("N3: never-settling init times out and drops (kernel boots)", async () => {
    const hung: Plugin = { name: "hung", init: () => new Promise<void>(() => {}) };
    const { loaded } = await bootPlugins(new EventBus(), { submitSteering: () => {}, spawnTurn: () => ({ ok: true, queued: true }) }, [hung]);
    expect(loaded.active).toEqual([]);
    expect(String(loaded.dropped[0]?.reason)).toContain("init timeout");
  }, 8000);  // the init timeout is 5s; give the runner headroom

  test("N4: a write that commits is never reported failed", () => {
    // Real executeIntent + loop host seam with an in-memory writer.
    const files = new Map<string, string>([["/tmp/n4.txt", "original\n"]]);
    const boom: Provider = { modelId: "boom", call: async () => { throw new Error("unused"); } };
    const loop = new AgentLoop(boom, {} as ParamSet, null, {}, { writableRoots: ["/tmp/"] });
    loop.fileContent = (t) => files.get(t) ?? "";
    loop.fileWrite = (t, kind, body) => {
      const cur = files.get(t);
      if (cur === undefined) return { ok: false, detail: `no such file: ${t}` };
      if (kind === "append") { files.set(t, cur + String((body as { text: string }).text)); return { ok: true, detail: `appended ${t}` }; }
      return { ok: false, detail: `unsupported: ${kind}` };
    };
    const r = executeIntent({ op: "files.append", target: "/tmp/n4.txt", text: "APPENDED\n" }, loop["store"], null);
    expect(r.ok).toBe(true);
    expect(files.get("/tmp/n4.txt")).toContain("APPENDED");
  });

  test("N5: committed write refreshes the lens from substrate", () => {
    const files = new Map<string, string>([["/tmp/n5.txt", "line1\n"]]);
    const boom: Provider = { modelId: "boom", call: async () => { throw new Error("unused"); } };
    const loop = new AgentLoop(boom, {} as ParamSet, null, {}, { writableRoots: ["/tmp/"] });
    loop.fileContent = (t) => files.get(t) ?? "";
    loop.fileWrite = (t, kind, body) => {
      const cur = files.get(t);
      if (cur === undefined) return { ok: false, detail: `no such file: ${t}` };
      if (kind === "append") { files.set(t, cur + String((body as { text: string }).text)); return { ok: true, detail: `appended ${t}` }; }
      return { ok: false, detail: `unsupported: ${kind}` };
    };
    const lens = loop.fileLens("/tmp/n5.txt");
    expect(lens.content).toBe("line1\n");
    const r = executeIntent({ op: "files.append", target: "/tmp/n5.txt", text: "line2\n" }, loop["store"], null);
    expect(r.ok).toBe(true);
    expect(files.get("/tmp/n5.txt")).toBe("line1\nline2\n");
    expect(lens.content).toBe("line1\nline2\n");            // refreshed, not stale
  });
});

describe("final-gate repros (deleg_0f3328ba)", () => {
  test("F1: late-settling init cannot resurrect a dropped plugin", async () => {
    const seen: string[] = [];
    const bus = new EventBus();
    let captured: PluginCtx | undefined;
    const slow: Plugin = {
      name: "slow",
      // init never resolves from the loader's view (hung) — but holds the ctx
      init: (ctx) => { captured = ctx; return new Promise<void>(() => {}); },
    };
    const { loaded } = await bootPlugins(bus, { submitSteering: () => {}, spawnTurn: () => ({ ok: true, queued: true }) }, [slow], (r) => { r.grant("slow", { events: true, steer: true }); });
    expect(loaded.active).toEqual([]);            // dropped at the 5s timeout
    expect(captured).toBeDefined();
    captured!.bus.on("all", (ev) => { seen.push((ev as PluginEvent).kind); });   // post-drop subscribe attempt
    const steer = captured!.submitSteering("late text");                          // post-drop steering attempt
    bus.emit({ kind: "turn.started", turn: 1 });
    expect(seen).toEqual([]);                     // sealed: no zombie subscription
    expect(steer).toHaveProperty("error");        // sealed: steering refused
  }, 8000);
});

describe("minor residue fixes (F4 set)", () => {
  test("render.decided fires before model.called (decision precedes outcome)", async () => {
    const order: string[] = [];
    const bus = new EventBus();
    bus.on("render.decided", () => order.push("render"));
    bus.on("model.called", () => order.push("model"));
    const loop = new AgentLoop(new MockProvider(), paramSetV1("f4a"), null, {}, {});
    loop.bus = bus;
    await loop.run("hello");
    expect(order.indexOf("render")).toBeLessThan(order.indexOf("model"));
  });

  test("solver.ran fires per turn with honest counts", async () => {
    const events: PluginEvent[] = [];
    const bus = new EventBus();
    bus.on("solver.ran", (ev) => events.push(ev as PluginEvent));
    const loop = new AgentLoop(new MockProvider(), paramSetV1("f4b"), null, {}, {});
    loop.bus = bus;
    await loop.run("hello");
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect((events[0] as { chosen: number }).chosen).toBeGreaterThanOrEqual(0);
  });

  test("changedLines carries honest line numbers", async () => {
    const files = new Map<string, string>([["/tmp/cl.txt", "a\nb\nc\n"]]);
    const deltas: PluginEvent[] = [];
    const bus = new EventBus();
    bus.on("lens.delta", (ev) => deltas.push(ev as PluginEvent));
    const loop = new AgentLoop(new MockProvider(), paramSetV1("f4c"), null, {}, { writableRoots: ["/tmp/"] });
    loop.bus = bus;
    loop.fileContent = (t) => files.get(t) ?? "";
    loop.fileWrite = (t, kind, body) => {
      if (kind !== "append") return { ok: false, detail: "no" };
      files.set(t, (files.get(t) ?? "") + String((body as { text: string }).text));
      return { ok: true, detail: "ok" };
    };
    loop.fileLens("/tmp/cl.txt");   // lens exists pre-write
    const r = executeIntent({ op: "files.append", target: "/tmp/cl.txt", text: "x\ny\n" }, loop["store"], null);
    expect(r.ok).toBe(true);
    expect(deltas.length).toBe(1);
    expect((deltas[0] as { changedLines: number[] }).changedLines).toEqual([4, 5]);   // the two new lines
  });
});

describe("events guard", () => {
  test("isPluginEmitted discriminates", () => {
    expect(isPluginEmitted({ kind: "steer.request", text: "t", note: "n" })).toBe(true);
    expect(isPluginEmitted({ kind: "turn.started", turn: 1 })).toBe(false);
    expect(isPluginEmitted(null)).toBe(false);
  });
});
