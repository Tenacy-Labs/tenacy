/**
 * Terminal REPL UI — the human surface of the context optimizer.
 *
 *   bun src/ui/repl.ts [provider] [model]
 *
 * Boots a LIVE provider from harness config when a name is given (or when
 * harness config has keys); falls back to the mock provider for offline
 * demo. Live models are wrapped with intent parsing — ```intents fences in
 * replies are stripped from visible text and executed at the coordinator
 * (proposer/applier split).
 *
 * Human commands (local, no model call):
 *   /status              — turn, tokens, cache belief/hit, divergence
 *   /context [zone]      — current render layout (zone filter optional)
 *   /why <id>            — decision-ledger trace for an item
 *   /inspect [filter]    — store contents (rendered/invisible/all)
 *   /search <regex>      — ctx.search over the store
 *   /goal <text>         — declare a goal (id auto-generated)
 *   /file <path> <a-b>   — pull a real file's line range into a lens
 *   /release <path> <a-b>— drop a lens range
 *   /promote|/demote <id>— value bumps
 *   /watch <id> <mode>   — live/polled/frozen
 *   /provider [name] [model] — swap provider mid-session (re-pins ParamSet, A2)
 *   /ledger              — ledger path + flushed line count
 *   /quit
 *
 * Anything else is a user turn: rendered zones -> live model -> reply +
 * any intents the model proposed (shown as [op] ok/FAIL lines).
 */
import { AgentLoop } from "../optimizer/loop.ts";
import { TurnBoundaryWatcher, FsWatchAdapter } from "../optimizer/live-views.ts";
import { resolve, dirname } from "node:path";
import process from "node:process";
const cwd = () => process.cwd();
import { MockProvider } from "../optimizer/providers.ts";
import { buildProvider, availableProviders, loadHarnessConfig, paramSetFor } from "../optimizer/registry.ts";
import { Ledger } from "../optimizer/ledger.ts";
import { StandingItem } from "../optimizer/items.ts";
import { executeIntent } from "../optimizer/intents.ts";
import { INTENT_PROTOCOL_DOC, withIntentParsing } from "../optimizer/live.ts";
import { ZONE_ORDER } from "../optimizer/types.ts";
import type { Provider, ModelResponse } from "../optimizer/providers.ts";
import type { Block } from "../optimizer/types.ts";
import type { SteeringIntent } from "../optimizer/intents.ts";
import { readFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { saveSession, restoreSession, sessionsDir } from "../optimizer/sessions.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── boot: live provider when requested or when harness config has keys ──
const providerName = process.argv[2];
let inner: Provider;
let bootedLive = false;
if (providerName !== undefined) {
  inner = buildProvider(providerName, process.argv[3] !== undefined ? { model: process.argv[3] } : {});
  bootedLive = true;
} else {
  const avail = availableProviders();
  if (avail.length > 0) {
    inner = buildProvider(avail[0]!);
    bootedLive = true;
  } else {
    inner = new MockProvider();
  }
}
const model = withIntentParsing(inner.modelId, inner);

const dir = mkdtempSync(join(tmpdir(), "agent-kernel-"));
const ledgerPath = join(dir, "ledger.jsonl");
const ledger = new Ledger(ledgerPath);
const agent = new AgentLoop(model, paramSetFor(inner.modelId, loadHarnessConfig()), ledger);
// Live views (0002d §5): engine attached at boot; fs adapters attach
// per-lens when a lens flips to live (via /watch or model ctx.watch).
const liveEngine = new TurnBoundaryWatcher();
agent.watcher = liveEngine;
const liveAdapters = new Map<string, FsWatchAdapter>();

agent.store.add(new StandingItem("identity", "identity",
  "You are an agent running on the agent-kernel context optimizer. Render is a projection, not an accumulator. " + INTENT_PROTOCOL_DOC,
).toContextItem());
agent.store.add(new StandingItem("directive", "directive",
  "Work in typed cells against the namespace. Use files./ctx./goals. tools to operate your context. Be precise.").toContextItem());

// Real file reads for lenses (expand fails honestly on unreadable targets)
// Namespace producer v1: the optimizer's own exports as a browsable tree
// (a real kernel wires its commons commit log; this proves the surface).
agent.nsProducers.set("optimizer", () => ({
  children(prefix: string) {
    const all = [
      { path: "optimizer/solver", kind: "group" as const },
      { path: "optimizer/renderer", kind: "group" as const },
      { path: "optimizer/store", kind: "cell" as const },
      { path: "optimizer/solver/solve", kind: "binding" as const, repr: "MCKP over option surface" },
      { path: "optimizer/solver/reliefByDensity", kind: "binding" as const, repr: "v1.1 worst-density drop" },
      { path: "optimizer/renderer/render", kind: "binding" as const, repr: "zone-ordered deterministic" },
      { path: "optimizer/renderer/estTokens", kind: "binding" as const, repr: "chars/4 heuristic" },
    ];
    return all.filter((n) => {
      const parent = n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : "";
      return parent === prefix;
    });
  },
  commitsSince() { return []; },  // static v1 — no commits yet
}));

agent.dirListing = (target: string): string => {
  try {
    const ents = readdirSync(target, { withFileTypes: true });
    return ents
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
      .join("\n");
  } catch {
    return "";
  }
};

agent.fileContent = (target: string): string => {
  try {
    return readFileSync(target, "utf8");
  } catch {
    return "";
  }
};

let lastOutcome: Awaited<ReturnType<AgentLoop["run"]>> | null = null;

console.log("agent-kernel REPL");
console.log(`provider: ${bootedLive ? inner.modelId : "mock (no live config)"} | ledger: ${ledgerPath}`);
console.log("type a message, or /help for commands. /quit exits.");
if (!bootedLive) console.log("(mock provider — /provider <name> to attach a live one)");

process.on("SIGINT", () => {
  console.log("\n(interrupt) — /quit to exit");
});

process.stdin.setEncoding("utf8");

// Input queue: lines arriving while a turn is busy are QUEUED, never
// dropped. The pump runs one line at a time; /quit drains the queue first.
const queue: string[] = [];
let pumping = false;
let buf = "";
process.stdin.on("data", (d: string) => {
  buf += d;
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) { queue.push(line.trim()); }
  void pump();
});
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length > 0) {
      const line = queue.shift()!;
      if (line === "/quit") {
        await flushAndExit();
        return;
      }
      await handle(line);
    }
  } finally {
    pumping = false;
  }
}

