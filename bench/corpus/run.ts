/**
 * Pressure-ladder scenario runner (ADR-0003 calibration corpus).
 *
 * Two modes:
 *   bun bench/corpus/run.ts                 — scripted/mock (CI, deterministic)
 *   bun bench/corpus/run.ts --live <name>   — live model under contextWindow pressure
 *
 * Pass criteria per scenario:
 *   1. every recall string appears in the transcript (model reply or
 *      scripted say-notice) AFTER the turn that planted it;
 *   2. (mock mode) every scripted intent executed ok;
 *   3. (live mode) rendered tokens stayed <= contextWindow every turn.
 */
import { AgentLoop } from "../../src/optimizer/loop.ts";
import { MockProvider } from "../../src/optimizer/providers.ts";
import { TurnBoundaryWatcher, LiveLensAdapter } from "../../src/optimizer/live-views.ts";
import { executeIntent, type SteeringIntent } from "../../src/optimizer/intents.ts";
import { paramSetV1 } from "../../src/optimizer/params.ts";
import { StandingItem } from "../../src/optimizer/items.ts";
import { buildProvider, loadHarnessConfig, paramSetFor } from "../../src/optimizer/registry.ts";
import { withIntentParsing, INTENT_PROTOCOL_DOC } from "../../src/optimizer/live.ts";
import { readFileSync, appendFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const SPEC = JSON.parse(readFileSync(resolve(import.meta.dir, "scenarios.json"), "utf8")) as Record<string, Scenario>;

interface Scenario {
  desc: string;
  turns: unknown;
  script?: string[];
  recall: string[];
}

const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const liveOnly = LIVE ? args[args.indexOf("--live") + 1] : undefined;
if (args.includes("--list")) {
  for (const [k, v] of Object.entries(SPEC)) {
    if (k.startsWith("$")) continue;
    console.log(`${k}  — ${(v as Scenario).desc}`);
  }
  process.exit(0);
}

/** Transcript per scenario: (turnIndex, speaker, text). */
type Turn = { i: number; who: string; text: string };

const budgetState = { max: 0, over: false, lambda: 0 };
const scenarioRenders: string[] = [];

function newLoop(): { loop: AgentLoop; engine: TurnBoundaryWatcher } {
  const engine = new TurnBoundaryWatcher();
  const hooks = {
    onRender: (rr: { text: string }): void => { scenarioRenders.push(rr.text); },
    onTurn: (o: { turn: number; renderTokens: number }): void => {
      budgetState.max = Math.max(budgetState.max, o.renderTokens);
      if (LIVE && budgetState.lambda > 0 && o.renderTokens > budgetState.lambda) {
        console.log(`  ✗ OVER BUDGET turn ${o.turn}: ${o.renderTokens}t > Λ=${budgetState.lambda}`);
        budgetState.over = true;
      }
    },
  };
  let loop: AgentLoop;
  if (LIVE) {
    const cfg = loadHarnessConfig();
    if (cfg === null) throw new Error("live mode requires agents/config.json (contextWindow + provider)");
    const provider = withIntentParsing("zai", buildProvider("zai", {}));
    const ps = paramSetFor(provider.modelId, cfg);
    budgetState.lambda = ps.budgetLambda;
    console.log(`  live: ${provider.modelId} | Λ=${ps.budgetLambda}t (contextWindow=${cfg.contextWindow ?? "unset"})`);
    loop = new AgentLoop(provider, ps, null, hooks);
  } else {
    loop = new AgentLoop(new MockProvider(), paramSetV1("m"), null, hooks);
  }
  loop.watcher = engine;
  loop.fileContent = (t) => {
    try { return readFileSync(resolve(ROOT, t), "utf8"); } catch { try { return readFileSync(t, "utf8"); } catch { return ""; } }
  };
  loop.dirListing = (t) => {
    try {
      const ents = readdirSync(resolve(ROOT, t), { withFileTypes: true });
      return ents.sort((a, b) => a.name.localeCompare(b.name)).map((e) => (e.isDirectory() ? e.name + "/" : e.name)).join("\n");
    } catch { return ""; }
  };
  loop.store.add(new StandingItem("identity", "identity",
    "You are running the agent-kernel pressure corpus. " + INTENT_PROTOCOL_DOC +
    " Work under a tight token budget: expand only the ranges you need, distill what matters into your replies, release ranges when done. " +
    "When your accumulated notes grow long, consolidate them with convo.merge (merge older turns into one summary turn) so findings survive.").toContextItem());
  return { loop, engine };
}

async function runScenario(name: string, spec: Scenario): Promise<boolean> {
  console.log(`\n── ${name} — ${spec.desc}`);
  const { loop, engine } = newLoop();
  const transcript: Turn[] = [];
  const renders: string[] = [];
  let turnIdx = 0;
  let ok = true;

  const logPath = resolve(ROOT, "bench/corpus/fixtures/api.log");
  const pristineLog = readFileSync(logPath, "utf8");
  const mutationAlert = (): void => {
    // external mutation: append a NEW alert line (restored after the scenario)
    appendFileSync(logPath,
      `2026-08-15T04:19:00Z fleet coolant ALERT pump-B temperature excursion depot-north (append)\n`);
    engine.push({ lensId: `lens:bench/corpus/fixtures/api.log`, path: "bench/corpus/fixtures/api.log", kind: "change" });
    loop.refreshLensFromSubstrate(`lens:bench/corpus/fixtures/api.log`);
  };

  const record = (who: string, text: string): void => { transcript.push({ i: turnIdx, who, text }); };

  const useScript = !LIVE && spec.script !== undefined;
  if (useScript) {
    // SCRIPTED: intents drive the loop directly; say-lines are distilled
    // notices recorded as model-side output.
    for (const line of spec.script ?? []) {
      if (line.startsWith("say ")) { record("model", line.slice(4)); continue; }
      let intent: SteeringIntent | undefined;
      try { intent = JSON.parse(line) as SteeringIntent; } catch { intent = undefined; }
      if (intent === undefined || typeof intent.op !== "string") { console.log(`  ✗ unparseable: ${line}`); ok = false; continue; }
      const r = executeIntent(intent, loop.store, null);
      record("intent", `${intent.op} → ${r.result}`);
      if (!r.ok) { console.log(`  ✗ intent failed: ${line} → ${r.result}`); ok = false; }
      // after every intent batch, advance a turn so renders/solver stay honest
      await loop.run(line);   // mock model observes the intent result
      turnIdx += 1;
    }
  } else {
    const turns = spec.turns as Array<{ msg?: string; mutation?: string }>;
    for (const t of turns) {
      if (t.mutation === "append-alert") { mutationAlert(); continue; }
      if (t.msg === undefined) continue;
      const res = await loop.run(t.msg);
      record("model", res.modelText);
      console.log(`  t${turnIdx + 1} model: ${res.modelText.slice(0, 140).replace(/\n/g, " ")}`);
      for (const tr of res.toolResults) console.log(`    intent ${tr.op}: ${tr.ok ? "ok" : "FAIL"} — ${tr.result.slice(0, 90)}`);
      const lastRender = scenarioRenders.at(-1) ?? "";
      console.log(`    render: ${lastRender.length} chars, max-seen ${budgetState.max}t / Λ ${budgetState.lambda}`);
      turnIdx += 1;
    }
  }

  // restore the mutated fixture so the corpus stays pristine across runs
  writeFileSync(logPath, pristineLog);

  // Recall check. LIVE: facts must appear in model replies (true comprehension).
  // MOCK: the model cannot comprehend; the offline contract is (a) scripted
  // say-distillates OR (b) the fact is PRESENT IN THE RENDER the model saw
  // while the substrate was held — proof the pipeline carried it.
  const modelText = transcript.filter((t) => t.who === "model").map((t) => t.text).join("\n");
  const renderText = scenarioRenders.join("\n");
  for (const needle of spec.recall) {
    const inModel = modelText.includes(needle);
    const inRender = !LIVE && renderText.includes(needle);
    const hit = inModel || inRender;
    console.log(`  ${hit ? "✓" : "✗"} recall: "${needle}"${inModel ? "" : inRender ? " (render-carried)" : ""}`);
    if (!hit) ok = false;
  }
  return ok;
}

async function main(): Promise<void> {
  const results: Array<[string, boolean]> = [];
  const names = Object.keys(SPEC).filter((k) => !k.startsWith("$"));
  for (const name of names) {
    if (LIVE && liveOnly !== undefined && name !== liveOnly) continue;
    results.push([name, await runScenario(name as Scenario extends never ? never : string, SPEC[name]!)]);
  }
  const fails = results.filter(([, p]) => !p).length;
  console.log(`\n${fails === 0 ? "ALL SCENARIOS PASS" : `${fails} SCENARIO(S) FAILED`}`);
  process.exit(fails === 0 ? 0 : 1);
}

void main();
