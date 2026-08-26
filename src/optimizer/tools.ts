/**
 * Native tool-calling surface — the model's intent affordance (2026-08-26
 * ruling: the ```intents fenced-block protocol is RETIRED; native tool
 * calls via the AI SDK are the only intent path for live models).
 *
 * Each SteeringIntent op becomes an SDK tool. Tools carry NO execute —
 * the model proposes, the coordinator applies (proposer/applier split is
 * unchanged); stopWhen: stepCountIs(1) in the wire keeps the SDK from
 * looping. Tool names use underscores (provider name charset); ops use
 * dots; the mapping is bijective (no op contains an underscore).
 */
import { tool, jsonSchema } from "ai";
import type { ToolSet } from "ai";
import type { SteeringIntent } from "./intents.ts";

export const opToToolName = (op: string): string => op.replace(/\./g, "_");
export const toolNameToOp = (name: string): string => name.replace(/_/g, ".");

type FieldT = "s" | "n" | "s[]" | "patch" | "subgoals" | "freeobj" | { e: readonly string[] };

const fieldSchema = (f: FieldT): Record<string, unknown> => {
  if (typeof f === "object") return { type: "string", enum: [...f.e] };
  switch (f) {
    case "s": return { type: "string" };
    case "n": return { type: "number" };
    case "s[]": return { type: "array", items: { type: "string" } };
    case "patch": return { type: "array", items: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"], additionalProperties: false } };
    case "subgoals": return { type: "array", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } }, required: ["id", "text"], additionalProperties: false } };
    case "freeobj": return { type: "object" };
  }
};

interface ToolSpec { op: string; desc: string; req: string[]; opt?: string[]; fields: Record<string, FieldT> }

