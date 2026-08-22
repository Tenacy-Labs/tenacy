/**
 * rlm() child agents — roadmap item (docs/design.md): "typed handles and
 * usage attribution".
 *
 * A child is a full AgentLoop (own store, own turn counter) running under a
 * provider *wrapper* that attributes every model call to the child. The
 * supervisor is host-side (ops.* trust boundary): it holds providers and
 * credentials; children are handed behavior, never keys.
 *
 * Completion reports route to the parent exactly once (spawn edge = report
 * edge, mirroring swarm.ts), delivered as a NoticeItem the optimizer can
 * price and place — not an unpriced side-channel.
 */
import type { Provider, ModelResponse } from "./providers.ts";
import type { UsageReport } from "./cache-model.ts";
import type { Block } from "./types.ts";
import { AgentLoop, type TurnOutcome } from "./loop.ts";
import type { ParamSet } from "./params.ts";
import type { Ledger } from "./ledger.ts";
import { NoticeItem } from "./items.ts";

/** Usage attributed to one child, across all its model calls. */
export interface ChildUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  byTurn: number[];               // inputTokens per call, in order
}

function zeroUsage(): ChildUsage {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, byTurn: [] };
}

/**
 * Wraps any Provider so every call is attributed to a child id and rolled
 * into per-child + supervisor-wide usage. Transparent: same ModelResponse,
 * same modelId, plus attribution. Credentials remain with the wrapped
 * provider — host side only.
 */
export class AttributionProvider implements Provider {
  readonly modelId: string;
  constructor(
    private readonly inner: Provider,
    private readonly childId: string,
    private readonly onUsage: (childId: string, u: UsageReport) => void,
  ) {
    this.modelId = inner.modelId;
  }

  async call(blocks: Block[], userMessage: string): Promise<ModelResponse> {
    const res = await this.inner.call(blocks, userMessage);
    this.onUsage(this.childId, res.usage);
    return res;
  }
}

export type ChildStatus = "spawned" | "running" | "completed" | "failed" | "stopped";

/** Typed handle to a child agent. The model never holds raw loops. */
export interface ChildHandle {
  readonly id: string;
  readonly goal: string;
  status(): ChildStatus;
  /** Cumulative attributed usage for this child. */
  usage(): ChildUsage;
  /** Run one turn with the child's loop. Returns the outcome (attributed). */
  run(message: string): Promise<TurnOutcome>;
  /**
   * Completion report: the child's final answer text. Resolves when status
   * becomes completed/failed; routes a NoticeItem into the parent store
   * exactly once (idempotent — second call returns the cached report).
   */
  final(): Promise<string>;
  /** Stop the child: no further turns; final() resolves with the stop note. */
  stop(reason?: string): void;
}

export interface RLMSupervisorOptions {
  provider: Provider;
  ps: ParamSet;
  ledger?: Ledger | null;
  parent: AgentLoop;
  /** Max live children (default 8 — matches swarm liveWorkerBudget default). */
  maxChildren?: number;
  /** Max turns per child before forced completion (runaway guard). */
  maxTurnsPerChild?: number;
}

/**
 * The host-side supervisor. `ops.rlm_spawn` lands here (intents → ops).
 * Usage attribution tree: per-child ChildUsage + supervisor rollup the
 * parent model can inspect via ops.rlm_status.
 */
export class RLMSupervisor {
  readonly provider: Provider;
  readonly ps: ParamSet;
  readonly parent: AgentLoop;
  private readonly ledger: Ledger | null;
  private readonly children = new Map<string, ChildHandleInternal>();
  private readonly usage = new Map<string, ChildUsage>();
  private readonly reports = new Map<string, string>();
  private nextId = 0;
  private readonly maxChildren: number;
  private readonly maxTurnsPerChild: number;

  constructor(opts: RLMSupervisorOptions) {
    this.provider = opts.provider;
    this.ps = opts.ps;
    this.parent = opts.parent;
    this.ledger = opts.ledger ?? null;
    this.maxChildren = opts.maxChildren ?? 8;
    this.maxTurnsPerChild = opts.maxTurnsPerChild ?? 32;
  }

  /** Supervisor-wide usage rollup (all children, all calls). */
  totalUsage(): ChildUsage {
    const t = zeroUsage();
    for (const u of this.usage.values()) {
      t.calls += u.calls;
      t.inputTokens += u.inputTokens;
      t.outputTokens += u.outputTokens;
      t.cacheReadTokens += u.cacheReadTokens;
      t.cacheWriteTokens += u.cacheWriteTokens;
      t.byTurn.push(...u.byTurn);
    }
    return t;
  }

  usageOf(childId: string): ChildUsage {
    return this.usage.get(childId) ?? zeroUsage();
  }

  /** The typed handle for a live or terminal child (ops surface lookup). */
  handleOf(childId: string): ChildHandle | undefined {
    const c = this.children.get(childId);
    return c === undefined ? undefined : this.#handle(c);
  }

