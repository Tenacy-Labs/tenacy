/**
 * agent-kernel TUI — OpenTUI front-end over the same AgentLoop surface.
 *
 *   bun src/ui/tui.tsx [provider] [model]
 *
 * Layout:
 *   ┌ transcript (scrollback) ──────────────────────────────────┐
 *   │ user / model turns + intent lines                          │
 *   ├ sidebar ─────────────────────────────────────────────────┤
 *   │ RENDER  layout by zone w/ tokens                           │
 *   │ CACHE   expected hit tokens, divergence                    │
 *   │ GOALS   registry status                                    │
 *   ├ input ────────────────────────────────────────────────────┤
 *   │ > typed line (Enter sends; /commands same as REPL)         │
 *   └────────────────────────────────────────────────────────────┘
 *
 * The lean REPL (repl.ts) remains the core surface; this TUI is the
 * optimizer's visible projection (ADR-0003 instrument-first, UI layer).
 */
import { useEffect, useRef, useState } from "react";
import { createCliRenderer, type InputRenderable, type ScrollBoxRenderable } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { AgentLoop } from "../optimizer/loop.ts";
import { MockProvider } from "../optimizer/providers.ts";
import { buildProvider, availableProviders, loadHarnessConfig, paramSetFor } from "../optimizer/registry.ts";
import { Ledger } from "../optimizer/ledger.ts";
import { StandingItem } from "../optimizer/items.ts";
import { executeIntent } from "../optimizer/intents.ts";
import { INTENT_PROTOCOL_DOC, withIntentParsing } from "../optimizer/live.ts";
import type { Provider } from "../optimizer/providers.ts";
import type { SteeringIntent } from "../optimizer/intents.ts";
import type { Placement, Block } from "../optimizer/types.ts";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── boot (same policy as the REPL) ───────────────────────────────────────
const providerName = process.argv[2];
let inner: Provider;
if (providerName !== undefined) {
  inner = buildProvider(providerName, process.argv[3] !== undefined ? { model: process.argv[3] } : {});
} else {
  const avail = availableProviders();
  inner = avail.length > 0 ? buildProvider(avail[0]!) : new MockProvider();
}
const model = withIntentParsing(inner.modelId, inner);
const dir = mkdtempSync(join(tmpdir(), "agent-kernel-tui-"));
const ledger = new Ledger(join(dir, "ledger.jsonl"));
const agent = new AgentLoop(model, paramSetFor(inner.modelId, loadHarnessConfig()), ledger, {
  // Capture the exact rendered blocks — the blurbs that entered the last
  // context window — for the sidebar's CONTEXT panel.
  onRender: (rr) => { state.blocks = rr.blocks; },
});
agent.store.add(new StandingItem("identity", "identity",
  "You are an agent running on the agent-kernel context optimizer. Render is a projection, not an accumulator. " + INTENT_PROTOCOL_DOC,
).toContextItem());
agent.fileContent = (target) => {
  try { return readFileSync(target, "utf8"); } catch { return ""; }
};

// ── session state shared with React tree ─────────────────────────────────
interface TurnLine { id: number; who: "user" | "model" | "intent"; text: string; ok?: boolean; meta?: string }
let lineSeq = 0;
const state = {
  lines: [] as TurnLine[],
  placements: [] as Placement[],
  blocks: [] as Block[],
  expandedBlock: null as string | null,   // itemId of the expanded blurb
  renderTokens: 0,
  hitTokens: 0,
  divergence: "",
  turn: 0,
  busy: false,
  goals: [] as Array<{ id: string; text: string; status: string }>,
  listeners: new Set<() => void>(),
  emit(): void { for (const l of this.listeners) l(); },
};
type SessionState = typeof state;
function notify(): void { state.emit(); }

