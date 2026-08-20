/**
 * Swarm layer for agent-kernel: jcode's swarm primitives mapped to Bun worker threads.
 *
 * jcode model (docs/SWARM_ARCHITECTURE.md) -> agent-kernel mapping:
 *
 *   Server (single-process coordinator)     -> main-thread Swarm (this file)
 *   Session = process (heavy, reconnect)    -> Agent = Worker (cheap, ~6-7MB)
 *   report_back_to_session_id (ancestry)    -> AgentRecord.parentId (spawn edge)
 *   DMs / channels / subtree broadcast      -> typed Envelope routing over parentPort
 *   Notifications as soft interrupts        -> queued in worker inbox; drained at
 *                                              safe points (start of next cell/turn),
 *                                              never mid-turn
 *   Coordinator (root-only plan slot)       -> single VersionedPlan per swarm,
 *                                              root-gated mutations
 *   Lifecycle states (jcode names)          -> AgentState machine, same semantics
 *   Mode-gated spawning (light vs deep)     -> spawn mode; deep bounded by
 *                                              liveWorkerBudget + memberCap
 *   Crashed agent                           -> worker exit/error -> state machine;
 *                                              recovery via kernel snapshot invariants
 *
 * Sizing (docs/benchmarks.md): worker spawn + state load ~11.7ms, marginal RSS
 * ~6-7MB, dispatch 54µs median — vs jcode's ~10MB/session, ~117MB/10 sessions.
 */
import { Worker } from "node:worker_threads";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type AgentState =
  | "spawned"    // session created, not yet ready
  | "ready"      // plan + scope received, waiting for work
  | "running"    // executing a task or tool
  | "blocked"    // dependency, conflict, or missing info
  | "completed"  // scope done, awaiting new assignment
  | "failed"     // unrecoverable error, needs coordinator decision
  | "stopped"    // intentionally shut down
  | "crashed";   // unexpected exit

export interface PlanTask {
  id: string;
  title: string;
  deps: string[];                                              // DAG edges
  owner?: string;                                              // agent id
  status: "queued" | "running" | "blocked" | "done" | "failed";
  scope?: string;                                              // worktree-equivalent grouping key
}

export interface VersionedPlan { version: number; tasks: PlanTask[] }

export type Envelope =
  | { kind: "dm"; from: string; to: string; body: any }
  | { kind: "subtree"; from: string; body: any }               // sender's spawned subtree only
  | { kind: "broadcast"; from: string; body: any }             // whole swarm (root escape hatch)
  | { kind: "channel"; from: string; channel: string; body: any }
  | { kind: "lifecycle"; state: AgentState; agentId: string; detail?: string }
  | { kind: "plan_update"; plan: VersionedPlan };

export interface AgentRecord {
  id: string;
  parentId: string | null;      // spawn edge = report-back edge
  state: AgentState;
  worker: Worker | null;
  spawnMode: "light" | "deep";
  spawnedAt: number;
}

export interface SwarmOptions {
  memberCap?: number;           // absolute cap on live members
  liveWorkerBudget?: number;    // concurrent running workers (deep mode)
  stateDir?: string;            // per-agent kernel journal/snapshot dirs
}

/**
 * The coordinator. Runs on the main thread; owns routing, the plan, lifecycle.
 * Deliberately does NOT integrate or merge work (jcode: integration belongs to
 * worktree managers, not the coordinator).
 */
export class Swarm {
  agents = new Map<string, AgentRecord>();
  plan: VersionedPlan | null = null;
  private channels = new Map<string, Set<string>>();   // channel name -> member ids
  private nextId = 0;
  private opts: Required<Pick<SwarmOptions, "memberCap" | "liveWorkerBudget">> & SwarmOptions;

  constructor(opts: SwarmOptions = {}) {
    this.opts = {
      memberCap: opts.memberCap ?? 16,
      liveWorkerBudget: opts.liveWorkerBudget ?? 8,
      stateDir: opts.stateDir,
    };
  }

