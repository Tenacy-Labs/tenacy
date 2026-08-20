/**
 * The Commons — shared kernel namespace with optimistic, versioned commits.
 *
 * RLM agents mutate the kernel itself (add/rename/refactor bindings). With
 * multiple agents interleaving turns across model-call gaps, the hazards are:
 *
 *   1. Lost updates: agent A plans against ns@v5; while A's model call is in
 *      flight, agent B commits ns@v6; A writes and silently clobbers B.
 *   2. Late ambient writes: promise callbacks mutating the namespace after
 *      their turn ended, interleaving arbitrarily with other agents' turns.
 *   3. Cross-worker divergence: replicated namespaces drifting apart.
 *
 * Discipline (jcode's stance mapped from files to bindings — "optimistic by
 * default, no locks; conflicts prompt the involved agents to communicate"):
 *
 *   - Single writer: all mutations apply inside commit(), on one thread
 *     (the coordinator's). Workers hold PRIVATE namespaces; only commits
 *     cross the boundary.
 *   - Turn-scoped mutation: reads carry a version; commits are batches with
 *     a base version; compare-and-swap at commit detects interleaving.
 *   - No write-after-return: async results arrive as data (interrupts/mail),
 *     never as ambient namespace writes.
 *   - Code-shift notifications: every reader of a binding is interrupted
 *     when that binding changes (jcode: "B edited a file A read -> notify A").
 */

export type WriteOp = { op: "set"; value: any } | { op: "delete" };

export interface Commit {
  agentId: string;
  baseVersion: number;
  writes: Record<string, WriteOp>;
}

export interface CommitReceipt {
  ok: boolean;
  version: number;
  conflicts?: string[];      // names changed since baseVersion (when !ok)
}

export interface NsChange {
  agentId: string;           // recipient (a reader of the binding)
  from: string;              // committing agent
  name: string;
  kind: "changed" | "deleted";
  atVersion: number;
}

/** Functions cross as source strings (same trick as kernel snapshots). */
function encode(v: any): any {
  if (typeof v === "function") return { __fn: v.toString() };
  return v;
}

export function revive(v: any): any {
  if (v && typeof v === "object" && typeof v.__fn === "string") {
    return new Function(`return (${v.__fn})`)();
  }
  return v;
}

export class Commons {
  private ns = new Map<string, any>();
  private lastChangedAt = new Map<string, number>();
  private readers = new Map<string, Set<string>>();
  private outbox: NsChange[] = [];
  version = 0;

  read(agentId: string, names: string[]): { values: Record<string, any>; version: number } {
    const values: Record<string, any> = {};
    for (const n of names) {
      values[n] = this.ns.has(n) ? encode(this.ns.get(n)) : undefined;
      let r = this.readers.get(n);
      if (!r) this.readers.set(n, (r = new Set()));
      r.add(agentId);
    }
    return { values, version: this.version };
  }

  /** Atomic batch commit. Renames = {newName: set, oldName: delete} in one batch. */
  commit(c: Commit): CommitReceipt {
    const names = Object.keys(c.writes);
    if (names.length === 0) return { ok: true, version: this.version };
    const conflicts = names.filter((n) => (this.lastChangedAt.get(n) ?? 0) > c.baseVersion);
    if (conflicts.length > 0) return { ok: false, version: this.version, conflicts };

    this.version += 1;   // one bump per commit: no intermediate state observable
    for (const [n, w] of Object.entries(c.writes)) {
      if (w.op === "delete") this.ns.delete(n);
      else this.ns.set(n, revive(w.value));
      this.lastChangedAt.set(n, this.version);
      for (const rid of this.readers.get(n) ?? []) {
        if (rid !== c.agentId) {
          this.outbox.push({
            agentId: rid, from: c.agentId, name: n,
            kind: w.op === "delete" ? "deleted" : "changed",
            atVersion: this.version,
          });
        }
      }
    }
    return { ok: true, version: this.version };
  }

  drainNotifications(): NsChange[] {
    const out = this.outbox;
    this.outbox = [];
    return out;
  }
}
