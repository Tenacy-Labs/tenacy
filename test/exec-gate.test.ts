/**
 * Exec gating wrapper tests (follow-up to the PR #31 gate, owner ruling
 * 2026-08-26: the wrapper ships BEFORE exec reaches non-coordinator cells).
 *
 * Pins:
 *  - gateRunner budgets uses and degrades to deny permanently
 *  - AgentLoop.grantExec installs a gate, preserves run history + ids
 *  - model-proposed exec.run executes ONLY inside an open grant (E2E through
 *    the real model-intent path via ScriptedProvider)
 *  - a closed/revoked grant denies model-proposed exec
 *  - grants cannot be minted from the intent channel
 */
import { describe, expect, test } from "bun:test";
import { gateRunner, denyRunner, shellRunner, type ExecRunner } from "../src/optimizer/exec-lens.ts";
import { intentTools, toolNameToOp } from "../src/optimizer/tools.ts";
import { AgentLoop } from "../src/optimizer/loop.ts";
import { MockProvider, ScriptedProvider } from "../src/optimizer/providers.ts";
import { paramSetV1 } from "../src/optimizer/params.ts";

const mkLoop = (provider = new MockProvider()): AgentLoop =>
  new AgentLoop(provider, paramSetV1("exec-gate-test"), null, {});

describe("gateRunner", () => {
  test("budgets uses then degrades to deny permanently", () => {
    const ran: string[] = [];
    const real: ExecRunner = (cmd) => { ran.push(cmd); return { exit: 0, out: `ran ${cmd}` }; };
    const g = gateRunner(real, 2);
    expect(g.grant.uses).toBe(2);
    expect(g.runner("a", 1000).exit).toBe(0);
    expect(g.runner("b", 1000).exit).toBe(0);
    const denied = g.runner("c", 1000);
    expect(denied.exit).toBe(126);
    expect(denied.out).toContain("denied");
    expect(ran).toEqual(["a", "b"]);           // c never reached the real runner
    expect(g.runner("d", 1000).exit).toBe(126); // stays closed forever
    expect(g.remaining()).toBe(0);
  });

  test("uses 0 = closed grant (deny forever)", () => {
    const g = gateRunner(shellRunner, 0);
    expect(g.runner("echo x", 1000).exit).toBe(126);
    expect(g.remaining()).toBe(0);
  });

  test("fractional/negative/non-finite uses clamp honestly (fail closed)", () => {
    expect(gateRunner(shellRunner, 2.9).grant.uses).toBe(2);
    expect(gateRunner(shellRunner, -5).grant.uses).toBe(0);
    // PR34 gate review MAJOR: NaN/Infinity must DENY, never authorize forever
    expect(gateRunner(shellRunner, Number.NaN).grant.uses).toBe(0);
    expect(gateRunner(shellRunner, Number.POSITIVE_INFINITY).grant.uses).toBe(0);
    expect(gateRunner(shellRunner, Number.NaN).runner("x", 1000).exit).toBe(126);
    expect(gateRunner(shellRunner, Number.POSITIVE_INFINITY).runner("x", 1000).exit).toBe(126);
  });
});

describe("AgentLoop.grantExec", () => {
  test("installs a gate; run history + id continuity survive the swap", () => {
    const loop = mkLoop();
    // pre-grant run under deny
    const r1 = loop.exec.run("denied-cmd", 1);
    expect(r1.run.exit).toBe(126);

    const g = gateRunner(shellRunner, 5);
    loop.grantExec(g);
    // history carried over
    expect(loop.exec.runs.length).toBe(1);
    expect(loop.exec.runs[0]!.cmd).toBe("denied-cmd");
    expect(loop.lensRegistryView().get("lens:exec#1")).toBeDefined();
    // next id continues, does not collide
    const r2 = loop.exec.run("echo granted", 2);
    expect(r2.id).toBe("lens:exec#2");
    expect(r2.run.exit).toBe(0);
    expect(r2.run.out).toContain("granted");
  });

  test("revocation: /exec 0 semantics deny again", () => {
    const loop = mkLoop();
    loop.grantExec(gateRunner(shellRunner, 3));
    expect(loop.exec.run("echo one", 1).run.exit).toBe(0);
    loop.grantExec(gateRunner(denyRunner, 0));  // revoke
    const r = loop.exec.run("echo nope", 2);
    expect(r.run.exit).toBe(126);
    expect(r.run.out).toContain("denied");
    // history still intact across the revoke swap
    expect(loop.exec.runs.length).toBe(2);
  });
});

describe("model channel E2E (the attack path)", () => {
  test("model-proposed exec.run DENIED with no grant, EXECUTES inside one, DENIED again after spend", async () => {
    const marker = `/tmp/ak-exec-gate-${process.pid}.txt`;
    const cmd = `touch ${marker}`;
    const hostile = [{ op: "exec.run" as const, cmd }];
    const provider = new ScriptedProvider([
      { intents: hostile },  // turn 1: no grant → denied
      { intents: hostile },  // turn 2: grant open → executes
      { intents: hostile },  // turn 3: grant spent → denied
    ]);
    const loop = new AgentLoop(provider, paramSetV1("exec-gate-e2e"), null, {});
    // wipe any marker from previous runs
    await Bun.write(marker, "");
    const { rmSync } = await import("node:fs");
    rmSync(marker);

    // t1: no grant — the intent executes as a denied run, marker absent
    const o1 = await loop.run("try exec");
    const execRow1 = o1.toolResults.find((r) => r.op === "exec.run");
    expect(execRow1?.ok).toBe(true);            // the intent itself "ran" (as a denied exec)
    expect(loop.exec.runs[0]!.exit).toBe(126);  // but the runner denied

    // t2: operator grants ONE use — same model intent now executes for real
    loop.grantExec(gateRunner((c) => shellRunner(c, 5000), 1));
    await loop.run("try exec again");
    expect(loop.exec.runs[1]!.exit).toBe(0);

    // t3: budget spent — denied again
    await loop.run("try exec once more");
    expect(loop.exec.runs[2]!.exit).toBe(126);
    const exists = await Bun.file(marker).exists();
    expect(exists).toBe(true);  // exactly the one authorized execution landed
    rmSync(marker);
  });

  test("no intent shape can mint a grant", () => {
    const loop = mkLoop();
    // Real pins, not a typeof no-op (PR34 gate review test-honesty note):
    // exec.run absent from the model-visible ToolSet; an un-granted loop
    // denies even operator-side direct .run().
    const tools = intentTools();
    expect(Object.keys(tools).some((n) => toolNameToOp(n) === "exec.run")).toBe(false);
    expect(typeof loop.grantExec).toBe("function");
    expect(loop.exec.run("x", 1).run.exit).toBe(126);
  });
});
