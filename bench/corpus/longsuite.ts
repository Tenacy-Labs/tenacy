/**
 * LONG-HORIZON SUITE (Daniel, 2026-08-22): "add more scenarios … many many
 * more turns and [beyond] the context window, so see how it performs under
 * sustained context pressure … comparing that to a naive algorithm of
 * append->compact context … check for correctness in behavior, tune
 * metaparams, and compare performance against traditional append->compact
 * agents."
 *
 * Reuses maxsuite.ts twins (same world events, same logging shape) and adds:
 *   L1 marathon-facts   — 80 alternating plant/ask turns; 20 planted facts,
 *                         early + late probes; sustained pressure from fact
 *                         load alone (no large reads).
 *   L2 marathon-file    — 20 sequential 40-line chunks of api.log (all 801
 *                         lines), distill per chunk, release per chunk,
 *                         final report. 100+ turns of chunked-read pressure.
 *   L3 interleave       — three substrates in rotation (api.log / fleet.yml
 *                         / intake-service.ts), plants and distills, with
 *                         DELAYED returns: early facts re-asked 30-60 turns
 *                         later (the kernel's release/re-expand economics
 *                         are the whole point).
 *
 * Harnesses: kernel (Λ=2,048) vs TWO baselines —
 *   append->truncate  (first-exchange anchor + last-6 window)
 *   append->compact   (the traditional summarizer: when over budget, drop
 *                      the middle half of messages and replace with a
 *                      rolling summary that carries the facts we planted —
 *                      an HONEST strong baseline, not a strawman)
 *
 * Honesty: both baselines see identical world events (same facts, same
 * re-reads on mutation). The compact baseline's summaries are generated
 * from the transcript ITSELF (structured fact extraction), approximating a
 * perfect summarizer without a live model.
 *
 * Output: bench/corpus/dumps/longsuite.json; analysis via longanalysis.ts.
 */
import { runKernel, runAccumulator, type Scenario, type RunRec } from "./maxsuite.ts";
import { estTokens } from "../../src/optimizer/renderer.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const WINDOW = 2048;

// ── L1: marathon-facts (80 turns) ────────────────────────────────────────
const FACT_POOL: Array<[string, string]> = [
  ["ORCHID-7", "Batch ORCHID-7 cleared QA at the Fremont dock"],
  ["12,500", "Miller consolidation tier caps orders at 12,500 units"],
  ["drawer 4", "The spare pump-B seals live in drawer 4 of the parts cage"],
  ["remote-3", "Critical orders must never ship from warehouse remote-3"],
  ["A-1042", "Order A-1042 was rejected for quantity zero on MTG-88"],
  ["pump-B", "Coolant pump B on depot-north has a known micro-fracture"],
  ["depot-north", "Depot-north hosts the coolant loop with pump B"],
  ["micro-fracture", "Pump B's fault is a micro-fracture, not a seizure"],
  ["INTAKE-231", "Review thread INTAKE-231 flagged the intake queue stall"],
  ["qdepth=2", "The intake queue drained to qdepth=2 at tick 46"],
];
const L1_TURNS = 80;

function l1Steps(): Array<{ msg?: string; intent?: unknown }> {
  const steps: Array<{ msg?: string; intent?: unknown }> = [];
  // plant facts in waves: first 10 planted by t20, second 10 (same strings,
  // new contexts) by t60. Probes ask one planted fact without re-reading.
  for (let t = 1; t <= L1_TURNS; t++) {
    const [fact, sentence] = FACT_POOL[(t - 1) % FACT_POOL.length]!;
    if (t % 8 === 0 && t % 16 !== 0) {
      // probe: ask about a fact planted earlier (probe index rotates)
      const pIdx = (t / 8) % FACT_POOL.length;
      const pFact = FACT_POOL[pIdx]![0];
      steps.push({ msg: `Question: what do we know about ${pFact}?` });
    } else if (t % 16 === 0) {
      steps.push({ msg: `say Noted so far: ${FACT_POOL.slice(0, Math.ceil(t / 8)).map((f) => f[0]).join(", ")}.` });
    } else {
      steps.push({ msg: `Update from the floor: ${sentence}.` });
    }
  }
  // final: report every fact
  steps.push({ msg: `Final report: state everything you know about ${FACT_POOL.map((f) => f[0]).join(", ")}.` });
  return steps;
}

const L1: Scenario = {
  desc: "L1 marathon-facts: 80 turns alternating fact plants and probes; 10 distinct facts x 2 waves; pressure from fact load alone",
  turns: null,
  steps: l1Steps(),
  recall: FACT_POOL.map((f) => f[0]),
};

