/**
 * Terminal REPL UI — basic user interface for the agentic loop.
 *
 * Commands:
 *   /status            — turn, tokens, cache belief/hit, divergence
 *   /context [zone]    — current render: zones, items, tokens
 *   /why <id>          — decision-ledger trace for an item
 *   /inspect [filter]  — store contents (rendered/invisible/all)
 *   /search <regex>    — ctx.search over the store
 *   /goal <text>       — goals.set
 *   /file <path> <a-b> — files.expand
 *   /release <path> <a-b> — files.release
 *   /promote <id> / /demote <id> — ctx value bumps
 *   /watch <id> <mode> — ctx.watch
 *   /quit
 */
import { AgentLoop } from "../optimizer/loop.ts";
import { MockProvider } from "../optimizer/providers.ts";
import { paramSetV1 } from "../optimizer/params.ts";
import { Ledger } from "../optimizer/ledger.ts";
import { StandingItem } from "../optimizer/items.ts";
import { executeIntent } from "../optimizer/intents.ts";
import { ZONE_ORDER } from "../optimizer/types.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agent-kernel-"));
const ledger = new Ledger(join(dir, "ledger.jsonl"));
const agent = new AgentLoop(new MockProvider(), paramSetV1("mock-1"), ledger);

agent.store.add(new StandingItem("identity", "identity",
  "You are an agent running on the agent-kernel context optimizer. Render is a projection, not an accumulator.").toContextItem());
agent.store.add(new StandingItem("directive", "directive",
  "Work in typed cells against the namespace. Use files./ctx./goals. tools to operate your context. Be precise.").toContextItem());

console.log("agent-kernel REPL — mock provider, /help for commands, /quit to exit");
process.on("SIGINT", () => { console.log("\\n(interrupt)"); });
process.stdin.setEncoding("utf8");

let buf = "";
process.stdin.on("data", (d) => { buf += d; });
process.stdin.on("data", async (d) => {
  const lines = buf.split("\\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    await handle(line.trim());
  }
});

async function handle(line: string): Promise<void> {
  if (line === "") return;
  try {
    if (line.startsWith("/")) {
      await command(line);
    } else {
      const out = await agent.run(line);
      console.log(renderTurn(out.modelText, out.renderTokens, out.cacheLedger.expected.hitTokens));
    }
  } catch (e) {
    console.error("error:", String(e));
  }
}

async function command(line: string): Promise<void> {
  const parts = line.split(/\\s+/);
  const cmd = parts[0];
  switch (cmd) {
    case "/help":
      console.log("commands: /status /context /why <id> /inspect /search <re> /goal <text> /file <p> <a-b> /release <p> <a-b> /promote <id> /demote <id> /watch <id> <mode> /quit");
      break;
    case "/status": {
      const out = lastOutcome;
      if (out === null) { console.log("no turns yet"); break; }
      console.log(`turn ${out.turn} | render ${out.renderTokens}t | expected cache-hit ${out.cacheExpectedHit}t | divergence ${out.cacheLedger.divergence}`);
      break;
    }
    case "/context": {
      const zone = parts[1] as (typeof ZONE_ORDER)[number] | undefined;
      for (const p of lastOutcome?.placements ?? []) {
        if (zone !== undefined && p.zone !== zone) continue;
        console.log(`${String(p.position).padStart(3)} ${p.zone.padEnd(13)} ${p.representation.padEnd(12)} ${p.tokens}t  ${p.id}`);
      }
      break;
    }
    case "/why":
    case "/inspect":
    case "/search":
    case "/goal":
    case "/file":
    case "/release":
    case "/promote":
    case "/demote":
    case "/watch": {
      const r = await runIntent(line);
      console.log(r.result);
      break;
    }
    case "/quit":
      await ledger.drain();
      process.exit(0);
      break;
    default:
      console.log(`unknown command: ${cmd} (try /help)`);
  }
}

let lastOutcome: Awaited<ReturnType<AgentLoop["run"]>> | null = null;
agentHooks();

function agentHooks(): void {
  // patch run to capture lastOutcome
  const origRun = agent.run.bind(agent);
  agent.run = async (msg: string) => {
    const out = await origRun(msg);
    lastOutcome = out;
    for (const tr of out.toolResults) console.log(`  [${tr.op}] ${tr.ok ? "ok" : "FAIL"}: ${tr.result}`);
    return out;
  };
}

async function runIntent(line: string): Promise<{ op: string; ok: boolean; result: string }> {
  const parts = line.split(/\\s+/);
  const cmd = parts[0]!.slice(1); // strip slash
  let intent: import("../optimizer/intents.ts").SteeringIntent | null = null;
  switch (cmd) {
    case "why": intent = { op: "ctx.why", id: parts[1] ?? "" }; break;
    case "inspect": intent = { op: "ctx.inspect", filter: "all" }; break;
    case "search": intent = { op: "ctx.search", pattern: parts.slice(1).join(" ") }; break;
    case "goal": intent = { op: "goals.set", id: `goal-${Date.now()}`, text: parts.slice(1).join(" ") }; break;
    case "file": {
      const m = (parts[2] ?? "1-40").split("-").map(Number) as [number, number];
      intent = { op: "files.expand", target: parts[1] ?? "", from: m[0] ?? 1, to: m[1] ?? 40 };
      break;
    }
    case "release": {
      const m = (parts[2] ?? "1-1").split("-").map(Number) as [number, number];
      intent = { op: "files.release", target: parts[1] ?? "", from: m[0] ?? 1, to: m[1] ?? 1 };
      break;
    }
    case "promote": intent = { op: "ctx.promote", id: parts[1] ?? "" }; break;
    case "demote": intent = { op: "ctx.demote", id: parts[1] ?? "" }; break;
    case "watch": {
      const mode = (parts[2] ?? "polled") as "live" | "polled" | "frozen";
      intent = { op: "ctx.watch", id: parts[1] ?? "", mode };
      break;
    }
  }
  if (intent === null) return { op: cmd, ok: false, result: "unparsed" };
  const r = executeIntent(intent, agent.store, ledger);
  if (!r.ok) return r;
  await agent.run("");
  return r;
}

function renderTurn(text: string, tokens: number, hit: number): string {
  return "\n" + text + "\n  (" + tokens + "t rendered, " + hit + "t expected cache-hit)\n";
}
