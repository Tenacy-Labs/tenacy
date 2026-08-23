/**
 * Steering intents — the files / ctx / goals tool surface, executed at the
 * coordinator (proposer/applier split — 0002g, K7). Mutations are store-level
 * signals; the solver stays single writer of render (signals not overrides).
 */
import type { ContextStore } from "./store.ts";
import type { ContextItem } from "./types.ts";
import type { Ledger } from "./ledger.ts";
import type { MemoryKind } from "./memory.ts";
import { opsCaps } from "./ops.ts";
import { GoalItem, FileLensItem, DirectoryLensItem, MergeGroupItem } from "./items.ts";
import { CodeLensItem } from "./code-lens.ts";
import { NSLensItem } from "./ns-lens.ts";

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
  | { op: "err.resolve"; id: string }
  | { op: "ctx.watch"; id: string; mode: "live" | "polled" | "frozen" }
  | { op: "ctx.search"; pattern: string }
  | { op: "dirs.expand"; target: string; from: number; to: number }
  | { op: "dirs.release"; target: string; from: number; to: number }
  | { op: "code.expand"; target: string; symbols: string[] }
  | { op: "code.release"; target: string; symbols: string[] }
  | { op: "code.structure"; target: string }
  | { op: "ns.focus"; target: string; prefix: string; projection?: "structure" | "content" }
  | { op: "ns.unfocus"; target: string; prefix: string }
  | { op: "convo.merge"; from: number; to: number }
  | { op: "convo.reexpand"; id: string }
  | { op: "ctx.reexpand"; id: string }
  | { op: "goals.decompose"; id: string; sub: { id: string; text: string }[] }
  | { op: "rlm.spawn"; goal: string }
  | { op: "rlm.turn"; id: string; message: string }
  | { op: "rlm.stop"; id: string; reason?: string }
  | { op: "rlm.status"; id?: string }
  | { op: "rlm.final"; id: string }
  | { op: "memory.remember"; text: string; kind?: MemoryKind; meta?: Record<string, unknown> }
  | { op: "memory.search"; query: string; limit?: number; kind?: MemoryKind };

export type IntentResult = { op: string; ok: boolean; result: string };

