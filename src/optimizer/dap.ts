/**
 * DAP facade — ADR-0007 §4. A Debug Adapter Protocol server over the
 * agent's namespace: users attach their favorite debugger front-end (VS
 * Code, nvim-dap, Emacs dap-mode) to peruse the agent ns.
 *
 * Facade, never raw attach: this adapter exposes the CURATED namespace
 * (handles registry + ns lens), never the host runtime. Reads are
 * operator-privileged; writes ride the intent pipeline (setVariable ->
 * journaled intent), never raw memory writes.
 *
 * Protocol: DAP over stdio, JSON lines (Content-Length framing is the
 * front-end's job; bun test transport uses bare JSON lines).
 * v1 surface: initialize, launch/attach, threads, scopes, stackTrace,
 * variables, evaluate (= ctx.search, read-only), setVariable (= intent),
 * disconnect. Breakpoints/stepping are NOT exposed (turn is atomic).
 */
import type { HandleRegistry } from "./handles.ts";
import type { IntentSink } from "./handles.ts";

export interface DapOptions {
  registry: HandleRegistry;
  sink: IntentSink;              // setVariable routes here as intents
  nsChildren?: (prefix: string) => Array<{ name: string; kind: string; repr?: string }>;
}

interface DapRequest {
  seq: number;
  type: "request";
  command: string;
  arguments?: Record<string, unknown>;
}

type VarRef = number;

export class DapFacade {
  #opts: DapOptions;
  #nextVar = 1000;
  #vars = new Map<VarRef, { label: string; children?: () => Array<{ name: string; value: string; variablesReference: VarRef }> }>();

  constructor(opts: DapOptions) { this.#opts = opts; }

  /** Handle one JSON-lines request; return the JSON response line (or null). */
  handle(line: string): string | null {
    let req: DapRequest;
    try { req = JSON.parse(line) as DapRequest; } catch { return this.#err(req_seq_recover(line), "parse error"); }
    switch (req.command) {
      case "initialize":
        return this.#resp(req, { body: { capabilities: { supportsConfigurationDoneRequest: false, supportsSetVariable: true, supportsEvaluateForHovers: false } } });
      case "attach":
      case "launch":
        return this.#resp(req, {});
      case "threads":
        return this.#resp(req, { body: { threads: [{ id: 1, name: "agent" }] } });
      case "stackTrace":
        // The agent is always "stopped" at the last turn boundary.
        return this.#resp(req, { body: { stackFrames: [{ id: 1, name: "turn boundary", line: 1, column: 1 }], totalFrames: 1 } });
      case "scopes":
        return this.#resp(req, { body: { scopes: [
          { name: "Namespace", expensive: false, variablesReference: this.#nsRef() },
          { name: "Lenses", expensive: false, variablesReference: this.#lensesRef() },
        ] } });
      case "variables": {
        const ref = req.arguments?.variablesReference as number | undefined;
        const v = ref !== undefined ? this.#vars.get(ref) : undefined;
        if (v === undefined) return this.#err(req.seq, "unknown variablesReference");
        const children = v.children?.() ?? [];
        return this.#resp(req, { body: { variables: children } });
      }
      case "evaluate":
        // Read-only query surface (ctx.search class); never free eval.
        return this.#resp(req, { body: { result: "use ctx.search through the agent loop", variablesReference: 0 } });
      case "setVariable": {
        // Writes ride the intent pipeline (ADR-0007 §4 security posture).
        const r = this.#opts.sink({ op: "ctx.demote", id: String(req.arguments?.name ?? "") });
        return this.#resp(req, { body: { value: r.ok ? "intent queued" : r.result } });
      }
      case "disconnect":
        return this.#resp(req, {});
      default:
        return this.#resp(req, { success: false, message: `command not supported: ${req.command}` });
    }
  }

  #nsRef(): VarRef {
    const children = () => (this.#opts.nsChildren?.("") ?? []).map((n) => ({
      name: n.name, value: n.repr ?? n.kind,
      variablesReference: this.#leaf(),
    }));
    return this.#memo("ns", { label: "Namespace", children });
  }
  #lensesRef(): VarRef {
    const children = () => this.#opts.registry.entries().map((h) => ({
      name: h.id, value: h.substrate, variablesReference: this.#leaf(),
    }));
    return this.#memo("lenses", { label: "Lenses", children });
  }
  #leaf(): VarRef { return 0; }

  #memo(key: string, v: { label: string; children?: () => Array<{ name: string; value: string; variablesReference: VarRef }> }): VarRef {
    // stable refs across turns (identity stability, 0002d)
    if (!this.#vars.has(this.#keyRef(key))) {
      this.#vars.set(this.#keyRef(key), v);
    }
    return this.#keyRef(key);
  }
  #keyRef(key: string): VarRef {
    // small stable ids: ns=1001, lenses=1002 (allocated once)
    const ids: Record<string, VarRef> = { ns: 1001, lenses: 1002 };
    return ids[key] ?? 0;
  }

  #resp(req: DapRequest, extra: { body?: unknown; success?: boolean; message?: string }): string {
    return JSON.stringify({
      seq: req.seq, type: "response", request_seq: req.seq, success: extra.success ?? true,
      command: req.command, ...extra,
    });
  }
  #err(seq: number, msg: string): string {
    return JSON.stringify({ seq: -1, type: "response", request_seq: seq, success: false, command: "error", message: msg });
  }
}

function req_seq_recover(line: string): number {
  const m = /"seq"\s*:\s*(\d+)/.exec(line);
  return m === null ? -1 : Number(m[1]);
}