function App() {
  const [, forceRender] = useState(0);
  const inputRef = useRef<InputRenderable | null>(null);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => {
    state.listeners.add(() => forceRender((n) => n + 1));
    return () => { state.listeners.delete(() => forceRender((n) => n + 1)); };
  }, []);

  async function send(lineRaw: string): Promise<void> {
    const line = lineRaw.trim();
    if (line === "") return;
    if (line === "/quit") { await quit(); return; }
    state.lines.push({ id: ++lineSeq, who: "user", text: line });
    if (line.startsWith("/")) {
      const intent = parseLocalIntent(line);
      if (intent === null) { state.lines.push({ id: ++lineSeq, who: "intent", text: `unknown command: ${line.split(" ")[0]}`, ok: false }); notify(); return; }
      const r = executeIntent(intent, agent.store, ledger);
      state.lines.push({ id: ++lineSeq, who: "intent", text: `[${r.op}] ${r.result}`, ok: r.ok });
      refreshGoals();
      notify();
      return;
    }
    state.busy = true; notify();
    const t0 = Date.now();
    try {
      const out = await agent.run(line);
      state.turn = out.turn;
      state.placements = out.placements;
      state.renderTokens = out.renderTokens;
      state.hitTokens = out.cacheLedger.expected.hitTokens;
      state.divergence = String(out.cacheLedger.divergence);
      state.lines.push({ id: ++lineSeq, who: "model", text: out.modelText, meta: `${out.renderTokens}t render, ${out.cacheExpectedHit}t cache-hit, ${((Date.now()-t0)/1000).toFixed(1)}s` });
      for (const tr of out.toolResults) state.lines.push({ id: ++lineSeq, who: "intent", text: `[${tr.op}] ${tr.ok ? "ok" : "FAIL"}: ${tr.result}`, ok: tr.ok });
      refreshGoals();
    } catch (e) {
      state.lines.push({ id: ++lineSeq, who: "intent", text: `error: ${String(e)}`, ok: false });
    } finally {
      state.busy = false; notify();
    }
  }

  function refreshGoals(): void {
    const all = agent.store.all();
    state.goals = all.filter((it) => it.kind === "goal").map((g) => ({ id: g.id, text: g.serialize(), status: g.serialize().includes("completed") ? "completed" : "active" }));
  }

  async function quit(): Promise<void> {
    shutdown();
  }

  return (
    <box flexGrow={1} flexDirection="column">
      {/* header */}
      <box height={1}>
        <text fg="black" bg="cyan"> agent-kernel </text>
        <text fg="gray">{inner.modelId} · turn {state.turn} · {state.busy ? "thinking…" : "ready"}</text>
      </box>
      {/* main: transcript + sidebar */}
      <box height="80%" flexDirection="row" gap={1}>
        <scrollbox ref={scrollRef} flexGrow={1} flexDirection="column">
          {state.lines.map((l) => (
            <box key={l.id} flexDirection="row" gap={1}>
              <text fg={l.who === "user" ? "green" : l.who === "model" ? "white" : l.ok === false ? "red" : "yellow"}>{l.who === "user" ? "you " : l.who === "model" ? "aim " : " ⚙ "}</text>
              <text fg={l.who === "model" ? "white" : "gray"}>{l.text}</text>
              {l.meta !== undefined && <text fg="blue">({l.meta})</text>}
            </box>
          ))}
          {state.busy && <text fg="cyan">…</text>}
        </scrollbox>
        {/* sidebar */}
        <box width={34} flexDirection="column" border borderStyle="rounded" title=" optimizer ">
          <text fg="cyan" >RENDER {state.renderTokens}t</text>
          {/* Last context window: every rendered block as a top-level bullet,
              click to expand the blurb it contributed to the context string. */}
          <text fg="cyan">CONTEXT (last window)</text>
          <scrollbox flexGrow={1} flexDirection="column">
            {state.blocks.length === 0 && <text fg="gray">no turn rendered yet</text>}
            {state.blocks.map((b) => (
              <box key={b.digest} flexDirection="column">
                <box
                  flexDirection="row"
                  onMouseDown={() => { state.expandedBlock = state.expandedBlock === b.itemId ? null : b.itemId; notify(); }}
                >
                  <text fg="yellow">{state.expandedBlock === b.itemId ? "▾" : "▸"}</text>
                  <text fg="white">{b.itemId.slice(0, 16).padEnd(16)}</text>
                  <text fg="gray">{b.zone.slice(0, 7).padEnd(7)}</text>
                  <text fg="gray">{String(b.tokens).padStart(5)}t</text>
                </box>
                {state.expandedBlock === b.itemId && (
                  <box flexDirection="row" paddingLeft={2}>
                    <text fg="gray">{b.text.slice(0, 400)}</text>
                  </box>
                )}
              </box>
            ))}
          </scrollbox>
          <text>{" "}</text>
          <text fg="cyan" >CACHE</text>
          <box flexDirection="row">
            <text fg="gray">expected hit </text><text fg="green">{state.hitTokens}t</text>
          </box>
          <box flexDirection="row">
            <text fg="gray">divergence  </text><text fg={state.divergence === "none" ? "green" : "yellow"}>{state.divergence}</text>
          </box>
          <text>{" "}</text>
          <text fg="cyan" >GOALS</text>
          {state.goals.length === 0 && <text fg="gray">none</text>}
          {state.goals.map((g) => (
            <box key={g.id} flexDirection="row">
              <text fg={g.status === "completed" ? "green" : "yellow"}>{g.status === "completed" ? "✓" : "▸"}</text>
              <text fg="white">{g.text.slice(0, 28)}</text>
            </box>
          ))}
        </box>
      </box>
      {/* input */}
      <box height={5} border borderStyle="rounded" title=" message ">
        <input
          ref={inputRef}
          focused
          flexGrow={1}
          placeholder={state.busy ? "busy…" : "type a message; /help for commands"}
          onSubmit={(value: unknown) => {
            const v = typeof value === "string" ? value : inputRef.current?.value ?? "";
            void send(v).finally(() => {
              // Clear the box after the message is sent (user feedback #1).
              if (inputRef.current !== null) inputRef.current.value = "";
            });
          }}
        />
      </box>
    </box>
  );
}

function parseLocalIntent(line: string): SteeringIntent | null {
  const parts = line.split(/\s+/);
  const cmd = parts[0]!.slice(1);
  switch (cmd) {
    case "help": return { op: "ctx.inspect", filter: "all" };
    case "status": return { op: "ctx.inspect", filter: "rendered" };
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

// ── mount ────────────────────────────────────────────────────────────────
const renderer = await createCliRenderer();
createRoot(renderer).render(<App />);

// Graceful exit for the whole process: stop the renderer (restores the
// terminal), drain the ledger, then exit. Wired into App.quit().
export function shutdown(): void {
  try { renderer.stop(); } catch { /* already stopped */ }
  void ledger.drain().finally(() => process.exit(0));
  // Hard fallback if drain hangs
  setTimeout(() => process.exit(0), 2000).unref?.();
}
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());