  /** Ancestry: walk parentId chain from `id` upward. Includes self. */
  ancestry(id: string): string[] {
    const chain: string[] = [];
    let cur: string | null = id;
    while (cur) { chain.push(cur); cur = this.agents.get(cur)?.parentId ?? null; }
    return chain;
  }

  /** Descendants of `id` (its spawned subtree), depth-first. Excludes self. */
  subtree(id: string): string[] {
    const out: string[] = [];
    const walk = (pid: string) => {
      for (const [cid, rec] of this.agents) {
        if (rec.parentId === pid) { out.push(cid); walk(cid); }
      }
    };
    walk(id);
    return out;
  }

  private liveCount(): number {
    let n = 0;
    for (const r of this.agents.values()) {
      if (r.state !== "stopped" && r.state !== "crashed" && r.state !== "failed") n++;
    }
    return n;
  }

  /**
   * Spawn an agent. Mode-gated like jcode: in "light" swarms only the root may
   * spawn; in "deep" mode descendants may spawn too, subject to caps. The spawn
   * edge is the report-back edge: the child's final response is forwarded to
   * its parent as the completion report.
   */
  spawn(parentId: string | null, opts: { workerPath?: string; spawnMode?: "light" | "deep"; prompt?: string } = {}): AgentRecord {
    const parent = parentId ? this.agents.get(parentId) : undefined;
    if (parentId && !parent) throw new Error(`spawn: unknown parent ${parentId}`);

    // Mode gate: light swarms are one-level fan-out — only the root may spawn.
    if (parent && (parent.spawnMode === "light" || this.rootMode() === "light")) {
      // A child of a child may not exist in light mode.
      if (parent.parentId !== null) throw new Error("spawn: light swarms allow only root-level spawning");
    }
    if (this.liveCount() >= this.opts.memberCap) throw new Error(`spawn: member cap ${this.opts.memberCap} reached`);

    const id = `agent-${++this.nextId}`;
    const spawnMode = opts.spawnMode ?? (parentId === null ? "deep" : parent!.spawnMode ?? "light");
    const rec: AgentRecord = { id, parentId, state: "spawned", worker: null, spawnMode, spawnedAt: Date.now() };
    this.agents.set(id, rec);

    if (opts.workerPath) {
      this.attachWorker(id, opts.workerPath);
    }
    return rec;
  }

  private rootMode(): "light" | "deep" {
    const root = [...this.agents.values()].find((r) => r.parentId === null);
    return root?.spawnMode ?? "light";
  }

