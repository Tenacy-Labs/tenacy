/**
 * ACCUMULATOR vs OPTIMIZER — head-to-head (ADR-0003 §5 baselines).
 *
 * Control: traditional text accumulator — append-only transcript,
 * truncation (system + first exchange + last 3 exchanges) on overflow.
 * Treatment: kernel (solver-managed render, Λ=2,048).
 *
 * Identical workload: s3-chunked-read (20 × 40-line chunks of api.log,
 * expand→distill→release), the corpus's own script. Both harnesses get
 * the same distillates (accumulator: assistant replies; kernel: model
 * turn items in the store — the solver must actually keep them).
 *
 * Measures: fact retention at final prompt, peak/mean prompt tokens,
 * prefix stability (KV-cache hit proxy).
 */
import { estTokens } from "../../src/optimizer/renderer.ts";
import { MockProvider } from "../../src/optimizer/providers.ts";
import { AgentLoop, makeTurnItem } from "../../src/optimizer/loop.ts";
import { executeIntent, type SteeringIntent } from "../../src/optimizer/intents.ts";
import { paramSetV1 } from "../../src/optimizer/params.ts";
import { StandingItem } from "../../src/optimizer/items.ts";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const WINDOW = 2048;
const FACTS = ["A-1042", "pump-B", "depot-north"];

// workload = corpus's own s3 script
const spec = JSON.parse(readFileSync(resolve(ROOT, "bench/corpus/scenarios.json"), "utf8")) as Record<string, { script?: string[] }>;
const SCRIPT = spec["s3-chunked-read"]?.script ?? [];
const logLines = readFileSync(resolve(ROOT, "bench/corpus/fixtures/api.log"), "utf8").split("\n");

function chunkBody(from: number, to: number): string {
  return logLines.slice(from - 1, to).join("\n");
}

/** Longest common prefix of adjacent prompts, as a fraction of the prompt length. */
function prefixStability(prompts: string[]): number[] {
  return prompts.slice(1).map((b, i) => {
    const a = prompts[i]!;
    let j = 0;
    while (j < a.length && j < b.length && a[j] === b[j]) j++;
    return j / Math.max(1, a.length);
  });
}

/** Believed KV hit tokens per turn: estTokens of the common prefix. */
function hitTokens(prompts: string[]): number[] {
  return prompts.slice(1).map((b, i) => {
    const a = prompts[i]!;
    let j = 0;
    while (j < a.length && j < b.length && a[j] === b[j]) j++;
    return estTokens(a.slice(0, j));
  });
}

