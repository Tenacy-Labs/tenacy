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
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { Kernel } from "./kernel.ts";

const port = parentPort!;

// Crash containment, deterministic (2026-08-29). Bun 1.2.5 workers make
// process.exit ASYNCHRONOUS — the call returns, the worker dies later — so a
// cell ending in process.exit raced: its turn_result(ok) beat the exit event
// and the crash surfaced only as a lifecycle flip. Intercept the call at the
// worker boundary: record the intent, throw to unwind the cell, report the
// turn as a crash, then exit for real (realExit's own deferral is harmless —
// nothing executable follows). A cell that catches the throw still gets the
// crash verdict: the request, once made, is irrevocable.
const realExit = process.exit.bind(process);
let cellExitCode: number | null = null;
process.exit = ((code?: number) => {
  cellExitCode = code ?? 0;
  throw new Error(`process.exit(${code ?? 0}) — cell requested worker death`);
}) as typeof process.exit;
const inbox: any[] = [];

// Per-agent kernel state dir: state/<agentId>/journal.jsonl + snapshot.json
const agentId = process.env.AGENT_ID ?? "unnamed";
const stateDir = process.env.STATE_DIR ?? "/tmp/agent-kernel-states";
const journal = `${stateDir}/${agentId}/journal.jsonl`;
const snap = `${stateDir}/${agentId}/snapshot.json`;
mkdirSync(dirname(journal), { recursive: true });   // worker owns its bootstrap
// Hibernation contract: if a prior incarnation snapshotted state here, the
// snapshot (never the journal — no replay) revives the namespace. Fresh
// agents boot empty as before. Either way the worker stays compiler-free:
// the coordinator checked and transpiled every cell it will receive.
let k: Kernel;
let recovered = 0;
let tombstoned = 0;
if (existsSync(snap)) {
  const r = Kernel.recover(journal, snap, false);
  k = r.k;
  recovered = r.seeded;
  tombstoned = r.tombstoned;
} else {
  k = new Kernel(journal, snap, [], false);
}

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
  k.evalCompiled("swarm-mail", `(function(){
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
    // Graceful stop = hibernation entry: state is already snapshotted every
    // turn; exiting here leaves a revivable snapshot on disk.
    send({ kind: "lifecycle", state: "stopped", agentId, detail: "graceful" });
    realExit(0);
  }
  if (m.__turn) {
    // A turn = drain interrupts first (safe point), then run the cell.
    drainInbox();
    send({ kind: "turn_start", agentId });
    // Coordinator-gated turn: JS was type-checked + transpiled on the main thread.
    const r = k.evalCompiled(m.__turn.src ?? "", m.__turn.js);
    if (cellExitCode !== null) {
      const code = cellExitCode;
      cellExitCode = null;
      send({ kind: "turn_result", agentId, ok: false, phase: "crash", error: `cell called process.exit(${code})` });
      realExit(code);
      return;
    }
    send({ kind: "turn_result", agentId, ok: r.ok, value: r.value, error: r.error });
  }
  if (m.__final) {
    // Produce the completion report: kernel has snapshotted every turn, so the
    // final response is just the last cell's namespace view. Host auto-forwards
    // to the parent (spawn edge = report-back edge).
    drainInbox();
    // Internal runtime helpers are plain JavaScript, pre-vetted by the host.
    const summary = k.evalCompiled(m.__final.src ?? "final-expr", m.__final.js ?? "(typeof swarmMail !== 'undefined' ? swarmMail.length : 0)");
    send({ kind: "final_response", agentId, body: summary.value });
  }
});
send({ kind: "ready" });