const SPECS: ToolSpec[] = [
  { op: "say", desc: "Speak a distilled statement into the conversation record", req: ["text"], fields: { text: "s" } },
  { op: "files.expand", desc: "Pull a file line range into context", req: ["target", "from", "to"], fields: { target: "s", from: "n", to: "n" } },
  { op: "files.release", desc: "Drop a file line range from context", req: ["target", "from", "to"], fields: { target: "s", from: "n", to: "n" } },
  { op: "files.patch", desc: "Apply string replacements to a file", req: ["target", "patch"], fields: { target: "s", patch: "patch" } },
  { op: "files.replace", desc: "Replace a substring in a file", req: ["target", "from", "to"], fields: { target: "s", from: "s", to: "s" } },
  { op: "files.append", desc: "Append text to a file", req: ["target", "text"], fields: { target: "s", text: "s" } },
  { op: "goals.set", desc: "Declare a goal", req: ["id", "text"], opt: ["horizon"], fields: { id: "s", text: "s", horizon: { e: ["session", "task", "standing"] } } },
  { op: "goals.update", desc: "Update or close a goal", req: ["id"], opt: ["text", "status"], fields: { id: "s", text: "s", status: { e: ["active", "completed"] } } },
  { op: "goals.decompose", desc: "Split a goal into subgoals", req: ["id", "sub"], fields: { id: "s", sub: "subgoals" } },
  { op: "ctx.inspect", desc: "Inspect context store contents", req: [], opt: ["filter"], fields: { filter: { e: ["rendered", "invisible", "all"] } } },
  { op: "ctx.item", desc: "Read one context item", req: ["id"], fields: { id: "s" } },
  { op: "ctx.why", desc: "Decision-ledger trace for an item", req: ["id"], fields: { id: "s" } },
  { op: "ctx.promote", desc: "Bump an item's value", req: ["id"], fields: { id: "s" } },
  { op: "ctx.demote", desc: "Lower an item's value", req: ["id"], fields: { id: "s" } },
  { op: "ctx.watch", desc: "Set live/polled/frozen watch mode", req: ["id", "mode"], fields: { id: "s", mode: { e: ["live", "polled", "frozen"] } } },
  { op: "ctx.search", desc: "Search context with a regex", req: ["pattern"], fields: { pattern: "s" } },
  { op: "ctx.reexpand", desc: "Restore a lossy representation to verbatim", req: ["id"], fields: { id: "s" } },
  { op: "err.resolve", desc: "Mark a sticky error as resolved", req: ["id"], fields: { id: "s" } },
  { op: "dirs.expand", desc: "Pull directory entry lines into context", req: ["target", "from", "to"], fields: { target: "s", from: "n", to: "n" } },
  { op: "dirs.release", desc: "Drop directory entry lines", req: ["target", "from", "to"], fields: { target: "s", from: "n", to: "n" } },
  { op: "code.expand", desc: "Anchor symbol source ranges (line-shift-proof)", req: ["target", "symbols"], fields: { target: "s", symbols: "s[]" } },
  { op: "code.release", desc: "Drop anchored symbols", req: ["target", "symbols"], fields: { target: "s", symbols: "s[]" } },
  { op: "code.structure", desc: "List symbols: name kind lines", req: ["target"], fields: { target: "s" } },
  { op: "ns.focus", desc: "Focus kernel namespace subtree", req: ["target", "prefix"], opt: ["projection"], fields: { target: "s", prefix: "s", projection: { e: ["structure", "content"] } } },
  { op: "ns.unfocus", desc: "Drop a namespace scope", req: ["target", "prefix"], fields: { target: "s", prefix: "s" } },
  { op: "convo.merge", desc: "Merge contiguous old turns into one summary group", req: ["from", "to"], fields: { from: "n", to: "n" } },
  { op: "convo.reexpand", desc: "Restore a merged/summarized turn to verbatim", req: ["id"], fields: { id: "s" } },
  { op: "rlm.spawn", desc: "Spawn a child agent for a goal", req: ["goal"], fields: { goal: "s" } },
  { op: "rlm.turn", desc: "Send a message to a child agent", req: ["id", "message"], fields: { id: "s", message: "s" } },
  { op: "rlm.stop", desc: "Stop a child agent", req: ["id"], opt: ["reason"], fields: { id: "s", reason: "s" } },
  { op: "rlm.status", desc: "Report child-agent status", req: [], opt: ["id"], fields: { id: "s" } },
  { op: "rlm.final", desc: "Accept a child agent's final report", req: ["id"], fields: { id: "s" } },
  { op: "memory.remember", desc: "Store a semantic memory", req: ["text"], opt: ["kind", "meta"], fields: { text: "s", kind: "s", meta: "freeobj" } },
  { op: "memory.search", desc: "Search semantic memory", req: ["query"], opt: ["limit", "kind"], fields: { query: "s", limit: "n", kind: "s" } },
];

const KNOWN_OPS = new Set(SPECS.map((s) => s.op));

/** Build the SDK ToolSet for all intent ops. Tools carry no execute. */
export function intentTools(): ToolSet {
  const out: ToolSet = {};
  for (const t of SPECS) {
    const properties: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(t.fields)) properties[k] = fieldSchema(v);
    out[opToToolName(t.op)] = tool({
      description: t.desc,
      inputSchema: jsonSchema({ type: "object", properties, required: t.req, additionalProperties: false }),
    });
  }
  return out;
}

/** Normalized SDK tool calls → SteeringIntents. Unknown names are dropped
 *  honestly — the coordinator never fabricates intents. */
export function intentsFromToolCalls(calls: ReadonlyArray<{ toolName: string; input: unknown }>): SteeringIntent[] {
  const intents: SteeringIntent[] = [];
  for (const c of calls) {
    const op = toolNameToOp(c.toolName);
    if (!KNOWN_OPS.has(op)) continue;
    if (typeof c.input !== "object" || c.input === null) continue;
    intents.push({ op, ...(c.input as Record<string, unknown>)} as SteeringIntent);
  }
  return intents;
}

/** Identity doc describing the affordance to live models. */
export const TOOL_PROTOCOL_DOC =
  "You operate your context through the provided tools (files_expand, files_release, ctx_search, convo_merge, goals_set, …): call them to expand, release, search, or restructure what you see. The coordinator executes your calls after your reply and their receipts appear in your context next turn. IMPORTANT: always write your full answer as plain text in the same reply — the tools only change future context; a reply containing nothing but tool calls is not an answer.";
