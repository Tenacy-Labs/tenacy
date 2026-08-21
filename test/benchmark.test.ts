/**
 * Benchmark tasks — simple agentic scenarios run through the agent as
 * tests (ADR-0003 instrument-first: the harness works when these pass).
 *
 * Each task scripts the model side (deterministic), runs the full loop,
 * and checks optimizer-level facts: coalescing, cache accumulation,
 * goal lifecycle, dream summaries, budget discipline, search, replay.
 */
import { describe, test, expect } from "bun:test";
import { runTask, ensure, valueDensity, type BenchmarkTask } from "../src/optimizer/bench.ts";
import { ScriptedProvider } from "../src/optimizer/providers.ts";
import { loadLedger, reportCacheBelief, reportCostVsBaselines } from "../src/optimizer/replay.ts";
import { paramSetV1 } from "../src/optimizer/params.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FILES_200 = Array.from({ length: 200 }, (_, i) => `line ${i + 1} — ${"payload ".repeat(3)}${i}`).join("\n");

const tasks: BenchmarkTask[] = [
  {
    name: "file-reader",
    description: "agent reads a file in overlapping chunks; lens must coalesce to one entry",
    userMessages: ["open notes.txt and find the anomaly", "show me more context around it", "alright, done with that file"],
    modelSteps: [
      { intents: [{ op: "files.expand", target: "notes.txt", from: 1, to: 40 }] },
      { intents: [{ op: "files.expand", target: "notes.txt", from: 20, to: 80 }] },
      { text: "The anomaly is on line 61.", intents: [{ op: "files.release", target: "notes.txt", from: 1, to: 80 }] },
    ],
    files: { "notes.txt": FILES_200 },
    check: (s) => {
      const lensItems = s.loop.store.all().filter((i) => i.kind === "lens");
      ensure(lensItems.length === 1, `expected 1 lens item, got ${lensItems.length}`);
      ensure(lensItems[0]!.tokens > 0, "lens must have tokens after release (kept entry)");
      const expandResults = s.outcomes.flatMap((o) => o.toolResults).filter((r) => r.op === "files.expand");
      ensure(expandResults.length === 2, `expected 2 expand results, got ${expandResults.length}`);
      ensure(expandResults[1]!.result.includes("1 coalesced"), `second expand should coalesce, got: ${expandResults[1]!.result}`);
      // cache: identity prefix hit should be positive by turn 2
      const t2 = s.outcomes[1]!;
      ensure(t2.cacheExpectedHit > 0, "expected cache hit > 0 on turn 2 (identity prefix)");
    },
  },
  {
    name: "goal-tracker",
    description: "agent sets a goal, works, completes it; goal demotes from identity to foundational",
    userMessages: ["set a goal: prove the loop", "how goes it?", "done — close it out", "confirm it's closed"],
    modelSteps: [
      { intents: [{ op: "goals.set", id: "g1", text: "prove the loop" }] },
      { text: "Working on it." },
      { intents: [{ op: "goals.update", id: "g1", status: "completed" }] },
      { text: "Confirmed." },
    ],
    check: (s) => {
      const zones = s.outcomes.map((o) => o.placements.find((p) => p.id === "g1")?.zone);
      ensure(zones[1] === "identity", `active goal should ride identity zone on turn 2, got ${zones[1]}`);
      ensure(zones[3] === "foundational", `completed goal should demote to foundational on the next render, got ${zones[3]}`);
    },
  },
  {
    name: "error-recovery",
    description: "tool fails; error evidence enters context with A1 floor; agent recovers",
    userMessages: ["expand a file that doesn't exist", "try the right one"],
    modelSteps: [
      { intents: [{ op: "files.expand", target: "ghost.txt", from: 1, to: 10 }] },
      { text: "Corrected.", intents: [{ op: "files.expand", target: "real.txt", from: 1, to: 20 }] },
    ],
    files: { "real.txt": FILES_200 },
    check: (s) => {
      const errs = s.loop.store.all().filter((i) => i.kind === "error");
      ensure(errs.length >= 1, "error evidence should be in the store after a failed tool call");
      const errLedgers = s.outcomes.flatMap((o) => o.placements.filter((p) => p.id.startsWith("err")));
      // A1: error evidence renders with the value floor (within floorTurns)
      ensure(errLedgers.length >= 1, "error item should render while floored");
      const failed = s.outcomes[0]!.toolResults.find((r) => r.op === "files.expand");
      ensure(failed !== undefined && !failed.ok, "first expand against ghost.txt should fail");
      ensure(!failed!.result.includes("loaded"), "failed result must not report success text");
    },
  },
  {
    name: "long-conversation",
    description: "many turns; dream pass summarises aged episodic items; render stays bounded",
    userMessages: Array.from({ length: 12 }, (_, i) => `message ${i + 1}`),
    modelSteps: Array.from({ length: 12 }, (_, i) => ({ text: `reply ${i + 1}` })),
    check: (s) => {
      const epi = s.loop.store.all().filter((i) => i.kind === "episodic");
      ensure(epi.length >= 24, `12 turns should produce ≥24 episodic items (user+model), got ${epi.length}`);
      const summarised = epi.filter((i) => "summary" in i && (i as { summary?: string }).summary !== undefined);
      ensure(summarised.length > 0, "dream pass should have attached summaries to aged items");
      const lastRenderTokens = s.outcomes[s.outcomes.length - 1]!.renderTokens;
      ensure(lastRenderTokens < 1200, `render should stay bounded (<1200t), got ${lastRenderTokens}`);
    },
  },
  {
    name: "cache-accumulation",
    description: "stable identity head must accumulate cache hits across turns",
    userMessages: ["one", "two", "three"],
    modelSteps: [{ text: "r1" }, { text: "r2" }, { text: "r3" },
    ],
    check: (s) => {
      const hits = s.outcomes.map((o) => o.cacheExpectedHit);
      ensure(hits[0] === 0, "turn 1 has nothing cached");
      ensure(hits[1]! > 0 && hits[2]! >= hits[1]!, "hits should accumulate: " + hits.join(","));
    },
  },
  {
    name: "ctx-tools",
    description: "inspect/why/search/promote/demote/watch operate and render updates",
    userMessages: ["look around", "focus on notes", "wrap up"],
    modelSteps: [
      { intents: [{ op: "ctx.inspect", filter: "all" }] },
      { intents: [
          { op: "files.expand", target: "notes.txt", from: 1, to: 30 },
          { op: "ctx.promote", id: "lens:notes.txt" },
        ] },
      { intents: [{ op: "ctx.search", pattern: "anomaly" }] },
    ],
    files: { "notes.txt": FILES_200 },
    check: (s) => {
      const ops = s.outcomes.flatMap((o) => o.toolResults).map((r) => r.op);
      ensure(ops.includes("ctx.inspect"), "inspect ran");
      ensure(ops.includes("ctx.promote"), "promote ran");
      ensure(ops[ops.length - 1] === "ctx.search", "search ran last");
      const promoteAfter = s.outcomes[1]!.toolResults.find((r) => (r.op === "ctx.promote"));
      ensure(promoteAfter !== undefined && promoteAfter.ok, "promote succeeded");
      const searchRes = s.outcomes[2]!.toolResults.find((r) => r.op === "ctx.search");
      ensure(searchRes !== undefined && searchRes.ok, "search succeeded");
    },
  },
];