  /** Completion report text if the child has one (sync, non-blocking). */
  reportOf(childId: string): string | undefined {
    return this.reports.get(childId) ?? this.children.get(childId)?.stopReason;
  }

  list(): Array<{ id: string; goal: string; status: ChildStatus; usage: ChildUsage }> {
    return [...this.children.values()].map((c) => ({
      id: c.id, goal: c.goal, status: c.status, usage: this.usageOf(c.id),
    }));
  }

  spawn(goal: string, opts: { provider?: Provider } = {}): ChildHandle {
    if (this.children.size >= this.maxChildren) {
      throw new Error(`rlm_spawn: max children (${this.maxChildren}) reached`);
    }
    const id = `rlm-${++this.nextId}`;
    const provider = new AttributionProvider(opts.provider ?? this.provider, id, (cid, u) => {
      const cur = this.usage.get(cid) ?? zeroUsage();
      cur.calls += 1;
      cur.inputTokens += u.inputTokens;
      cur.outputTokens += u.outputTokens;
      cur.cacheReadTokens += u.cacheReadTokens ?? 0;
      cur.cacheWriteTokens += u.cacheWriteTokens ?? 0;
      cur.byTurn.push(u.inputTokens);
      this.usage.set(cid, cur);
    });
    const loop = new AgentLoop(provider, this.ps, this.ledger);
    const internal: ChildHandleInternal = {
      id, goal, loop, status: "spawned", turns: 0, stopReason: undefined,
      finalPromise: null, finalResolve: null, reported: false,
    };
    this.children.set(id, internal);
    this.usage.set(id, zeroUsage());
    this.ledger?.recordSignal({ type: "rlm-spawn", itemId: id, goal, turn: this.parent.store.turn });
    return this.#handle(internal);
  }

  #handle(c: ChildHandleInternal): ChildHandle {
    const self = this;
    return {
      id: c.id,
      goal: c.goal,
      status: () => c.status,
      usage: () => self.usageOf(c.id),
      async run(message: string): Promise<TurnOutcome> {
        if (c.status === "completed" || c.status === "failed" || c.status === "stopped") {
          throw new Error(`rlm ${c.id}: already ${c.status}`);
        }
        if (c.turns >= self.maxTurnsPerChild) {
          self.#complete(c, `turn cap (${self.maxTurnsPerChild}) reached`);
          throw new Error(`rlm ${c.id}: turn cap reached`);
        }
        c.status = "running";
        try {
          const out = await c.loop.run(message);
          c.turns += 1;
          if (c.turns >= self.maxTurnsPerChild) self.#complete(c, out.modelText);
          return out;
        } catch (e) {
          c.status = "failed";
          self.#resolveFinal(c, `failed: ${String(e)}`);
          throw e;
        }
      },
      final(): Promise<string> {
        return self.#finalOf(c);
      },
      stop(reason?: string): void {
        if (c.status === "completed" || c.status === "failed" || c.status === "stopped") return;
        c.stopReason = reason ?? "stopped by parent";
        c.status = "stopped";
        self.#resolveFinal(c, c.stopReason);
      },
    };
  }

  #finalOf(c: ChildHandleInternal): Promise<string> {
    if (c.finalPromise !== null) return c.finalPromise;
    c.finalPromise = new Promise<string>((resolve) => { c.finalResolve = resolve; });
    if (c.status === "completed" || c.status === "failed" || c.status === "stopped") {
      // Already terminal but never awaited: synthesize the report now.
      this.#resolveFinal(c, this.reports.get(c.id) ?? `[${c.status}] ${c.goal}`);
    }
    return c.finalPromise;
  }

  #complete(c: ChildHandleInternal, report: string): void {
    if (c.status === "completed" || c.status === "failed" || c.status === "stopped") return;
    c.status = "completed";
    this.reports.set(c.id, report);
    // Route the completion into the parent's store as a priced notice —
    // exactly once per child (idempotent guard), at the next turn boundary.
    if (!c.reported) {
      c.reported = true;
      this.parent.store.add(
        new NoticeItem(`rlm-report:${c.id}`, "notice", `rlm ${c.id} completed: ${report}`).toContextItem(),
      );
    }
    this.ledger?.recordSignal({ type: "rlm-complete", itemId: c.id, turn: this.parent.store.turn });
    this.#resolveFinal(c, report);
  }

  #resolveFinal(c: ChildHandleInternal, text: string): void {
    if (c.finalResolve !== null) {
      const r = c.finalResolve;
      c.finalResolve = null;
      r(text);
    } else if (c.finalPromise === null) {
      c.finalPromise = Promise.resolve(text);
    } else {
      // A promise exists but pending and resolve is null — impossible by
      // construction; guard anyway so final() can never hang.
      c.finalPromise = Promise.resolve(text);
    }
  }
}

interface ChildHandleInternal {
  id: string;
  goal: string;
  loop: AgentLoop;
  status: ChildStatus;
  turns: number;
  stopReason?: string | undefined;
  finalPromise: Promise<string> | null;
  finalResolve: ((s: string) => void) | null;
  reported: boolean;
}
