/**
 * Steering intents — the files / ctx / goals tool surface, executed at the
 * coordinator (proposer/applier split — 0002g, K7). Mutations are store-level
 * signals; the solver stays single writer of render (signals not overrides).
 */
import type { ContextStore } from "./store.ts";
import type { Ledger } from "./ledger.ts";
import { GoalItem, FileLensItem } from "./items.ts";

export type SteeringIntent =
  | { op: "say"; text: string }
  | { op: "files.expand"; target: string; from: number; to: number }
  | { op: "files.release"; target: string; from: number; to: number }
  | { op: "goals.set"; id: string; text: string; horizon?: "session" | "task" | "standing" }
  | { op: "goals.update"; id: string; text?: string; status?: "active" | "completed" }
  | { op: "ctx.inspect"; filter?: "rendered" | "invisible" | "all" }
  | { op: "ctx.item"; id: string }
  | { op: "ctx.why"; id: string }
  | { op: "ctx.promote"; id: string }
  | { op: "ctx.demote"; id: string }
  | { op: "ctx.watch"; id: string; mode: "live" | "polled" | "frozen" }
  | { op: "ctx.search"; pattern: string };

export type IntentResult = { op: string; ok: boolean; result: string };

// Module-level registries wired by the loop (single-writer coordinator side).
export interface IntentHost {
  fileLens(target: string): FileLensItem;
  goal(id: string): GoalItem | undefined;
  setGoal(g: GoalItem): void;
}
let host: IntentHost | null = null;
export function bindHost(h: IntentHost): void { host = h; }

export function executeIntent(s: SteeringIntent, store: ContextStore, ledger: Ledger | null): IntentResult {
  const turn = store.turn;
  switch (s.op) {
    case "say":
      return { op: s.op, ok: true, result: s.text };
    case "files.expand": {
      if (host === null) return { op: s.op, ok: false, result: "no host bound" };
      const lens = host.fileLens(s.target);
      lens.expand(s.from, s.to);
      store.touch(lens.id);
      ledger?.recordSignal({ type: "files-expand", itemId: lens.id, from: s.from, to: s.to, turn });
      return { op: s.op, ok: true, result: `loaded ${s.target}:${s.from}-${s.to} → ${lens.ranges.length} coalesced range(s)` };
    }
    case "files.release": {
      if (host === null) return { op: s.op, ok: false, result: "no host bound" };
      const lens = host.fileLens(s.target);
      lens.release(s.from, s.to);
      store.touch(lens.id);
      ledger?.recordSignal({ type: "files-release", itemId: lens.id, from: s.from, to: s.to, turn });
      return { op: s.op, ok: true, result: `released ${s.target}:${s.from}-${s.to} (${lens.ranges.length} remain)` };
    }
    case "goals.set": {
      if (host === null) return { op: s.op, ok: false, result: "no host bound" };
      const g = new GoalItem(s.id, s.text, undefined, s.horizon ?? "task");
      host.setGoal(g);
      ledger?.recordSignal({ type: "goals-set", itemId: s.id, turn });
      return { op: s.op, ok: true, result: `goal ${s.id}: ${s.text}` };
    }
    case "goals.update": {
      if (host === null) return { op: s.op, ok: false, result: "no host bound" };
      const g = host.goal(s.id);
      if (g === undefined) return { op: s.op, ok: false, result: `no goal ${s.id}` };
      if (s.text !== undefined) g.text = s.text;
      if (s.status !== undefined) g.status = s.status;
      store.touch(s.id);
      ledger?.recordSignal({ type: "goals-update", itemId: s.id, turn });
      return { op: s.op, ok: true, result: `goal ${s.id} updated` };
    }
    case "ctx.promote": {
      store.bump(s.id, 3, turn + 6);
      ledger?.recordSignal({ type: "ctx-promote", itemId: s.id, turn });
      return { op: s.op, ok: true, result: `promoted ${s.id} (+3 value, 6 turns)` };
    }
    case "ctx.demote": {
      store.bump(s.id, -3, turn + 6);
      return { op: s.op, ok: true, result: `demoted ${s.id} (−3 value, 6 turns)` };
    }
    case "ctx.watch": {
      store.setWatch(s.id, s.mode);
      ledger?.recordSignal({ type: "ctx-watch", itemId: s.id, mode: s.mode, turn });
      return { op: s.op, ok: true, result: `watch ${s.id}: ${s.mode}` };
    }
    case "ctx.search": {
      const lines: string[] = [];
      for (const it of store.all()) {
        const text = it.serialize();
        let re: RegExp;
        try { re = new RegExp(s.pattern, "i"); } catch { return { op: s.op, ok: false, result: `bad pattern: ${s.pattern}` }; }
        if (re.test(text) || re.test(it.id)) lines.push(`${it.id} (${it.kind})`);
      }
      return { op: s.op, ok: true, result: lines.length > 0 ? lines.join("; ") : `no matches for /${s.pattern}/` };
    }
    case "ctx.inspect": {
      return { op: s.op, ok: true, result: inspectStore(store, s.filter ?? "all") };
    }
    case "ctx.item": {
      const it = store.get(s.id);
      if (it === undefined) return { op: s.op, ok: false, result: `no item ${s.id}` };
      return { op: s.op, ok: true, result: itemStr(it) };
    }
    case "ctx.why": {
      const it = store.get(s.id);
      if (it === undefined) return { op: s.op, ok: false, result: `no item ${s.id}` };
      const lr = it.lastRender;
      const why = lr === undefined
        ? `${it.id}: never rendered`
        : `${it.id}: last render pos=${lr.position} digest=${lr.digest.slice(0, 8)}; value=${valueStr(it, store.turn)}`;
      return { op: s.op, ok: true, result: why };
    }
    default:
      return { op: "unknown", ok: false, result: "unknown intent" };
  }
}

function valueStr(it: { kind: string }, turn: number): string {
  return `kind=${it.kind} turn=${turn}`;
}

function itemStr(it: ReturnType<ContextStore["get"]> & {}): string {
  const opts = it.options().map((o) => o.id + (o.purelyAdditive ? "+" : "")).join(", ");
  return `${it.id} [${it.kind}/${it.velocity}] ${it.tokens}t; options: ${opts}`;
}

function inspectStore(store: ContextStore, filter: "rendered" | "invisible" | "all"): string {
  const parts: string[] = [];
  for (const it of store.all()) {
    const rendered = it.lastRender !== undefined;
    if (filter === "rendered" && !rendered) continue;
    if (filter === "invisible" && rendered) continue;
    parts.push(`${rendered ? "R" : "·"} ${it.id} [${it.kind}] ${it.tokens}t`);
  }
  return parts.length > 0 ? parts.join("\n") : "(empty)";
}
