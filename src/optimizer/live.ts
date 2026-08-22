/**
 * Live-wire intent protocol — parsing model-proposed intents from text.
 *
 * A live model emits prose, not structured envelopes. Protocol: the model
 * may append a fenced block whose lines are JSON intent objects; the
 * coordinator strips the block from the visible reply and applies the
 * intents (proposer/applier split — the model proposes, the loop applies
 * and journals failures as error evidence, A1 0004 §2).
 *
 *   ```intents
 *   {"op": "files.expand", "target": "notes.txt", "from": 1, "to": 60}
 *   {"op": "goals.set", "id": "g1", "text": "verify the code"}
 *   ```
 */
import type { SteeringIntent } from "./intents.ts";

const FENCE = "```intents";

export function parseIntentsFromText(text: string): { text: string; intents: SteeringIntent[] } {
  const start = text.indexOf(FENCE);
  if (start === -1) return { text, intents: [] };
  const afterOpen = text.indexOf("\n", start);
  if (afterOpen === -1) return { text, intents: [] };
  const close = text.indexOf("```", afterOpen);
  const body = close === -1 ? text.slice(afterOpen + 1) : text.slice(afterOpen + 1, close);
  const tail = close === -1 ? "" : text.slice(close + 3);
  const cleanedBody = body.trim();
  const head = text.slice(0, start).trimEnd();
  const tailClean = tail.trim();

  const intents: SteeringIntent[] = [];
  for (const line of cleanedBody.split("\n")) {
    const t = line.trim();
    if (t === "" || t.startsWith("//")) continue;
    try {
      const obj = JSON.parse(t) as SteeringIntent;
      if (typeof obj === "object" && obj !== null && typeof (obj as { op?: unknown }).op === "string") {
        intents.push(obj);
      }
    } catch {
      // Malformed line: skip honestly — the loop never fabricates intents.
    }
  }
  const visible = (head + (tailClean !== "" ? "\n" + tailClean : "")).trim();
  return { text: visible, intents };
}


import type { Provider } from "./providers.ts";

/** Wrap any provider so live-model ```intents fences become structured intents. */
export function withIntentParsing(modelId: string, inner: Provider): Provider {
  return {
    modelId,
    call: async (blocks, userMessage) => {
      const r = await inner.call(blocks, userMessage);
      const { text, intents } = parseIntentsFromText(r.text);
      return { ...r, text, intents };
    },
  };
}

/** The protocol description given to live models so they know the affordance. */
export const INTENT_PROTOCOL_DOC = [
  "You can operate your context by appending a fenced block to your reply:",
  "```intents",
  '{"op": "files.expand", "target": "<file>", "from": 1, "to": 60}   // pull a line range into context',
  '{"op": "files.release", "target": "<file>", "from": 1, "to": 60} // drop a range',
  '{"op": "dirs.expand", "target": "<dir>", "from": 1, "to": 40}   // pull entry lines of a directory listing into context',
  '{"op": "dirs.release", "target": "<dir>", "from": 1, "to": 40}  // drop a range of directory entries',
  '{"op": "code.expand", "target": "<file>", "symbols": ["solve", "render"]} // anchor symbol source ranges (line-shift-proof)',
  '{"op": "code.release", "target": "<file>", "symbols": ["solve"]}     // drop anchored symbols',
  '{"op": "code.structure", "target": "<file>"}                          // list symbols: name kind lines',
  '{"op": "ns.focus", "target": "<ns>", "prefix": "mcp", "projection": "structure"} // focus kernel namespace subtree',
  '{"op": "ns.unfocus", "target": "<ns>", "prefix": "mcp"}               // drop a namespace scope',
  '{"op": "convo.merge", "from": 3, "to": 6}                             // merge contiguous old turns into one summary group',
  '{"op": "convo.reexpand", "id": "turn-4-user"}                         // restore verbatim (journals realized lossiness)',
  '{"op": "goals.decompose", "id": "g1", "sub": [{"id": "g1a", "text": "step"}]} // split a goal into subgoals',
  '{"op": "goals.set", "id": "<id>", "text": "<goal>"}              // declare a goal',
  '{"op": "goals.update", "id": "<id>", "status": "completed"}      // close a goal',
  '{"op": "ctx.search", "pattern": "<regex>"}                       // search context',
  "```",
  "Keep your answer outside the block. Emit at most one block per reply.",
].join("\n");
