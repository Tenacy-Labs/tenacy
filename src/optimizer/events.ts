/**
 * Kernel event vocabulary — ADR-0007 substrate. The typed seams the loop
 * emits at (ADR-0001: steering drain, turn boundary, model call, render).
 *
 * Every event carries the turn it belongs to. Consumers (OTel exporter,
 * ACP/OpenCode adapters, DAP facade) subscribe by kind via the bus.
 *
 * Naming: kind strings are STABLE PUBLIC API — front-ends and exporters
 * key on them. Renames are ADR-worthy (namespace-curation discipline).
 */
export type PluginEvent =
  | { kind: "turn.started"; turn: number }
  | { kind: "turn.completed"; turn: number; tokensIn: number; tokensOut: number }
  | { kind: "steering.executed"; turn: number; op: string; ok: boolean; result: string }
  | { kind: "model.called"; turn: number; provider: string; model: string; inputTokens: number; outputTokens: number; latencyMs: number }
  | { kind: "render.decided"; turn: number; itemsRendered: number; lambda: number }
  | { kind: "lens.delta"; turn: number; lensId: string; changedLines: number[] }
  /** M4: emitted by the §2e write seam after a committed file mutation. */
  | { kind: "solver.ran"; turn: number; chosen: number; candidates: number; mode: "native" | "soa" | "ref" }
  | { kind: "error.thrown"; turn: number; where: string; message: string };

/** Events a plugin may emit back (inbound surface, grant-scoped).
 *  steer.request lands in the loop interrupt queue via ctx.submitSteering;
 *  the bus carries kernel-outward events only (one direction, one truth). */
export type PluginEmitted =
  | { kind: "steer.request"; text: string; note: string };

/** Discriminated-union guard used by the DAP facade and tests. */
export function isPluginEmitted(v: unknown): v is PluginEmitted {
  return typeof v === "object" && v !== null && "kind" in v && (v as { kind: string }).kind === "steer.request";
}
