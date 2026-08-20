import { describe, test, expect, beforeAll } from "bun:test";
import { Kernel } from "../src/kernel.ts";
import { mkdtempSync, rmSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "agent-kernel-")); });

describe("Kernel: live execution", () => {
  test("cells share global scope; namespace harvest works", () => {
    const k = new Kernel(join(dir, "t1.journal"), join(dir, "t1.snap"));
    k.eval("var alphaA = 40");
    const r = k.eval("alphaA + 2");
    expect(r.ok).toBe(true);
    expect(r.value).toBe(42);
    expect(k.ns.alphaA).toBe(40);
  });

  test("failed cell is journaled, snapshotted, non-fatal", () => {
    const k = new Kernel(join(dir, "t2.journal"), join(dir, "t2.snap"));
    const r = k.eval("throw new Error('boom')");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("boom");
    expect(k.cells.length).toBe(1);
    expect(existsSync(join(dir, "t2.snap"))).toBe(true);
  });
});

describe("Kernel: serialization fidelity", () =>  {
  test("primitives update live values, not binding-time captures (invariant 4)", () => {
    const k = new Kernel(join(dir, "t3.journal"), join(dir, "t3.snap"));
    k.eval("var betaCount = 0");
    k.eval("function betaFib(n){ betaCount++; return n<2 ? n : betaFib(n-1)+betaFib(n-2) }");
    k.eval("var betaResults = [betaFib(15), betaFib(20)]");
    expect(k.ns.betaCount).toBeGreaterThan(1000);
  });

  test("Map/Set/Date/RegExp round-trip through snapshot and recover", () => {
    const k = new Kernel(join(dir, "t4.journal"), join(dir, "t4.snap"));
    k.eval("var gammaM = new Map([['k','v'],['n',2]])");
    k.eval("var gammaS = new Set([1,2,3])");
    k.eval("var gammaD = new Date('2026-08-20T00:00:00Z')");
    k.eval("var gammaRe = /ab+c/gi");
    const rec = Kernel.recover(join(dir, "t4.journal"), join(dir, "t4.snap"));
    expect(rec.k.ns.gammaM instanceof Map).toBe(true);
    expect((rec.k.ns.gammaM as Map<string, any>).get("n")).toBe(2);
    expect(rec.k.ns.gammaS instanceof Set).toBe(true);
    expect((rec.k.ns.gammaS as Set<any>).size).toBe(3);
    expect((rec.k.ns.gammaD as Date).toISOString()).toBe("2026-08-20T00:00:00.000Z");
    expect((rec.k.ns.gammaRe as RegExp).test("ABBC")).toBe(true);
  });

  test("functions revive as callable from fn-source", () => {
    const k = new Kernel(join(dir, "t5.journal"), join(dir, "t5.snap"));
    k.eval("function deltaDouble(x){ return x*2 }");
    const rec = Kernel.recover(join(dir, "t5.journal"), join(dir, "t5.snap"));
    expect(typeof rec.k.ns.deltaDouble).toBe("function");
    expect((rec.k.ns.deltaDouble as (x: number) => number)(21)).toBe(42);
    rec.k.eval("var deltaCheck = deltaDouble(21)");
    expect(rec.k.ns.deltaCheck).toBe(42);
  });

  test("cyclic and non-serializable values become tombstones; turns never crash", () => {
    const k = new Kernel(join(dir, "t6.journal"), join(dir, "t6.snap"));
    const r1 = k.eval("var epsA = { name: 'root' }; var epsB = { parent: epsA }; epsA.child = epsB");
    const r2 = k.eval("var epsBuf = new ArrayBuffer(8)");
    const r3 = k.eval("var epsN = 41 + 1");
    expect(r1.ok && r2.ok && r3.ok).toBe(true);
    expect(k.ns.epsN).toBe(42);
    const snap = JSON.parse(readFileSync(join(dir, "t6.snap"), "utf8"));
    expect(snap.tombstones).toContain("epsA");
    expect(snap.tombstones).toContain("epsBuf");
    expect(snap.data.epsN).toBe(42);
  });
});

describe("Kernel: invariants 1-2 — never replay, side effects exactly-once", () => {
  test("recovery replays zero cells even with journal present", () => {
    const k = new Kernel(join(dir, "t7.journal"), join(dir, "t7.snap"));
    k.eval("var zetaX = 1");
    k.eval("var zetaY = zetaX + 1");
    const rec = Kernel.recover(join(dir, "t7.journal"), join(dir, "t7.snap"));
    expect(rec.replayed).toBe(0);
    expect(rec.k.ns.zetaY).toBe(2);
  });

  test("file-append side effect fires exactly once across crash+recovery", () => {
    const sideFile = join(dir, "sideeffect.txt");
    rmSync(sideFile, { force: true });
    (globalThis as any).appendLine = (s: string) => appendFileSync(sideFile, s + "\n");
    const k = new Kernel(join(dir, "t8.journal"), join(dir, "t8.snap"));
    k.eval("appendLine('once')");
    expect(readFileSync(sideFile, "utf8").trim().split("\n").length).toBe(1);
    const rec = Kernel.recover(join(dir, "t8.journal"), join(dir, "t8.snap"));
    expect(rec.replayed).toBe(0);
    expect(readFileSync(sideFile, "utf8").trim().split("\n").length).toBe(1); // not re-fired
    rec.k.eval("appendLine('new-action')");
    expect(readFileSync(sideFile, "utf8").trim().split("\n").length).toBe(2);
  });

  test("total persistence failure => empty namespace, never re-execution", () => {
    const k = new Kernel(join(dir, "t9.journal"), join(dir, "t9.snap"));
    k.eval("var etaA = 1");
    rmSync(join(dir, "t9.snap"), { force: true });
    const rec = Kernel.recover(join(dir, "t9.journal"), join(dir, "t9.snap"));
    expect(Object.keys(rec.k.ns).length).toBe(0);
    expect(rec.seeded).toBe(0);
    expect(rec.replayed).toBe(0);
  });

  test("tombstoned values surface explicitly after recovery", () => {
    const k = new Kernel(join(dir, "t10.journal"), join(dir, "t10.snap"));
    k.eval("var thetaBuf = new ArrayBuffer(8)");
    const rec = Kernel.recover(join(dir, "t10.journal"), join(dir, "t10.snap"));
    expect(rec.k.ns.thetaBuf?.__dead).toBe(true);
    expect(rec.k.ns.thetaBuf?.kind).toBe("unrestorable");
  });

  test("fresh-process crash recovery (spawned child; lesson: in-process tests false-pass)", () => {
    const p = Bun.spawnSync(["bun", "fresh-recovery.ts"], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
    process.stdout.write(p.stdout.toString());
    if (p.exitCode !== 0) process.stderr.write(p.stderr.toString());
    expect(p.exitCode).toBe(0);
  });
});
