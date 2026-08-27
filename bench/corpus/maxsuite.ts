/**
 * BENCH MAX SUITE (Daniel, 2026-08-22): "create a bench max suite using all
 * the different agentic scenarios we have so far to capture data and run our
 * post-analysis on the logged data, and check the reported results against a
 * manual analysis to check for accuracy and conclusions."
 *
 * Every corpus scenario, run TWICE under identical world events:
 *   kernel      — AgentLoop + solver-managed render (Λ = 2,048)
 *   accumulator — plain append-only transcript, truncation on overflow
 *                 (keep first exchange + last 6 messages)
 *
 * Unified per-turn log -> bench/corpus/dumps/maxsuite.json
 * Post-analysis       -> bun bench/corpus/postanalysis.ts (separate)
 *
 * Honesty rules (standing):
 *   kernel hit    = TurnOutcome.cacheExpectedHit (CacheModel believed hit)
 *   accum hit     = estTokens(longest common prefix w/ previous prompt)
 *   kernel hit is ALSO re-derived from render-text LCP as an independent
 *   cross-check of the CacheModel numbers (reported-vs-recomputed).
 *   facts are checked against the FINAL PROMPT of each harness (what the
 *   model actually sees), not against the transcript of past replies.
 */
import { AgentLoop, makeTurnItem } from "../../src/optimizer/loop.ts";
import { MockProvider } from "../../src/optimizer/providers.ts";
import { TurnBoundaryWatcher } from "../../src/optimizer/live-views.ts";
import { executeIntent, type SteeringIntent } from "../../src/optimizer/intents.ts";
import { paramSetV1 } from "../../src/optimizer/params.ts";
import { StandingItem } from "../../src/optimizer/items.ts";
import { TOOL_PROTOCOL_DOC } from "../../src/optimizer/tools.ts";
import { estTokens } from "../../src/optimizer/renderer.ts";
import type { RenderResult } from "../../src/optimizer/types.ts";
import { readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const SPEC = JSON.parse(readFileSync(resolve(import.meta.dir, "scenarios.json"), "utf8")) as Record<string, Scenario>;
/**
 * Review B16: BOTH harnesses' cost bases pinned to one explicit constant —
 * kernel-side pricing previously read paramSetV1("mock").cache while the
 * accumulator used its own; identical today only by accident. A per-model
 * price table (A2) diverges them silently unless this pin moves first.
 */
export const PRICE_PER_1K_UNCACHED = 3;      // $/1k uncached input (mock v1)
export const PRICE_PER_1K_CACHED = 0.3;      // $/1k cached (10% of uncached)
const costOf = (hit: number, tot: number): number =>
  (hit / 1000) * PRICE_PER_1K_CACHED + ((tot - hit) / 1000) * PRICE_PER_1K_UNCACHED;
interface Scenario {
  desc: string;
  turns: unknown;
  script?: string[];
  steps?: Array<{ msg?: string; intent?: unknown; mutate?: string }>;
  recall: string[];
  /** windows this scenario should run at (default: both 2k and 50k) */
  windows?: number[];
}
const WINDOW = 2048;

const SUITE: string[] = [
  "s1-orient", "s2-two-file", "s3-chunked-read", "s3b-live-watch",
  "s4-review-session", "s5-full-stack", "s6-delayed-rereference",
  "s7-transform-amortization",
];

interface TurnRec {
  turn: number;
  label: string;                 // what drove the turn (msg / intent / say)
  totalTokens: number;           // prompt size the model sees
  expectedHit: number;           // harness's believed cached-prefix tokens
  lcpHit: number;                // independent LCP recomputation (estTokens)
  hitRatio: number;              // expectedHit / totalTokens
  factsNow: Record<string, boolean>;   // fact -> present in THIS prompt
  // kernel-only detail (null for accumulator):
  zoneOrder: string | null;
  optionChoices: Record<string, string> | null;
  itemTokens: Record<string, number> | null;
}
interface RunRec {
  scenario: string;
  harness: "kernel" | "accumulator";
  desc: string;
  recall: string[];
  turns: TurnRec[];
  finalPromptTokens: number;
  facts: Record<string, boolean>;      // fact -> present in FINAL prompt
  /** ADR-0006 eval surfaces: cache efficiency + realized render cost. */
  finalHitRatio: number;               // final-turn believed-hit / total
  meanHitRatio: number;                // mean over turns
  costUsd: number;                     // Σ hit×priceCached + miss×priceUncached (per 1k), solver price units
  peak: number;
  mean: number;
  overBudgetTurns: number;             // prompts exceeding WINDOW
}

// ── shared helpers ───────────────────────────────────────────────────────
function lcpTokens(a: string, b: string): number {
  let j = 0;
  while (j < a.length && j < b.length && a[j] === b[j]) j += 1;
  return estTokens(a.slice(0, j));
}
function fileLineSlice(target: string, from: number, to: number): string {
  try {
    const lines = readFileSync(resolve(ROOT, target), "utf8").split("\n");
    return lines.slice(from - 1, to).join("\n");
  } catch { return ""; }
}

// ── KERNEL harness ───────────────────────────────────────────────────────
async function runKernel(name: string, spec: Scenario, kind: "normal" | "stressA" | "stressB", window: number = WINDOW): Promise<RunRec> {
  const engine = new TurnBoundaryWatcher();
  const ps = paramSetV1("m");
  ps.budgetLambda = window;
  const rrs: RenderResult[] = [];
  const hits: number[] = [];
  const labels: string[] = [];
  const loop = new AgentLoop(new MockProvider(), ps, null, {
    onRender: (rr: RenderResult): void => { rrs.push(rr); },
    onTurn: (o: { cacheExpectedHit?: number }): void => { hits.push(o.cacheExpectedHit ?? 0); },
  });
  loop.watcher = engine;
  loop.fileContent = (t) => { try { return readFileSync(resolve(ROOT, t), "utf8"); } catch { return ""; } };
  loop.dirListing = (t) => { try { return readdirSync(resolve(ROOT, t)).join("\n"); } catch { return ""; } };
  loop.store.add(new StandingItem("identity", "identity",
    "You are running the agent-kernel pressure corpus. " + TOOL_PROTOCOL_DOC +
    " Work under a tight token budget: expand only the ranges you need, distill what matters into your replies, release ranges when done.").toContextItem());

  const recall = spec.recall;
  const turns: TurnRec[] = [];
  let prevRender = "";
  const record = (label: string): void => {
    const rr = rrs.at(-1);
    if (rr === undefined) return;
    const text = rr.text;
    const total = rr.blocks.reduce((s, b) => s + b.tokens, 0);
    const hit = hits.at(-1) ?? 0;
    const lcp = lcpTokens(prevRender, text);
    const optionChoices: Record<string, string> = {};
    const itemTokens: Record<string, number> = {};
    for (const p of rr.placements) { optionChoices[p.id] = p.optionId; itemTokens[p.id] = p.tokens; }
    turns.push({
      turn: turns.length + 1, label: label.slice(0, 90),
      totalTokens: total, expectedHit: hit, lcpHit: lcp,
      hitRatio: total > 0 ? Math.round((hit / total) * 100) / 100 : 0,
      factsNow: Object.fromEntries(recall.map((f) => [f, text.includes(f)])),
      zoneOrder: [...new Set(rr.blocks.map((b) => b.zone))].join("|") || null,
      optionChoices, itemTokens,
    });
    prevRender = text;
  };

  const logPath = resolve(ROOT, "bench/corpus/fixtures/api.log");
  const pristineLog = readFileSync(logPath, "utf8");
  const apiLensId = "lens:bench/corpus/fixtures/api.log";

  try {
    if (kind === "stressA") {
      executeIntent({ op: "files.expand", target: "bench/corpus/fixtures/api.log", from: 1, to: 40 } as SteeringIntent, loop.store, null);
      await loop.run("expand");
      record("stressA expand 1-40");
      for (let t = 1; t <= 12; t++) {
        const lines = pristineLog.split("\n");
        const idx = Math.min(lines.length - 1, 5 + t);
        lines[idx] = `2026-08-15T04:${String(10 + t).padStart(2, "0")}:00Z fleet coolant ALERT pump-B excursion (in-range mutation t${t})`;
        writeFileSync(logPath, lines.join("\n"));
        engine.push({ lensId: apiLensId, path: "bench/corpus/fixtures/api.log", kind: "change" });
        loop.refreshLensFromSubstrate(apiLensId);
        await loop.run("thrash " + t);
        record(`stressA mutation t${t} (in-range)`);
      }
    } else if (kind === "stressB") {
      for (let t = 1; t <= 14; t++) { await loop.run(`question ${t}`); record(`question ${t}`); }
    } else if (spec.script !== undefined) {
      let sayN = 0;
      for (const line of spec.script ?? []) {
        if (line.startsWith("say ")) {
          sayN += 1;
          loop.store.add(makeTurnItem(`distill-${sayN}`, "model", line.slice(4), sayN));
          continue;
        }
        const intent = JSON.parse(line) as SteeringIntent;
        executeIntent(intent, loop.store, null);
        await loop.run(line);
        record(`intent ${intent.op}`);
      }
      await loop.run("report your findings");
      record("final report");
    } else if (spec.steps !== undefined) {
      let sayN = 0;
      for (const st of spec.steps) {
        if ((st as { mutate?: string }).mutate === "append-alert") {
          appendFileSync(logPath, `2026-08-15T04:19:00Z fleet coolant ALERT pump-B temperature excursion depot-north (append)\n`);
          engine.push({ lensId: apiLensId, path: "bench/corpus/fixtures/api.log", kind: "change" });
          loop.refreshLensFromSubstrate(apiLensId);
          continue;
        }
        if (st.intent !== undefined) { executeIntent(st.intent as SteeringIntent, loop.store, null); continue; }
        if (st.msg !== undefined && st.msg.startsWith("say ")) {
          sayN += 1;
          loop.store.add(makeTurnItem("distill-" + sayN, "model", st.msg.slice(4), sayN));
          await loop.run(st.msg);
          record("distill " + st.msg.slice(4, 60));
          continue;
        }
        if (st.msg === undefined) continue;
        await loop.run(st.msg);
        record(st.msg);
      }
    } else {
      const tList = spec.turns as Array<{ msg?: string; mutation?: string }>;
      for (const t of tList) {
        if (t.mutation === "append-alert") {
          appendFileSync(logPath, `2026-08-15T04:19:00Z fleet coolant ALERT pump-B temperature excursion depot-north (append)\n`);
          engine.push({ lensId: apiLensId, path: "bench/corpus/fixtures/api.log", kind: "change" });
          loop.refreshLensFromSubstrate(apiLensId);
          continue;
        }
        if (t.msg === undefined) continue;
        await loop.run(t.msg);
        record(t.msg);
      }
    }
  } finally {
    writeFileSync(logPath, pristineLog);
  }

  const finalText = rrs.at(-1)?.text ?? "";
  const totals = turns.map((t) => t.totalTokens);
  const ratios = turns.map((t) => t.hitRatio);
  const cost = turns.reduce((s, t) => s + costOf(t.expectedHit, t.totalTokens), 0);
  return {
    scenario: name, harness: "kernel", desc: spec.desc, recall,
    turns,
    finalPromptTokens: totals.at(-1) ?? 0,
    facts: Object.fromEntries(recall.map((f) => [f, finalText.includes(f)])),
    peak: totals.length > 0 ? Math.max(...totals) : 0,
    mean: totals.length > 0 ? Math.round(totals.reduce((s, x) => s + x, 0) / totals.length) : 0,
    overBudgetTurns: totals.filter((x) => x > window).length,
    finalHitRatio: ratios.at(-1) ?? 0,
    meanHitRatio: ratios.length > 0 ? Math.round((ratios.reduce((s, x) => s + x, 0) / ratios.length) * 100) / 100 : 0,
    costUsd: Math.round(cost * 1000) / 1000,
  };
}

export { runKernel, runAccumulator, type Scenario, type RunRec, type TurnRec, lcpTokens, fileLineSlice, WINDOW, SUITE, SPEC, ROOT };

// ── ACCUMULATOR twin (identical world events) ────────────────────────────
function runAccumulator(name: string, spec: Scenario, kind: "normal" | "stressA" | "stressB", window: number = WINDOW): RunRec {
  // Price basis: the same mock param prices as the kernel harness, so
  // costUsd is comparable across harnesses (kernel belief vs accumulator LCP).
  const ps = paramSetV1("mock");
  const SYSTEM = "You are a helpful assistant.";
  type Msg = { role: "user" | "assistant"; content: string };
  const transcript: Msg[] = [];
  const prompts: string[] = [];
  const labels: string[] = [];
  const recall = spec.recall;

  const assemble = (): string =>
    SYSTEM + "\n" + transcript.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}\n`).join("");

  const push = (label: string, msg?: Msg): void => {
    if (msg !== undefined) transcript.push(msg);
    let prompt = assemble();
    if (estTokens(prompt) > window) {
      // traditional truncation: anchor first exchange + last 6 messages
      transcript.splice(1, transcript.length - 7);
      prompt = assemble();
    }
    prompts.push(prompt);
    labels.push(label.slice(0, 90));
  };

  const logPath = resolve(ROOT, "bench/corpus/fixtures/api.log");
  const pristineLog = readFileSync(logPath, "utf8");

  if (kind === "stressA") {
    transcript.push({ role: "user", content: "Read api.log lines 1-40:\n" + fileLineSlice("bench/corpus/fixtures/api.log", 1, 40) });
    push("stressA expand 1-40");
    for (let t = 1; t <= 12; t++) {
      const lines = pristineLog.split("\n");
      const idx = Math.min(lines.length - 1, 5 + t);
      lines[idx] = `2026-08-15T04:${String(10 + t).padStart(2, "0")}:00Z fleet coolant ALERT pump-B excursion (in-range mutation t${t})`;
      writeFileSync(logPath, lines.join("\n"));
      transcript.push({ role: "user", content: `api.log changed (mutation t${t}). Re-read lines 1-40:\n` + fileLineSlice("bench/corpus/fixtures/api.log", 1, 40) });
      push(`stressA mutation t${t} (re-read)`);
    }
  } else if (kind === "stressB") {
    for (let t = 1; t <= 14; t++) {
      transcript.push({ role: "user", content: `question ${t}` });
      transcript.push({ role: "assistant", content: `answer ${t}: noted.` });
      push(`question ${t}`);
    }
  } else if (spec.script !== undefined) {
    let sayN = 0;
    for (const line of spec.script ?? []) {
      if (line.startsWith("say ")) {
        sayN += 1;
        transcript.push({ role: "assistant", content: line.slice(4) });
        push(`say ${sayN}`);
        continue;
      }
      const intent = JSON.parse(line) as SteeringIntent & { from?: number; to?: number; target?: string; id?: string; text?: string; status?: string; fromTurn?: number };
      if (intent.op === "files.expand" && intent.from !== undefined && intent.to !== undefined) {
        const target = intent.target ?? "bench/corpus/fixtures/api.log";
        transcript.push({ role: "user", content: `Read ${target} lines ${intent.from}-${intent.to}:\n${fileLineSlice(target, intent.from, intent.to)}` });
      } else if (intent.op === "goals.set") {
        transcript.push({ role: "user", content: `Goal set: ${intent.text ?? ""}` });
      } else if (intent.op === "goals.update") {
        transcript.push({ role: "user", content: `Goal ${intent.id} status: ${intent.status ?? "updated"}` });
      } else {
        transcript.push({ role: "user", content: `${intent.op} ${(intent as { target?: string }).target ?? ""}` });
      }
      // release/merge/promote: accumulator has no such op — content stays
      push(`intent ${intent.op}`);
    }
    transcript.push({ role: "user", content: "report your findings" });
    push("final report");
  } else if (spec.steps !== undefined) {
    for (const st of spec.steps) {
      if (st.intent !== undefined) {
        const intent = st.intent as SteeringIntent & { from?: number; to?: number; target?: string };
        if (intent.op === "files.expand" && intent.from !== undefined && intent.to !== undefined) {
          const target = intent.target ?? "bench/corpus/fixtures/api.log";
          transcript.push({ role: "user", content: `Read ${target} lines ${intent.from}-${intent.to}:\n${fileLineSlice(target, intent.from, intent.to)}` });
        } else {
          transcript.push({ role: "user", content: `${intent.op} ${(intent as { target?: string }).target ?? ""}` });
        }
        continue;   // rides the next msg (mirrors kernel hybrid semantics)
      }
      const msg = (st as { msg?: string }).msg;
      if (msg === undefined) continue;
      if (msg.startsWith("say ")) {
        transcript.push({ role: "assistant", content: msg.slice(4) });
        push("say " + msg.slice(4, 60));
        continue;
      }
      transcript.push({ role: "user", content: msg });
      transcript.push({ role: "assistant", content: "Noted." });
      push(msg);
    }
  } else {
    const tList = spec.turns as Array<{ msg?: string; mutation?: string }>;
    for (const t of tList) {
      if (t.mutation === "append-alert") {
        appendFileSync(logPath, `2026-08-15T04:19:00Z fleet coolant ALERT pump-B temperature excursion depot-north (append)\n`);
        transcript.push({ role: "user", content: `api.log changed. Re-read lines 1-40:\n${fileLineSlice("bench/corpus/fixtures/api.log", 1, 40)}` });
        push("mutation append-alert (re-read)");
        continue;
      }
      if (t.msg === undefined) continue;
      transcript.push({ role: "user", content: t.msg });
      transcript.push({ role: "assistant", content: "Noted." });
      push(t.msg);
    }
  }
  writeFileSync(logPath, pristineLog);

  const final = prompts.at(-1) ?? "";
  const turns: TurnRec[] = prompts.map((prompt, i) => {
    const prev = prompts[i - 1] ?? "";
    const hit = i === 0 ? 0 : lcpTokens(prev, prompt);
    const total = estTokens(prompt);
    return {
      turn: i + 1, label: labels[i] ?? "",
      totalTokens: total, expectedHit: hit, lcpHit: hit,
      hitRatio: total > 0 ? Math.round((hit / total) * 100) / 100 : 0,
      factsNow: Object.fromEntries(recall.map((f) => [f, prompt.includes(f)])),
      zoneOrder: null, optionChoices: null, itemTokens: null,
    };
  });
  const totals = turns.map((t) => t.totalTokens);
  const ratios = turns.map((t) => t.hitRatio);
  const cost = turns.reduce((s, t) =>
    s + costOf(t.expectedHit, t.totalTokens), 0);
  return {
    scenario: name, harness: "accumulator", desc: spec.desc, recall,
    turns,
    finalPromptTokens: totals.at(-1) ?? 0,
    facts: Object.fromEntries(recall.map((f) => [f, final.includes(f)])),
    peak: totals.length > 0 ? Math.max(...totals) : 0,
    mean: totals.length > 0 ? Math.round(totals.reduce((s, x) => s + x, 0) / totals.length) : 0,
    overBudgetTurns: totals.filter((x) => x > window).length,
    finalHitRatio: ratios.at(-1) ?? 0,
    meanHitRatio: ratios.length > 0 ? Math.round((ratios.reduce((s, x) => s + x, 0) / ratios.length) * 100) / 100 : 0,
    costUsd: Math.round(cost * 1000) / 1000,
  };
}

// ── main: run everything, dump the unified log ───────────────────────────
const ALL: Array<{ name: string; kind: "normal" | "stressA" | "stressB" }> = [
  ...SUITE.map((n) => ({ name: n, kind: "normal" as const })),
  { name: "STRESS-A-thrash", kind: "stressA" as const },
  { name: "STRESS-B-rollover", kind: "stressB" as const },
];

// Review B6: the suite body runs only when EXECUTED directly (import.meta.main).
// Importing maxsuite for lcpTokens (gauges-baseline) must not re-run 20
// corpus scenarios and clobber the dump.
if (import.meta.main) {
  const runs: RunRec[] = [];
  for (const { name, kind } of ALL) {
    const spec = SPEC[name] ?? SPEC["s3-chunked-read"]!;
    const k = await runKernel(name, spec, kind);
    const a = runAccumulator(name, spec, kind);
    runs.push(k, a);
    console.log(`${name}: kernel ${k.peak}t peak / ${Object.values(k.facts).filter(Boolean).length}/${k.recall.length} facts · accum ${a.peak}t peak / ${Object.values(a.facts).filter(Boolean).length}/${a.recall.length} facts`);
  }
  writeFileSync(resolve(ROOT, "bench/corpus/dumps/maxsuite.json"), JSON.stringify(runs, null, 1));
  console.log(`\nwrote bench/corpus/dumps/maxsuite.json (${runs.length} runs)`);
}