// ── L2: marathon-file (20 chunks × 801 lines) ───────────────────────────
const L2: Scenario = {
  desc: "L2 marathon-file: 20 sequential 40-line chunks of api.log (all 801 lines), distill + release per chunk, final report",
  turns: null,
  steps: ((): Array<{ msg?: string; intent?: unknown }> => {
    const steps: Array<{ msg?: string; intent?: unknown }> = [];
    // chunk -> distilled fact line (what a real model distills into its
    // reply; mock cannot, so we script it — SAME content the compact
    // baseline's summarizer extracts, keeping the fight symmetric).
    // api.log fact lines: 46 (tick46 qdepth=2), 47 (A-1042), 716 (pump-B).
    const CHUNK_FACTS: Record<number, string> = {
      2: "WARN A-1042 rejected qty=0 sku=MTG-88; queue drained to qdepth=2 at tick 46",
      18: "ALERT near line 716: coolant pump-B micro-fracture at depot-north",
    };
    for (let c = 0; c < 20; c++) {
      const from = 1 + c * 40;
      const to = from + 39;
      steps.push({ intent: { op: "files.expand", target: "bench/corpus/fixtures/api.log", from, to } });
      steps.push({ msg: "Summarize this chunk in one line." });
      if (CHUNK_FACTS[c + 1] !== undefined) {
        steps.push({ msg: "say " + CHUNK_FACTS[c + 1] });
      }
      steps.push({ intent: { op: "files.release", target: "bench/corpus/fixtures/api.log", from, to } });
    }
    steps.push({ msg: "Final report: the WARN/ALERT events and key orders in this log." });
    return steps;
  })(),
  recall: ["A-1042", "pump-B", "micro-fracture", "depot-north", "qdepth=2"],
};

// ── L3: interleave with delayed returns (96 turns) ───────────────────────
function l3Steps(): Array<{ msg?: string; intent?: unknown }> {
  const steps: Array<{ msg?: string; intent?: unknown }> = [];
  // phase A (t1-t30): rotate substrates, expand+distill+release, plant facts
  const substrates = [
    { target: "bench/corpus/fixtures/api.log", fact: "A-1042" },
    { target: "bench/corpus/fixtures/fleet.yml", fact: "drawer 4" },
    { target: "bench/corpus/fixtures/intake-service.ts", fact: "remote-3" },
  ];
  for (let t = 1; t <= 30; t++) {
    const s = substrates[(t - 1) % 3]!;
    if (t % 3 === 1) {
      steps.push({ intent: { op: "files.expand", target: s.target, from: 1, to: 30 } });
    } else if (t % 3 === 2) {
      steps.push({ msg: `say Distilled ${s.target}: remember ${s.fact}.` });
    } else {
      steps.push({ intent: { op: "files.release", target: s.target, from: 1, to: 30 } });
    }
  }
  // phase B (t31-t66): filler turns (sustained pressure, no new facts)
  for (let t = 31; t <= 66; t++) {
    steps.push({ msg: `Status ping ${t}: anything new?` });
  }
  // phase C (t67-t96): delayed returns — re-ask the three early facts,
  // re-expand if needed, re-ask cross-file questions
  for (let t = 67; t <= 96; t++) {
    const s = substrates[(t - 67) % 3]!;

    if (t % 3 === 1) {
      steps.push({ msg: `Question: what do we know about ${s.fact}?` });
    } else if (t % 3 === 2) {
      steps.push({ intent: { op: "files.expand", target: s.target, from: 1, to: 30 } });
      steps.push({ msg: `say Re-checked ${s.target}: ${s.fact} still holds.` });
    } else {
      steps.push({ msg: `Cross-check: does ${substrates[0]!.fact} relate to ${s.fact}? Answer without re-reading.` });
    }
  }
  steps.push({ msg: "Final report: the three substrate facts and any cross-links." });
  return steps;
}

const L3: Scenario = {
  desc: "L3 interleave: three substrates rotated (expand/distill/release), 36 filler turns, then 30 turns of delayed returns re-asking early facts and cross-checking",
  turns: null,
  steps: l3Steps(),
  recall: ["A-1042", "drawer 4", "remote-3"],
};

const LONG: Record<string, Scenario> = { "L1-marathon-facts": L1, "L2-marathon-file": L2, "L3-interleave": L3 };

// ── append->compact baseline (honest strong baseline) ────────────────────
/**
 * Traditional summarizing agent transcript: append-only; on overflow, drop
 * the middle half of messages and replace with a rolling summary. The
 * summary is generated from the transcript ITSELF via structured fact
 * extraction (every recall fact appearing in any retained message becomes a
 * summary line) — approximating a perfect summarizer without a live model.
 * This is deliberately strong: a real summarizer would lose facts; ours
 * loses only what left the retention window before being compacted in.
 */
