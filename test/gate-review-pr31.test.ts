/**
 * Gate-review regression tests (2026-08-27, PRs #31 review cycle).
 *
 * Each test pins one review finding; all verified fail-under-revert:
 *  - A-M3/C1: op smuggling through tool input must NOT redirect an op
 *  - C1: exec.run is not model-callable; deny-by-default runner
 *  - C1: model-controlled timeout clamped to positive bounded range
 *  - B-M2: 20KB cap is byte-based and marks truncation
 *  - B-M1: exec runs round-trip session save/restore without rerun
 *  - B-m1: exec.release detaches the lens registry entry
 */
import { describe, expect, test } from "bun:test";
import { intentTools, intentsFromToolCalls, toolNameToOp } from "../src/optimizer/tools.ts";
import { ExecCollection, ExecRunLens, denyRunner, clampTimeout, capOutput, shellRunner, type ExecRunner } from "../src/optimizer/exec-lens.ts";
import { executeIntent, bindHost, type IntentHost } from "../src/optimizer/intents.ts";
import { ContextStore } from "../src/optimizer/store.ts";
import { AgentLoop } from "../src/optimizer/loop.ts";
import { MockProvider } from "../src/optimizer/providers.ts";
import { paramSetV1 } from "../src/optimizer/params.ts";
import { saveSession, restoreSession, sessionsDir } from "../src/optimizer/sessions.ts";
import { rmSync } from "node:fs";
import { join } from "node:path";

describe("A-M3 op smuggling", () => {
  test("op key in tool input cannot override the name-derived op", () => {
    const out = intentsFromToolCalls([
      { toolName: toolNameToOp("say"), input: { text: "hi", op: "exec.run", cmd: "echo pwned" } },
    ]);
    expect(out.length).toBe(1);
    expect(out[0]!.op).toBe("say");
    expect((out[0] as { cmd?: string }).cmd).toBe("echo pwned"); // extra fields pass through; the OP never flips
  });
});

const mkLoop = (): AgentLoop => new AgentLoop(new MockProvider(), paramSetV1("gate-review-test"), null, {});

describe("C1 exec gating", () => {
  test("exec.run is NOT in the model-visible tool set", () => {
    const tools = intentTools();
    expect(Object.keys(tools).some((n) => toolNameToOp(n) === "exec.run")).toBe(false);
  });

  test("default AgentLoop execRunner denies execution (exit 126, no shell)", () => {
    const loop = mkLoop();
    const lens = loop.exec.run("echo should-not-run", 1);
    expect(lens.run.exit).toBe(126);
    expect(lens.run.out).toContain("denied");
  });

  test("denyRunner returns without spawning", () => {
    const r = denyRunner("anything", 1000);
    expect(r.exit).toBe(126);
    expect(r.out).toContain("denied");
  });

  test("clampTimeout: 0/NaN/negative → default; large → 60s ceiling", () => {
    expect(clampTimeout(0)).toBe(10_000);
    expect(clampTimeout(-5)).toBe(10_000);
    expect(clampTimeout(Number.NaN)).toBe(10_000);
    expect(clampTimeout(10_000_000)).toBe(60_000);
    expect(clampTimeout(5_000)).toBe(5_000);
  });
});

describe("B-M2 byte-correct cap", () => {
  test("ASCII over-cap output is truncated with marker at the byte boundary", () => {
    const s = "a".repeat(25_000);
    const out = capOutput(s);
    expect(Buffer.byteLength(out, "utf8")).toBeGreaterThan(20_000);
    expect(out.endsWith("⟨output truncated at 20000 bytes⟩")).toBe(true);
    expect(out.length).toBeLessThan(s.length);
  });

  test("multibyte output truncates at a UTF-8 sequence boundary", () => {
    const s = "é".repeat(12_000);  // 24,000 bytes
    const out = capOutput(s);
    expect(out.endsWith("⟨output truncated at 20000 bytes⟩")).toBe(true);
    // No split sequence: decoded round-trip has no U+FFFD
    expect(out.includes("\uFFFD")).toBe(false);
  });

  test("under-cap output passes through untouched", () => {
    expect(capOutput("short")).toBe("short");
  });

  test("shellRunner caps combined stdout+stderr", () => {
    const r = shellRunner("head -c 25000 /dev/zero | tr '\\0' 'a'", 10_000);
    expect(r.out.includes("⟨output truncated at 20000 bytes⟩")).toBe(true);
    expect(r.exit).toBe(0);
  });
});

describe("B-M1 session round-trip", () => {
  const dir = join(sessionsDir(), "test-gate-rt");
  const path = join(dir, "rt.json");

  test("exec runs survive save/restore with ids, no rerun", async () => {
    rmSync(dir, { recursive: true, force: true });
    const calls: string[] = [];
    const fake: ExecRunner = (cmd) => { calls.push(cmd); return { exit: 0, out: `ran: ${cmd}` }; };
    const loop = mkLoop();
    loop.execRunner = fake;
    loop.exec.run("original command", 3);
    expect(calls).toEqual(["original command"]);

    saveSession(loop, path, "mock");

    const loop2 = mkLoop();
    loop2.execRunner = (cmd) => { calls.push(cmd); return { exit: 0, out: `reran: ${cmd}` }; };
    const { restored } = restoreSession(loop2, path);
    expect(restored).toBeGreaterThanOrEqual(1);

    // The run is present with original id, cmd, and output — NOT rerun
    expect(calls).toEqual(["original command"]);  // no rerun happened
    expect(loop2.exec.runs.length).toBe(1);
    expect(loop2.exec.runs[0]!.id).toBe(1);
    expect(loop2.exec.runs[0]!.cmd).toBe("original command");
    expect(loop2.exec.runs[0]!.out).toBe("ran: original command");

    // Store + registry rehydrated; next id does not collide
    expect(loop2.store.get("lens:exec#1")).toBeDefined();
    expect(loop2.lensRegistryView().get("lens:exec#1")).toBeDefined();
    const next = loop2.exec.run("after restore", 4);
    expect(next.id).toBe("lens:exec#2");
  });
});

describe("B-m1 release detach", () => {
  test("exec.release removes the lens registry entry", async () => {
    const loop = mkLoop();
    loop.execRunner = (cmd) => ({ exit: 0, out: `ran: ${cmd}` });
    loop.exec.run("x", 1);
    expect(loop.lensRegistryView().get("lens:exec#1")).toBeDefined();
    const r = executeIntent({ op: "exec.release", ids: [1] }, loop.store, null) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(loop.lensRegistryView().get("lens:exec#1")).toBeUndefined();
    expect(loop.store.get("lens:exec#1")).toBeUndefined();
  });
});