async function flushAndExit(): Promise<void> {
  queue.length = 0; // drop queued commands; the human said quit
  await ledger.drain();
  process.exit(0);
}

async function handle(line: string): Promise<void> {
  if (line === "") return;
  try {
    if (line.startsWith("/")) {
      await command(line);
    } else {
      await turn(line);
    }
  } catch (e) {
    console.error("error:", String(e));
  }
}

let busy = false;
async function turn(input: string): Promise<void> {
  if (busy) { console.log("(busy — wait for the current turn)"); return; }
  busy = true;
  const t0 = Date.now();
  try {
    const out = await agent.run(input);
    lastOutcome = out;
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log("\n" + out.modelText);
    for (const tr of out.toolResults) console.log(`  [${tr.op}] ${tr.ok ? "ok" : "FAIL"}: ${tr.result}`);
    console.log(`  (${out.renderTokens}t rendered, ${out.cacheLedger.expected.hitTokens}t expected cache-hit, ${secs}s)`);
  } finally {
    busy = false;
  }
}

async function command(line: string): Promise<void> {
  const parts = line.split(/\s+/);
  const cmd = parts[0];
  switch (cmd) {
    case "/help":
      console.log("local: /status /context [zone] /why <id> /inspect [filter] /search <re> /goal <text> /file <path> <a-b> /release <path> <a-b> /promote <id> /demote <id> /watch <id> <mode> /provider [name] [model] /save [name] /resume <name> /sessions /ledger /quit");
      break;
    case "/status": {
      if (lastOutcome === null) { console.log("no turns yet"); break; }
      const out = lastOutcome;
      console.log(`turn ${out.turn} | render ${out.renderTokens}t | expected cache-hit ${out.cacheExpectedHit}t | divergence ${out.cacheLedger.divergence}`);
      break;
    }
    case "/context": {
      if (lastOutcome === null) { console.log("no turns yet"); break; }
      const zone = parts[1] as (typeof ZONE_ORDER)[number] | undefined;
      for (const p of lastOutcome.placements) {
        if (zone !== undefined && p.zone !== zone) continue;
        console.log(`${String(p.position).padStart(3)} ${p.zone.padEnd(13)} ${p.representation.padEnd(12)} ${p.tokens}t  ${p.id}`);
      }
      break;
    }
    case "/ledger": {
      try {
        const n = readFileSync(ledgerPath, "utf8").split("\n").filter((l) => l !== "").length;
        console.log(`ledger: ${ledgerPath} (${n} lines flushed)`);
      } catch {
        console.log(`ledger: ${ledgerPath} (not yet flushed)`);
      }
      break;
    }
    case "/provider": {
      const name = parts[1];
      if (name === undefined) {
        console.log(`current: ${agent.providerId}  |  available (keys present): ${availableProviders().join(", ") || "none"}`);
        break;
      }
      try {
        const p = buildProvider(name, parts[2] !== undefined ? { model: parts[2] } : {});
        agent.swapProvider(withIntentParsing(p.modelId, p), paramSetFor(p.modelId, loadHarnessConfig()));
        console.log(`provider -> ${name} (${p.modelId})`);
      } catch (e) {
        console.log(String(e));
      }
      break;
    }
    case "/save": {
      const name = parts[1] ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      const dir = sessionsDir();
      mkdirSync(dir, { recursive: true });
      const path = `${dir}/${name}.json`;
      const sf = saveSession(agent, path, bootedLive ? (process.argv[2] ?? availableProviders()[0] ?? "mock") : "mock");
      console.log(`saved ${sf.rows.length} rows -> ${path} (turn ${sf.header.turn}, ${sf.header.modelId})`);
      break;
    }
    case "/resume": {
      const name = parts[1];
      if (name === undefined) { console.log("usage: /resume <name> (see /sessions)"); break; }
      const path = name.includes("/") ? name : `${sessionsDir()}/${name}.json`;
      try {
        const { header, restored } = restoreSession(agent, path);
        console.log(`resumed ${restored} rows from ${path} (saved turn ${header.turn}, ${header.modelId})`);
        lastOutcome = null;
      } catch (e) {
        console.log(String(e));
      }
      break;
    }
    case "/sessions": {
      const dir = sessionsDir();
      if (!existsSync(dir)) { console.log(`no sessions dir yet (${dir})`); break; }
      const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse();
      if (files.length === 0) { console.log("no saved sessions"); break; }
      for (const f of files.slice(0, 15)) {
        try {
          const sf = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
          console.log(`${f.slice(0, -5).padEnd(34)} turn ${String(sf.header?.turn ?? "?").padStart(3)}  ${sf.header?.modelId ?? "?"}  ${sf.rows?.length ?? 0} rows  ${sf.header?.savedAt ?? ""}`);
        } catch { console.log(f); }
      }
      break;
    }
    case "/quit":
      // Handled at the queue head (flushAndExit) — reached only if the
      // queue pump is bypassed; drain defensively.
      await flushAndExit();
      break;
    default: {
      // /why /inspect /search /goal /file /release /promote /demote /watch
      const intent = parseLocalIntent(parts);
      if (intent === null) { console.log(`unknown command: ${cmd} (try /help)`); break; }
      const r = executeIntent(intent, agent.store, ledger);
      console.log(r.result);
      // /watch live attaches a REAL fs watcher for file lenses (0002d §5)
      if (intent.op === "ctx.watch" && intent.mode === "live" && !intent.id.startsWith("turn-")) {
        const lens = agent.lensRegistryView().get(intent.id);
        const path = lens !== undefined && "target" in lens ? String((lens as unknown as { target: string }).target) : intent.id.replace(/^lens:/, "");
        const abs = path.startsWith("/") ? path : resolve(cwd(), path);
        const existing = liveAdapters.get(intent.id);
        if (existing !== undefined) { existing.stop(); liveAdapters.delete(intent.id); }
        const adapter = new FsWatchAdapter(liveEngine, intent.id, dirname(abs));
        adapter.start();
        liveAdapters.set(intent.id, adapter);
        console.log(`live: fs.watch on ${dirname(abs)} -> lens ${intent.id}`);
      }
      if (intent.op === "ctx.watch" && intent.mode !== "live") {
        const existing = liveAdapters.get(intent.id);
        if (existing !== undefined) { existing.stop(); liveAdapters.delete(intent.id); }
      }
      break;
    }
  }
}

