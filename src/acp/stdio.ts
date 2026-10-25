/** ACP v1, newline-delimited JSON-RPC over stdio. stdout is protocol-only. */
import { agent, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import { Writable } from "node:stream";
import { isAbsolute } from "node:path";
import { statSync } from "node:fs";
import { Session } from "./session.ts";

const sessions = new Map<string, Session>();
function session(id: string): Session {
  const value = sessions.get(id);
  if (!value) throw RequestError.invalidParams({ sessionId: id }, "Unknown session");
  return value;
}
const app = agent({ name: "tenacy" })
  .onRequest("initialize", () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: { name: "tenacy", version: "0.1.0" },
    agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false }, mcpCapabilities: { http: false, sse: false } },
    authMethods: [],
  }))
  .onRequest("session/new", ({ params }) => {
    if (params.mcpServers.length) throw RequestError.invalidParams(undefined, "MCP servers are not supported");
    try {
      if (!isAbsolute(params.cwd) || !statSync(params.cwd).isDirectory()) throw new Error();
    } catch { throw RequestError.invalidParams(undefined, "cwd must be an existing absolute directory"); }
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, new Session(params.cwd, process.argv[2] ?? "mock", process.argv[3]));
    return { sessionId };
  })
  .onRequest("session/prompt", async ({ params, client }) => {
    const target = session(params.sessionId);
    if (target.busy) throw RequestError.invalidRequest(undefined, "Session already has an active prompt");
    const parts = params.prompt.map((block) => {
      if (block.type !== "text") throw RequestError.invalidParams(undefined, "Only text prompts are supported");
      return block.text;
    });
    const reply = await target.prompt(parts.join("\n"));
    if (reply.text) await client.notify("session/update", {
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply.text } },
    });
    for (const tool of reply.tools) await client.notify("session/update", {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call", toolCallId: crypto.randomUUID(), title: tool.op,
        status: tool.ok ? "completed" : "failed",
        content: [{ type: "content", content: { type: "text", text: tool.result } }],
      },
    });
    return { stopReason: reply.stopReason };
  })
  .onNotification("session/cancel", ({ params }) => sessions.get(params.sessionId)?.cancel());

const connection = app.connect(ndJsonStream(
  Writable.toWeb(process.stdout), Bun.stdin.stream(),
));
try { await connection.closed; }
finally { await Promise.all([...sessions.values()].map((value) => value.close())); }