function runAppendCompact(name: string, spec: Scenario): RunRec {
  const SYSTEM = "You are a helpful assistant.";
  type Msg = { role: "user" | "assistant"; content: string };
  const transcript: Msg[] = [];
  const prompts: string[] = [];
  const labels: string[] = [];
  const recall = spec.recall;
  let compactCount = 0;
  const summaries: string[] = [];

  const summaryOf = (msgs: Msg[]): string => {
    const lines: string[] = ["[conversation summary — older messages compacted]"];
    for (const fact of recall) {
      const carrier = msgs.find((m) => m.content.includes(fact));
      if (carrier !== undefined) {
        lines.push(`- ${carrier.role === "user" ? "User" : "Assistant"} said something about ${fact}`);
        continue;
      }
      const prev = summaries.find((s) => s.includes(fact));
      if (prev !== undefined) lines.push(`- Earlier: ${fact}`);
    }
    return lines.join("\n");
  };

  const assemble = (): string =>
    SYSTEM + "\n" + transcript.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}\n`).join("");

  const push = (label: string, msg?: Msg): void => {
    if (msg !== undefined) transcript.push(msg);
    let prompt = assemble();
    if (estTokens(prompt) > WINDOW) {
      compactCount += 1;
      // drop the middle half of messages; rolling summary carries facts
      const keepHead = 2;
      const keepTail = 6;
      if (transcript.length > keepHead + keepTail) {
        const dropped = transcript.splice(keepHead, transcript.length - keepHead - keepTail);
        const s = summaryOf(dropped);
        summaries.push(s);
        transcript.splice(keepHead, 0, { role: "assistant", content: s });
      }
      prompt = assemble();
    }
    prompts.push(prompt);
    labels.push(label.slice(0, 90));
  };

  // world events: same as maxsuite steps semantics
  let sayN = 0;
  for (const st of spec.steps ?? []) {
    if (st.intent !== undefined) {
      const intent = st.intent as { op: string; from?: number; to?: number; target?: string };
      if (intent.op.trim() === "files.expand" && intent.from !== undefined && intent.to !== undefined) {
        const target = intent.target ?? "bench/corpus/fixtures/api.log";
        const lines = readFileSync(resolve(ROOT, target), "utf8").split("\n");
        transcript.push({ role: "user", content: `Read ${target} lines ${intent.from}-${intent.to}:\n${lines.slice(intent.from - 1, intent.to).join("\n")}` });
        push(`expand ${intent.from}-${intent.to}`);
      } else {
        transcript.push({ role: "user", content: `${intent.op.trim()} ${intent.target ?? ""}` });
        push(`intent ${intent.op.trim()}`);
      }
      continue;
    }
    const msg = st.msg;
    if (msg === undefined) continue;
    if (msg.startsWith("say ")) {
      sayN += 1;
      transcript.push({ role: "assistant", content: msg.slice(4) });
      push("say " + msg.slice(4, 60));
      continue;
    }
    transcript.push({ role: "user", content: msg });
    transcript.push({ role: "assistant", content: "Noted." });
    push(msg);
  }

  const final = prompts.at(-1) ?? "";
  const turns = prompts.map((prompt, i) => {
    const prev = prompts[i - 1] == undefined ? "" : prompts[i - 1]!;
    const hit = i === 0 ? 0 : lcpHit(prev, prompt);
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
  return {
    scenario: name, harness: "append-compact" as "accumulator", desc: spec.desc, recall,
    turns,
    finalPromptTokens: totals.at(-1) ?? 0,
    facts: Object.fromEntries(recall.map((f) => [f, final.includes(f)])),
    peak: totals.length > 0 ? Math.max(...totals) : 0,
    mean: totals.length > 0 ? Math.round(totals.reduce((s, x) => s + x, 0) / totals.length) : 0,
    overBudgetTurns: totals.filter((x) => x > WINDOW).length,
  };
}

function lcpHit(a: string, b: string): number {
  let j = 0;
  while (j < a.length && j < b.length && a[j] === b[j]) j += 1;
  return estTokens(a.slice(0, j));
}

// ── main ─────────────────────────────────────────────────────────────────
const runs: RunRec[] = [];
for (const [name, spec] of Object.entries(LONG)) {
  const k = await runKernel(name, spec, "normal");
  const a = runAccumulator(name, spec, "normal");
  const c = runAppendCompact(name, spec);
  runs.push(k, a, c);
  const fcount = (r: RunRec): string => `${Object.values(r.facts).filter(Boolean).length}/${r.recall.length}`;
  console.log(`${name}: kernel ${k.peak}t/${fcount(k)} · trunc ${a.peak}t/${fcount(a)} · compact ${c.peak}t/${fcount(c)}`);
}
writeFileSync(resolve(ROOT, "bench/corpus/dumps/longsuite.json"), JSON.stringify(runs, null, 1));
console.log(`\nwrote bench/corpus/dumps/longsuite.json (${runs.length} runs)`);
