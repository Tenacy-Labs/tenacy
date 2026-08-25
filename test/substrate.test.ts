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

function sinkSpy() {
  const calls: Array<Record<string, unknown>> = [];
  const sink = (i: Record<string, unknown>) => {
    calls.push(i);
    return { op: String(i.op), ok: true, result: "queued" };
  };
  return { calls, sink };
}

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
  test("denied grants refuse inbound; granted plugins steer and observe", () => {
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
    const { loader, loaded } = bootPlugins(
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

  test("a plugin whose init throws is dropped, boot survives", () => {
    const bad: Plugin = { name: "bad", init: () => { throw new Error("boom"); } };
    const { loaded } = bootPlugins(new EventBus(), { submitSteering: () => {}, spawnTurn: () => ({ ok: true, queued: true }) }, [bad]);
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
    const { calls, sink } = sinkSpy();
    const mounted = mountNamespace({ sink, writableRoots: ["/tmp/"] });
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

    // rw requested OUTSIDE granted roots degrades to read-only
    const outside = mounted.lenses.files.open("/etc/hosts", { mode: "rw" });
    expect(outside instanceof WritableFileHandle).toBe(false);

    // idempotent second mount: binding already sealed, no redefine attempt
    mountNamespace({ sink, writableRoots: [] });
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

    // breakpoints are not part of the surface
    const bp = JSON.parse(dap.handle(JSON.stringify({ seq: 6, type: "request", command: "setBreakpoints", arguments: {} })) ?? "{}");
    expect(bp.success).toBe(false);
  });
});

describe("events guard", () => {
  test("isPluginEmitted discriminates", () => {
    expect(isPluginEmitted({ kind: "steer.request", text: "t", note: "n" })).toBe(true);
    expect(isPluginEmitted({ kind: "turn.started", turn: 1 })).toBe(false);
    expect(isPluginEmitted(null)).toBe(false);
  });
});