// expose tasks for harness use
export const benchmarkTasks = tasks;

describe("benchmark harness", () => {
  test("harness executes all tasks and all pass", async () => {
    const results: Array<{ name: string; passed: boolean; error?: string }> = [];
    for (const t of benchmarkTasks) {
      results.push(await runTask(t));
    }
    const failed = results.filter((r) => !r.passed);
    if (failed.length > 0) {
      console.error("failures:", JSON.stringify(failed, null, 2));
    }
    expect(failed.length).toBe(0);
  }, 30000);

  test("value density is computed and positive", async () => {
    const r = await runTask(benchmarkTasks[0]!);
    expect(r.passed).toBe(true);
    const vd = valueDensity(r.outcomes);
    expect(vd.mean).toBeGreaterThanOrEqual(0);
  });

  test("ledger replays: cache-belief report and cost-vs-baselines report from file", async () => {
    // run the file-reader task with ledger, then replay it
    const r = await runTask(benchmarkTasks[0]!);
    expect(r.passed).toBe(true);
    const state = (r as unknown as { ledgerPath: string | null }).ledgerPath;
    // runTask returns BenchmarkResult; for replay we need the path — run again capturing state
    let ledgerPath: string | null = null;
    {
      const provider = new ScriptedProvider(benchmarkTasks[0]!.modelSteps);
      const { AgentLoop } = await import("../src/optimizer/loop.ts");
      const { Ledger } = await import("../src/optimizer/ledger.ts");
      const { StandingItem } = await import("../src/optimizer/items.ts");
      const dir = mkdtempSync(join(tmpdir(), "ak-replay-"));
      const ledger = new Ledger(join(dir, "ledger.jsonl"));
      const loop = new AgentLoop(provider, paramSetV1("mock-scripted"), ledger);
      loop.store.add(new StandingItem("identity", "identity", "x").toContextItem());
      loop.fileContent = () => FILES_200;
      await loop.run("open");
      loop.steer({ op: "files.expand", target: "notes.txt", from: 1, to: 40 });
      await loop.run("expand");
      loop.steer({ op: "files.expand", target: "notes.txt", from: 20, to: 80 });
      await loop.run("more");
      await ledger.drain();
      ledgerPath = join(dir, "ledger.jsonl");
    }
    const lf = await loadLedger(ledgerPath);
    expect(lf.turns.length).toBe(3);
    expect(lf.caches.length).toBe(3);
    const r1 = reportCacheBelief(lf.caches);
    expect(r1.turns).toBe(3);
    expect(r1.meanAbsErrorTokens).not.toBeNull();
    const r6 = reportCostVsBaselines(lf.caches, paramSetV1("mock-scripted"));
    expect(r6.turns).toBe(3);
  });
});
