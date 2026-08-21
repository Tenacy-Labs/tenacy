/**
 * Live task runner — one real agentic task through the full stack:
 * config-loaded provider → rendered zones → live model → intent protocol
 * → coordinator-verified goal completion → journaled ledger.
 *
 *   bun src/analysis/task.ts <provider> [model]
 *
 * The task: a 240-line notes file with planted details. The agent must
 * (1) expand the right region, (2) declare the goal, (3) answer from the
 * actual lines, (4) close the goal. Verification is at the coordinator:
 * the run passes only if the goal registry shows completed AND the reply
 * contains facts only present in the file. The ledger journals every
 * turn for the analysis layer.
 */
import { AgentLoop } from "../optimizer/loop.ts";
import { Ledger } from "../optimizer/ledger.ts";
import { paramSetV1 } from "../optimizer/params.ts";
import { buildProvider } from "../optimizer/registry.ts";
import { StandingItem } from "../optimizer/items.ts";
import { INTENT_PROTOCOL_DOC, parseIntentsFromText } from "../optimizer/live.ts";
import type { ModelResponse } from "../optimizer/providers.ts";
import type { Provider } from "../optimizer/providers.ts";
import type { SteeringIntent } from "../optimizer/intents.ts";

// ── planted task fixture ────────────────────────────────────────────────
const LINES = 240;
const MAGIC_LINE = 187;
const planted = (i: number): string => {
  if (i === MAGIC_LINE) return "line 187: NOTE — the launch code is ORCHID-7 and the spare key is in drawer 4";
  if (i === 42) return "line 43: budget approved for the Miller account, cap 12,500";
  return `line ${i + 1}: routine log entry ${i + 1} — all systems nominal`;
};

const NOTES = Array.from({ length: LINES }, (_, i) => planted(i)).join("\n");

interface ParseProviderArgs {
  modelId: string;
  call: Provider["call"];
}
function withIntentParsing(modelId: string, inner: Provider): Provider {
  return {
    modelId,
    call: async (blocks, userMessage) => {
      const r = await inner.call(blocks, userMessage);
      const { text, intents } = parseIntentsFromText(r.text);
      return { ...r, text, intents };
    },
  };
}

async function main(): Promise<void> {
  const name = process.argv[2] ?? "zai";
  const modelOverride = process.argv[3] ?? undefined;

  const provider = modelOverride !== undefined
    ? buildProvider(name, { model: modelOverride })
    : buildProvider(name);
  const parsed: Provider = withIntentParsing(provider.modelId, provider);
  const ledgerPath = "/tmp/agent-kernel-live-task.jsonl";
  const ledger = new Ledger(ledgerPath);
  const loop = new AgentLoop(parsed, paramSetV1(provider.modelId), ledger);
  loop.store.add(new StandingItem("identity", "identity",
    "You are a meticulous file-reading agent. " + INTENT_PROTOCOL_DOC).toContextItem());
  loop.fileContent = () => NOTES;

  // Choreography: intents execute AFTER the reply that proposes them, so
  // read-then-answer spans two turns: t1 proposes files.expand; t2 sees the
  // lens in context and answers; t3 declares+closes the goal.
  const t0 = Date.now();
  const r1 = await loop.run("notes.txt has a critical detail near line 187. Use files.expand to pull lines 180-195 of notes.txt into your context now.");
  const elapsed1 = ((Date.now() - t0) / 1000).toFixed(1);

  const r2 = await loop.run("Now read that region in your context and answer: what is the launch code, and where is the spare key?");

  const r3 = await loop.run("Declare goal g1 (id g1) with goals.set — text \"retrieve the launch code\" — and immediately close it with goals.update status completed, since you have the answer.");

  await ledger.drain();

  // ── coordinator-side verification ─────────────────────────────────────
  const g1 = loop.goalItem("g1");
  const goalDone = g1 !== undefined && g1.status === "completed";
  const answerHasCode = /ORCHID-7/.test(r2.modelText);
  const answerHasDrawer = /drawer\s*4/i.test(r2.modelText);

  console.log("── live task report ──");
  console.log("provider:", provider.modelId);
  console.log("turn1 reply (trimmed):", r1.modelText.slice(0, 160));
  console.log("turn2 answer (trimmed):", r2.modelText.slice(0, 160));
  console.log("turn1 seconds:", elapsed1);
  console.log("goal g1 completed:", goalDone);
  console.log("reply contains ORCHID-7:", answerHasCode);
  console.log("reply mentions drawer 4:", answerHasDrawer);
  console.log("cache hit tokens t1/t2/t3:", r1.cacheLedger.expected.hitTokens, "/", r2.cacheLedger.expected.hitTokens, "/", r3.cacheLedger.expected.hitTokens);
  console.log("ledger:", ledgerPath);
  const pass = goalDone && answerHasCode && answerHasDrawer;
  console.log(pass ? "RESULT: PASS" : "RESULT: FAIL");
  process.exit(pass ? 0 : 1);
}

await main();
