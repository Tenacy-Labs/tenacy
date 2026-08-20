/**
 * Worker-side agent runtime: one Bun worker thread per agent session.
 * The worker holds a Kernel (persistent namespace) plus the swarm protocol:
 * a soft-interrupt inbox drained at safe points (start of turn), never mid-turn.
 *
 * Message shapes (mirrored in swarm.ts):
 *   Host -> worker:
 *     { __turn: { cell } }              run one cell (one "turn")
 *     { __interrupt: Envelope }         soft interrupt: queue, drain at safe point
 *     { __spawn_grant, id }             (deep mode) this worker may spawn children
 *     { __stop }                        graceful stop: snapshot, exit 0
 * { ... }
 *   Worker -> host:
 *     { kind: "ready" }
 *     { kind: "lifecycle", state, detail? }
 *     { kind: "final_response", body }  auto-forwarded to parent (completion report)
 *     { kind: "dm" | "subtree" | "channel", ... }
 */
import { parentPort } from "node:worker_threads";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Kernel } from "./kernel.ts";

const port = parentPort!;
const inbox: any[] = [];

// Per-agent kernel state dir: state/<agentId>/journal.jsonl + snapshot.json
const agentId = process.env.AGENT_ID ?? "unnamed";
const stateDir = process.env.STATE_DIR ?? "/tmp/agent-kernel-states";
const journal = `${stateDir}/${agentId}/journal.jsonl`;
const snap = `${stateDir}/${agentId}/snapshot.json`;
mkdirSync(dirname(journal), { recursive: true });   // worker owns its bootstrap
const k = new Kernel(journal, snap);

/** Envelope helper: send to coordinator (which routes). */
function send(env: any): void { port.postMessage(env); }

/** Drain queued interrupts at a safe point: between turns. Never mid-turn. */
function drainInbox(): void {
  while (inbox.length > 0) {
    const env = inbox.shift();
    handleEnvelope(env);
  }
}

function handleEnvelope(env: any): void {
  // Minimal agent semantics: expose envelopes as a `swarmMail` array in the
  // kernel namespace so agent code can see DMs/broadcasts it received.
  // NOTE: assignment must target globalThis — `var` inside this string would
  // be scoped to the eval'd function, not the kernel namespace.
  if (!env || typeof env !== "object") return;
  k.eval(`(function(){
    if (typeof swarmMail === "undefined") globalThis.swarmMail = [];
    swarmMail.push(${JSON.stringify(env)});
  })()`);
  if (env.kind === "lifecycle" && env.state === "stopped" && env.agentId === agentId) {
    // graceful stop signal delivered as interrupt
  }
}

port.on("message", (m: any) => {
  if (!m || typeof m !== "object") return;
  if (m.__interrupt) { inbox.push(m.__interrupt); return; }        // queue as soft interrupt
  if (m.__stop) {
    send({ kind: "lifecycle", state: "stopped", agentId, detail: "graceful" });
    process.exit(0);
  }
  if (m.__turn) {
    // A turn = drain interrupts first (safe point), then run the cell.
    drainInbox();
    send({ kind: "turn_start", agentId });
    const r = k.eval(m.__turn.cell);
    send({ kind: "turn_result", agentId, ok: r.ok, value: r.value, error: r.error });
  }
  if (m.__final) {
    // Produce the completion report: kernel has snapshotted every turn, so the
    // final response is just the last cell's namespace view. Host auto-forwards
    // to the parent (spawn edge = report-back edge).
    drainInbox();
    const summary = k.eval(m.__final.expr ?? "(typeof swarmMail !== 'undefined' ? swarmMail.length : 0)");
    send({ kind: "final_response", agentId, body: summary.value });
  }
});
send({ kind: "ready" });