// ── harness A: accumulator ───────────────────────────────────────────────
function runAccumulator() {
  const SYSTEM = "You are a helpful assistant.";
  type Msg = { role: "user" | "assistant"; content: string };
  let transcript: Msg[] = [];
  const prompts: string[] = [];
  const assemble = (): string => SYSTEM + "\n" + transcript.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}\n`).join("");

  for (const line of SCRIPT) {
    if (line.startsWith("say ")) {
      transcript.push({ role: "assistant", content: line.slice(4) });
    } else {
      const intent = JSON.parse(line) as SteeringIntent & { from?: number; to?: number };
      if (intent.op === "files.expand" && intent.from !== undefined && intent.to !== undefined) {
        transcript.push({ role: "user", content: `Read api.log lines ${intent.from}-${intent.to}:\n${chunkBody(intent.from, intent.to)}` });
      }
      // release: accumulator has no such op — the content just stays
    }
    let prompt = assemble();
    if (estTokens(prompt) > WINDOW) {
      // traditional truncation: anchor first exchange + last 6 messages
      transcript = [transcript[0]!, ...transcript.slice(-6)];
      prompt = assemble();
    }
    prompts.push(prompt);
  }
  const final = prompts.at(-1) ?? "";
  return {
    harness: "accumulator",
    facts: Object.fromEntries(FACTS.map((f) => [f, final.includes(f)])),
    peak: Math.max(...prompts.map((p) => estTokens(p))),
    mean: Math.round(prompts.reduce((s, p) => s + estTokens(p), 0) / prompts.length),
    stability: prefixStability(prompts).map((x) => Math.round(x * 100)),
    hitTokens: hitTokens(prompts),
    turns: prompts.length,
  };
}

// ── harness B: kernel ────────────────────────────────────────────────────
async function runKernel() {
  const ps = paramSetV1("m");
  ps.budgetLambda = 2048;
  const renderTexts: string[] = [];
  const renderToks: number[] = [];
  const modelHits: number[] = [];
  const loop = new AgentLoop(new MockProvider(), ps, null, {
    onRender: (rr) => { renderTexts.push(rr.text); renderToks.push(rr.blocks.reduce((s, b) => s + b.tokens, 0)); },
    onTurn: (o) => { modelHits.push(o.cacheExpectedHit); },
  });
  loop.fileContent = (t) => { try { return readFileSync(resolve(ROOT, t), "utf8"); } catch { return ""; } };
  loop.dirListing = (t) => { try { return readdirSync(resolve(ROOT, t)).join("\n"); } catch { return ""; } };
  loop.store.add(new StandingItem("identity", "identity", "corpus").toContextItem());

  let sayN = 0;
  let splitMode = false;
  for (const line of SCRIPT) {
    if (line.startsWith("say ")) {
      sayN += 1;
      loop.store.add(makeTurnItem(`distill-${sayN}`, "model", line.slice(4), sayN));
      continue;
    }
    const intent = JSON.parse(line) as SteeringIntent;
    if (intent.op === "files.expand" && !splitMode) {
      executeIntent(intent, loop.store, null);
      // flip the lens into split mode after first expand: fragments are additive
      splitMode = true;
      for (const it of loop.store.snapshot().values()) {
        if (it.id.startsWith("lens:") && typeof (it as { renderMode?: string }).renderMode === "object") continue;
      }
      // direct registry access via loop's lensRegistry
      const reg = (loop as unknown as { lensRegistry: Map<string, { renderMode: string }> }).lensRegistry;
      for (const l of reg.values()) l.renderMode = "split";
      await loop.run(line);
      continue;
    }
    executeIntent(intent, loop.store, null);
    await loop.run(line);  // advance turn: render happens under budget
  }
  await loop.run("report your findings");

  const final = renderTexts.at(-1) ?? "";
  return {
    harness: "kernel",
    facts: Object.fromEntries(FACTS.map((f) => [f, final.includes(f)])),
    peak: Math.max(...renderToks),
    mean: Math.round(renderToks.reduce((s, t) => s + t, 0) / renderToks.length),
    stability: prefixStability(renderTexts).map((x) => Math.round(x * 100)),
    hitTokens: modelHits,
    turns: renderTexts.length,
  };
}

const acc = runAccumulator();
const kernel = await runKernel();

const row = (label: string, a: string | number, k: string | number): void => console.log(`${label.padEnd(28)}${String(a).padStart(16)}${String(k).padStart(16)}`);
console.log("\n=== ACCUMULATOR vs OPTIMIZER — s3-chunked-read, Λ=2,048 ===\n");
console.log(`${"".padEnd(28)}${"accumulator".padStart(16)}${"kernel".padStart(16)}`);
row("facts kept (of 3)", `${Object.values(acc.facts).filter(Boolean).length}/3`, `${Object.values(kernel.facts).filter(Boolean).length}/3`);
row("peak prompt tokens", acc.peak, kernel.peak);
row("mean prompt tokens", acc.mean, kernel.mean);
row("prompts/turns", acc.turns, kernel.turns);
const accStable = acc.stability.filter((x) => x >= 95).length;
const kernStable = kernel.stability.filter((x) => x >= 95).length;
row("stable prefixes (≥95%)", `${accStable}/${acc.stability.length}`, `${kernStable}/${kernel.stability.length}`);
row("mean believed hit tokens", Math.round(acc.hitTokens.reduce((s2, x) => s2 + x, 0) / Math.max(1, acc.hitTokens.length)), Math.round(kernel.hitTokens.reduce((s2, x) => s2 + x, 0) / Math.max(1, kernel.hitTokens.length)));
row("hit / prompt ratio", `${Math.round(100 * acc.hitTokens.reduce((s2, x) => s2 + x, 0) / Math.max(1, acc.hitTokens.length) / acc.mean)}%`, `${Math.round(100 * kernel.hitTokens.reduce((s2, x) => s2 + x, 0) / Math.max(1, kernel.hitTokens.length) / kernel.mean)}%`);
console.log("\nfacts detail:");
for (const f of FACTS) console.log(`  ${f.padEnd(12)} acc=${acc.facts[f] ? "KEPT" : "LOST"}  kernel=${kernel.facts[f] ? "KEPT" : "LOST"}`);
console.log("\naccumulator stability trace:", acc.stability.join(","));
console.log("kernel stability trace:", kernel.stability.join(","));