// Module-level registries wired by the loop (single-writer coordinator side).
export interface IntentHost {
  fileLens(target: string): FileLensItem;
  dirLens(target: string): DirectoryLensItem;
  codeLens(target: string): CodeLensItem;
  nsLens(target: string): NSLensItem;
  convoTurn(id: string): { id: string; summary?: string | undefined; mergedInto?: string | undefined; verbatim(): string; markReexpanded(): void } | undefined;
  goal(id: string): GoalItem | undefined;
  setGoal(g: GoalItem): void;
  addStoreItem(item: { toContextItem(): ContextItem }): void;
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
    case "dirs.expand": {
      if (host === null) return { op: s.op, ok: false, result: "no host bound" };
      const lens = host.dirLens(s.target);
      lens.expand(s.from, s.to);
      store.touch(lens.id);
      ledger?.recordSignal({ type: "dirs-expand", itemId: lens.id, from: s.from, to: s.to, turn });
      return { op: s.op, ok: true, result: `loaded ${s.target} entries ${s.from}-${s.to} → ${lens.ranges.length} coalesced range(s)` };
    }
    case "dirs.release": {
      if (host === null) return { op: s.op, ok: false, result: "no host bound" };
      const lens = host.dirLens(s.target);
      lens.release(s.from, s.to);
      store.touch(lens.id);
      ledger?.recordSignal({ type: "dirs-release", itemId: lens.id, from: s.from, to: s.to, turn });
      return { op: s.op, ok: true, result: `released ${s.target} entries ${s.from}-${s.to} (${lens.ranges.length} remain)` };
    }
    case "code.expand": {
      if (host === null) return { op: s.op, ok: false, result: "no host bound" };
      const lens = host.codeLens(s.target);
      for (const sym of s.symbols) lens.expandSymbol(sym);
      store.touch(lens.id);
      ledger?.recordSignal({ type: "code-expand", itemId: lens.id, symbols: s.symbols, turn });
      return { op: s.op, ok: true, result: `anchored ${s.symbols.length} symbol(s) in ${s.target} (${lens.selected.length} selected)` };
    }
    case "code.release": {
      if (host === null) return { op: s.op, ok: false, result: "no host bound" };
      const lens = host.codeLens(s.target);
      for (const sym of s.symbols) lens.releaseSymbol(sym);
      store.touch(lens.id);
      ledger?.recordSignal({ type: "code-release", itemId: lens.id, symbols: s.symbols, turn });
      return { op: s.op, ok: true, result: `released ${s.symbols.length} symbol(s) (${lens.selected.length} remain)` };
    }
    case "code.structure": {
      if (host === null) return { op: s.op, ok: false, result: "no host bound" };
      const lens = host.codeLens(s.target);
      store.touch(lens.id);
      ledger?.recordSignal({ type: "code-structure", itemId: lens.id, turn });
      return { op: s.op, ok: true, result: lens.structureText() };
    }
    case "ns.focus": {
      if (host === null) return { op: s.op, ok: false, result: "no host bound" };
      const lens = host.nsLens(s.target);
      lens.focus(s.prefix);
      if (s.projection !== undefined) lens.projection = s.projection;
      store.touch(lens.id);
      ledger?.recordSignal({ type: "ns-focus", itemId: lens.id, prefix: s.prefix, projection: lens.projection, turn });
      return { op: s.op, ok: true, result: `focused ${s.prefix || "(root)"} under ${s.target} (${lens.prefixes.length} scope(s), ${lens.projection} projection)` };
    }
    case "ns.unfocus": {
      if (host === null) return { op: s.op, ok: false, result: "no host bound" };
      const lens = host.nsLens(s.target);
      lens.unfocus(s.prefix);
      store.touch(lens.id);
      ledger?.recordSignal({ type: "ns-unfocus", itemId: lens.id, prefix: s.prefix, turn });
      return { op: s.op, ok: true, result: `unfocused ${s.prefix} (${lens.prefixes.length} scope(s) remain)` };
    }
    case "convo.merge": {
      if (host === null) return { op: s.op, ok: false, result: "no host bound" };
      const members: string[] = [];
      const texts: string[] = [];
      // Review B-4 fix (2026-08-23): validate BEFORE mutating. The old loop
      // stamped mergedInto inside the collection pass; a range holding a
      // single turn returned ok:false with that member permanently stranded
      // inside a merge that never materialized.
      for (let t = s.from; t <= s.to; t++) {
        for (const role of ["user", "model"] as const) {
          const m = host.convoTurn(`turn-${t}-${role}`);
          if (m !== undefined) {
            members.push(m.id);
            texts.push(firstSentence(m.verbatim()));
          }
        }
      }
      if (members.length < 2) return { op: s.op, ok: false, result: "fewer than two turns in range" };
      const groupId = `merge:turn-${s.from}-user..turn-${s.to}-model`;
      for (const mid of members) {
        const m = host.convoTurn(mid);
        if (m !== undefined) m.mergedInto = groupId;
        // Review B-4 fix (2026-08-23): the member's ContextItem.upstreams
        // must point at the group. The solver's family coupling keys off
        // upstreams[0]; without it, parent === undefined for every member,
        // the verbatim fallback fired even when the group was chosen and
        // carrying, and in-merge members were priced asymmetrically against
        // fragments. (The TurnItem's own upstreams field is used for other
        // lineage; we set the STORE copy's field.)
        const storeMember = store.get(mid);
        if (storeMember !== undefined) (storeMember as unknown as { upstreams?: readonly string[] }).upstreams = [groupId];
      }
      const group = new MergeGroupItem(groupId, members, texts.join(" "), turn);
      // Value mass = summed member values at merge time (multi-period pass):
      // each member realizes its k=0 decayed value; the group inherits the
      // mass with a fresh clock. Per-turn realization stays per-member scale.
      let mass = 0;
      for (const mid of members) {
        const t0 = host.convoTurn(mid);
        if (t0 === undefined) continue;
        const num = Number(/^turn-(\d+)-/.exec(mid)?.[1] ?? 0);
        const age = Math.max(0, turn - num);
        mass += 3.0 * Math.pow(1 + age, -1.0);   // episodic profile at merge
      }
      group.valueMass = mass;
      host.addStoreItem(group);
      ledger?.recordSignal({ type: "convo-merge", itemId: groupId, members, turn });
      return { op: s.op, ok: true, result: `merged ${members.length} turns into ${groupId}` };
    }
    case "convo.reexpand":
    case "ctx.reexpand": {
      if (host === null) return { op: s.op, ok: false, result: "no host bound" };
      const m = host.convoTurn(s.id);
      if (m === undefined) return { op: s.op, ok: false, result: `no such turn: ${s.id}` };
      const wasLossy = m.summary !== undefined || m.mergedInto !== undefined;
      m.mergedInto = undefined;
      m.summary = undefined;
      m.markReexpanded();
      store.touch(s.id);
      // ADR-0006 §2.1: re-expansion is the strongest re-reference evidence.
      store.recordAccess(s.id, "reExpanded", turn);
      if (wasLossy) ledger?.recordSignal({ type: "realized-lossiness", itemId: s.id, turn });
      return { op: s.op, ok: true, result: wasLossy ? `${s.id} restored to verbatim (realized lossiness journaled)` : `${s.id} was already verbatim` };
    }
    case "goals.decompose": {
      if (host === null) return { op: s.op, ok: false, result: "no host bound" };
      const parent = host.goal(s.id);
      if (parent === undefined) return { op: s.op, ok: false, result: `no such goal: ${s.id}` };
      let added = 0;
      for (const sub of s.sub) {
        const g = new GoalItem(sub.id, sub.text, s.id, "task");
        host.setGoal(g);
        added++;
      }
      ledger?.recordSignal({ type: "goals-decompose", itemId: s.id, subs: s.sub.map((x) => x.id), turn });
      return { op: s.op, ok: true, result: `${s.id} decomposed into ${added} subgoal(s)` };
    }
    case "goals.set": {
      if (host === null) return { op: s.op, ok: false, result: "no host bound" };
      const g = new GoalItem(s.id, s.text, undefined, s.horizon ?? "task");
      host.setGoal(g);
      ledger?.recordSignal({ type: "goals-set", itemId: s.id, turn });
      return { op: s.op, ok: true, result: `goal ${s.id}: ${s.text}` };
    }
    case "rlm.spawn": {
      const caps = opsCaps();
      if (caps?.rlm === null || caps === null) return { op: s.op, ok: false, result: "no rlm supervisor bound" };
      try {
        const h = caps.rlm.spawn(s.goal);
        return { op: s.op, ok: true, result: `spawned ${h.id}: "${s.goal}"` };
      } catch (e) {
        return { op: s.op, ok: false, result: String(e) };
      }
    }
    case "rlm.turn": {
      const caps = opsCaps();
      if (caps === null || caps.rlm === null) return { op: s.op, ok: false, result: "no rlm supervisor bound" };
      const h = caps.rlm.handleOf(s.id);
      if (h === undefined) return { op: s.op, ok: false, result: `unknown child ${s.id}` };
      if (h.status() !== "spawned" && h.status() !== "running") {
        return { op: s.op, ok: false, result: `${s.id} is ${h.status()}` };
      }
      // Fire-and-forget by design: the child runs asynchronously; its report
      // routes into the parent store as a priced NoticeItem at completion.
      void h.run(s.message).catch((e: unknown) => {
        ledger?.recordSignal({ type: "rlm-turn-error", itemId: s.id, error: String(e), turn });
      });
      ledger?.recordSignal({ type: "rlm-turn", itemId: s.id, turn });
      return { op: s.op, ok: true, result: `turn dispatched to ${s.id} (report arrives as notice)` };
    }
    case "rlm.stop": {
      const caps = opsCaps();
      if (caps === null || caps.rlm === null) return { op: s.op, ok: false, result: "no rlm supervisor bound" };
      const h = caps.rlm.handleOf(s.id);
      if (h === undefined) return { op: s.op, ok: false, result: `unknown child ${s.id}` };
      h.stop(s.reason);
      ledger?.recordSignal({ type: "rlm-stop", itemId: s.id, turn });
      return { op: s.op, ok: true, result: `${s.id} stopped` };
    }
    case "rlm.status": {
      const caps = opsCaps();
      if (caps === null || caps.rlm === null) return { op: s.op, ok: false, result: "no rlm supervisor bound" };
      if (s.id !== undefined) {
        const h = caps.rlm.handleOf(s.id);
        if (h === undefined) return { op: s.op, ok: false, result: `unknown child ${s.id}` };
        return { op: s.op, ok: true, result: `${h.id} [${h.status()}] "${h.goal}" — ${fmtUsage(h.usage())}` };
      }
      const rows = caps.rlm.list().map((c) => `${c.id} [${c.status}] ${fmtUsage(c.usage)}`);
      const total = caps.rlm.totalUsage();
      return {
        op: s.op, ok: true,
        result: rows.length === 0 ? "no children" : `${rows.join(" | ")} — total ${fmtUsage(total)}`,
      };
    }
    case "rlm.final": {
      const caps = opsCaps();
      if (caps === null || caps.rlm === null) return { op: s.op, ok: false, result: "no rlm supervisor bound" };
      const h = caps.rlm.handleOf(s.id);
      if (h === undefined) return { op: s.op, ok: false, result: `unknown child ${s.id}` };
      const report = caps.rlm.reportOf(s.id);
      return {
        op: s.op, ok: true,
        result: report !== undefined ? report : `${s.id} ${h.status()}; report pending (arrives as notice)`,
      };
    }
    case "memory.remember": {
      const caps = opsCaps();
      if (caps === null || caps.memory === null) return { op: s.op, ok: false, result: "no memory store bound" };
      const row = caps.memory.remember(s.text, {
        ...(s.kind !== undefined ? { kind: s.kind } : {}),
        ...(s.meta !== undefined ? { meta: s.meta } : {}),
      });
      ledger?.recordSignal({ type: "memory-remember", itemId: `mem:${row.id}`, kind: row.kind, turn });
      return { op: s.op, ok: true, result: `remembered [${row.kind}] mem:${row.id}: ${s.text}` };
    }
    case "memory.search": {
      const caps = opsCaps();
      if (caps === null || caps.memory === null) return { op: s.op, ok: false, result: "no memory store bound" };
      const hits = caps.memory.search(s.query, s.limit ?? 5, s.kind);
      if (hits.length === 0) return { op: s.op, ok: true, result: "no matches" };
      return {
        op: s.op, ok: true,
        result: hits.map((h) => `mem:${h.row.id} [${h.row.kind}] (${h.source} ${h.score.toFixed(2)}) ${h.row.text}`).join("\n"),
      };
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
    case "err.resolve": {
      // A-M5 owner ruling (2026-08-23): the model marks an error dealt
      // with — sticky floor lifts, lesson glides out. Model-authored only.
      const ok = store.resolveError(s.id);
      ledger?.recordSignal({ type: "err-resolve", itemId: s.id, turn });
      return { op: s.op, ok, result: ok ? `resolved ${s.id} — floor lifted, decaying` : `no unresolved error ${s.id}` };
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
        if (re.test(text) || re.test(it.id)) {
          lines.push(`${it.id} (${it.kind})`);
          // ADR-0006 §2.1: search hits are re-reference evidence (0002h's
          // journaled-but-unpriced signal loop closes here).
          store.recordAccess(it.id, "searchHit", turn);
        }
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

/** Compact usage line for rlm status reports (attribution surface). */
function fmtUsage(u: { calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): string {
  return `${u.calls} call(s), ${u.inputTokens} in / ${u.outputTokens} out` +
    (u.cacheReadTokens > 0 || u.cacheWriteTokens > 0 ? `, cache ${u.cacheReadTokens}r/${u.cacheWriteTokens}w` : "");
}

function itemStr(it: ReturnType<ContextStore["get"]> & {}): string {
  const opts = it.options().map((o) => o.id + (o.purelyAdditive ? "+" : "")).join(", ");
  return `${it.id} [${it.kind}] ${it.tokens}t; options: ${opts}`;
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

function firstSentence(text: string): string {
  const m = /[.!?]\s/.exec(text);
  return m === null ? text.slice(0, 200) : text.slice(0, m.index + 1);
}