  /** Attach a worker to an existing agent record (the session "process"). */
  attachWorker(id: string, workerPath: string): void {
    const rec = this.agents.get(id);
    if (!rec) throw new Error(`attachWorker: unknown agent ${id}`);
    const w = new Worker(workerPath, {
      env: { ...process.env, AGENT_ID: id, STATE_DIR: this.opts.stateDir ?? "/tmp/agent-kernel-states" },
    });
    rec.worker = w;
    w.on("message", (m: any) => this.#onWorkerMessage(id, m));
    w.on("error", (e: any) => this.#setLife(id, "crashed", String(e)));
    w.on("exit", (code: number) => {
      if (code !== 0 && rec.state !== "stopped") this.#setLife(id, "crashed", `exit ${code}`);
    });
  }

  #onWorkerMessage(id: string, m: any): void {
    const rec = this.agents.get(id);
    if (!rec) return;
    if (m && m.kind === "ready") { this.#setLife(id, "ready"); return; }
    if (m && m.kind === "turn_start") { this.#setLife(id, "running"); return; }
    if (m && m.kind === "turn_result") { this.#setLife(id, "ready"); return; }
    if (m && m.kind === "completion_report") {
      // Completion policy: final response auto-forwards to the owning parent.
      const pid = rec.parentId;
      this.#setLife(id, "completed");
      if (pid) this.route({ kind: "dm", from: id, to: pid, body: m.body });
      return;
    }
    if (m && m.kind === "final_response") {
      const pid = rec.parentId;
      this.#setLife(id, "completed");
      if (pid) this.route({ kind: "dm", from: id, to: pid, body: m.body });
      return;
    }
    if (m && m.kind === "dm" && typeof m.to === "string") { this.route(m); return; }
    if (m && m.kind === "subtree") { this.route({ ...m, from: id }); return; }
    if (m && m.kind === "channel") { this.route({ ...m, from: id }); return; }
  }

  #setLife(id: string, state: AgentState, detail?: string): void {
    const rec = this.agents.get(id);
    if (!rec) return;
    rec.state = state;
    // Lifecycle events are notifications too (jcode: everything is a notification).
    this.notifyLifecycleObservers(id, state, detail);
  }

  /** Observers for lifecycle events (UI/widget/audit hooks). */
  lifecycleObservers: ((agentId: string, state: AgentState, detail?: string) => void)[] = [];
  private notifyLifecycleObservers(id: string, state: AgentState, detail?: string): void {
    for (const cb of this.lifecycleObservers) cb(id, state, detail);
  }

  /**
   * Route an envelope. DMs and broadcasts are delivered to target agents'
   * workers as soft interrupts — the worker queues them in its inbox and
   * drains at a safe point (start of next turn), never mid-turn.
   */
  route(env: Envelope): void {
    switch (env.kind) {
      case "dm": {
        const target = this.agents.get(env.to);
        if (!target) return; // dropped: unknown recipient (audit hook could log)
        this.#deliver(env.to, env);
        return;
      }
      case "subtree": {
        for (const cid of this.subtree(env.from)) this.#deliver(cid, env);
        return;
      }
      case "broadcast": {
        for (const id of this.agents.keys()) this.#deliver(id, env);
        return;
      }
      case "channel": {
        const members = this.channels.get(env.channel);
        if (!members) return;
        for (const id of members) this.#deliver(id, env);
        return;
      }
      case "lifecycle": {
        this.#deliver(env.agentId, env);
        return;
      }
      case "plan_update": {
        // Plan mutations are root-gated (jcode: one VersionedPlan per swarm).
        this.plan = env.plan;
        for (const id of this.agents.keys()) this.#deliver(id, env);
        return;
      }
    }
  }

  #deliver(id: string, env: Envelope): void {
    const rec = this.agents.get(id);
    if (!rec?.worker) return;
    rec.worker.postMessage({ __interrupt: env });   // soft interrupt envelope
  }

  /** Coordinator (root) sets the plan; participants receive it as notifications. */
  setPlan(rootId: string, plan: VersionedPlan): void {
    const root = this.agents.get(rootId);
    if (!root || root.parentId !== null) throw new Error("setPlan: only the root session may hold the plan slot");
    this.plan = plan;
    this.route({ kind: "plan_update", plan });
  }

  /** An agent proposes a plan update; only root approval commits it. */
  proposePlan(fromId: string, plan: VersionedPlan): void {
    const root = [...this.agents.values()].find((r) => r.parentId === null);
    if (!root) return;
    this.#deliver(root.id, { kind: "dm", from: fromId, to: root.id, body: { proposal: plan } });
  }

  join(agentId: string, channel: string): void {
    if (!this.channels.has(channel)) this.channels.set(channel, new Set());
    this.channels.get(channel)!.add(agentId);
  }

  /** Stop an agent. jcode rule: own subtree always; others require force. */
  stop(requesterId: string, targetId: string, force = false): void {
    if (requesterId !== targetId && !this.subtree(requesterId).includes(targetId) && !force) {
      throw new Error(`stop: ${targetId} outside ${requesterId}'s subtree; force=true required`);
    }
    const rec = this.agents.get(targetId);
    if (!rec) return;
    if (rec.worker) void rec.worker.terminate();
    this.#setLife(targetId, "stopped");
    // Reparent orphaned children (jcode: reparent, never orphan).
    for (const [cid, crec] of this.agents) {
      if (crec.parentId === targetId) {
        crec.parentId = rec.parentId;   // attach to live grandparent (root fallback below)
      }
    }
    const root = [...this.agents.values()].find((r) => r.parentId === null);
    for (const [cid, crec] of this.agents) {
      if (crec.parentId && !this.agents.has(crec.parentId)) crec.parentId = root ? root.id : null;
    }
  }
}