function parseLocalIntent(parts: string[]): SteeringIntent | null {
  const cmd = parts[0]!.slice(1); // strip slash
  switch (cmd) {
    case "why": return { op: "ctx.why", id: parts[1] ?? "" };
    case "inspect": return { op: "ctx.inspect", filter: (parts[1] as "rendered" | "invisible" | "all") ?? "all" };
    case "search": return { op: "ctx.search", pattern: parts.slice(1).join(" ") };
    case "goal": return { op: "goals.set", id: `goal-${Date.now()}`, text: parts.slice(1).join(" ") };
    case "file": {
      const m = (parts[2] ?? "1-40").split("-").map(Number);
      return { op: "files.expand", target: parts[1] ?? "", from: m[0] ?? 1, to: m[1] ?? 40 };
    }
    case "release": {
      const m = (parts[2] ?? "1-1").split("-").map(Number);
      return { op: "files.release", target: parts[1] ?? "", from: m[0] ?? 1, to: m[1] ?? 1 };
    }
    case "promote": return { op: "ctx.promote", id: parts[1] ?? "" };
    case "demote": return { op: "ctx.demote", id: parts[1] ?? "" };
    case "watch": return { op: "ctx.watch", id: parts[1] ?? "", mode: (parts[2] ?? "polled") as "live" | "polled" | "frozen" };
    default: return null;
  }
}
