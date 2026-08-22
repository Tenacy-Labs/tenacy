/**
 * Session persistence — minimal viable form (0003 instrument-first spirit).
 *
 * A session file captures everything the AgentLoop cannot reconstruct:
 *  - the item store (typed rows: standing/goal/turn/lens/notice + state)
 *  - the file-lens registry (ranges, base-block turn, lens state)
 *  - turn counter + incumbent layout (hysteresis continuity)
 *  - provider identity (name + modelId, never credentials)
 *
 * Restore re-hydrates a fresh AgentLoop: items re-enter the store with
 * their turn stamps intact; lenses re-attach live content (re-read from
 * disk by the host's fileContent) so post-restore expands diff against
 * current reality, not stale snapshots.
 *
 * Format: JSON, one object; versioned. Failures throw honestly.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentLoop } from "./loop.ts";
import { StandingItem, GoalItem, TurnItem, FileLensItem, NoticeItem } from "./items.ts";
import type { ContextItem, LensState } from "./types.ts";

export interface SessionHeader {
  format: "agent-kernel-session";
  version: 1;
  savedAt: string;                 // ISO
  providerName: string;
  modelId: string;
  turn: number;
}

interface StandingRow { t: "standing"; id: string; kind: "identity" | "directive"; text: string; immutable: boolean; watch: string | undefined }
interface GoalRow { t: "goal"; id: string; text: string; parentId?: string | undefined; horizon?: string | undefined; status: "active" | "completed" }
interface TurnRow { t: "turn"; id: string; role: "user" | "model" | "tool-result"; verbatim: string; summary?: string | undefined; rep: string; mergedInto?: string | undefined }
interface LensRow { t: "lens"; id: string; target: string; tag: string; ranges: Array<[number, number]>; baseBlockTurn: number; state: string; selected?: string[]; prefixes?: string[]; projection?: string }
interface NoticeRow { t: "notice"; id: string; text: string }
type Row = StandingRow | GoalRow | TurnRow | LensRow | NoticeRow;

export interface SessionFile {
  header: SessionHeader;
  rows: Row[];
}

export function sessionsDir(): string {
  return ".agent-kernel/sessions";
}

/** Serialize the live loop state. Lenses are captured structurally. */
export function saveSession(loop: AgentLoop, path: string, providerName: string): SessionFile {
  const rows: Row[] = [];
  for (const it of loop.store.all()) {
    const ci = it as ContextItem & { serialize(): string };
    switch (rowType(it)) {
      case "standing": {
        // StandingItem carries its text behind #text; serialize() returns it
        rows.push({ t: "standing", id: it.id, kind: it.kind as "identity" | "directive", text: ci.serialize(), immutable: it.immutable, watch: it.watch });
        break;
      }
      case "goal": {
        const g = loop.goalRegistryView().get(it.id);
        if (g === undefined) { rows.push(goalFromContext(it)); break; }
        {
        const row: GoalRow = { t: "goal", id: g.id, text: g.text, horizon: g.horizon, status: g.status };
        if (g.parentId !== undefined) row.parentId = g.parentId;
        rows.push(row);
      }
        break;
      }
      case "turn": {
        // TurnItem-like episodic rows: verbatim recoverable from serialize() minus the role prefix
        const body = stripRolePrefix(ci.serialize());
        {
        const row: TurnRow = { t: "turn", id: it.id, role: roleFromId(it.id), verbatim: body, rep: turnRepOf(it) };
        const sum = turnSummaryOf(it);
        if (sum !== undefined) row.summary = sum;
        const mi = (it as { mergedInto?: string | undefined }).mergedInto;
        if (mi !== undefined) row.mergedInto = mi;
        rows.push(row);
      }
        break;
      }
      case "lens": {
        const f = loop.lensRegistryView().get(it.id);
        if (f === undefined) break;  // orphaned lens row — skip honestly
        const row: LensRow = { t: "lens", id: f.id, target: f.target, tag: f.substrateTagView(), ranges: f.ranges, baseBlockTurn: f.baseBlockTurn, state: f.state };
        const extra = f as unknown as { selected?: string[]; prefixes?: string[]; projection?: string };
        if (Array.isArray(extra.selected)) (row as { selected?: string[] }).selected = extra.selected;
        if (Array.isArray(extra.prefixes)) (row as { prefixes?: string[] }).prefixes = extra.prefixes;
        if (extra.projection !== undefined) (row as { projection?: string }).projection = extra.projection;
        rows.push(row);
        break;
      }
      case "notice": {
        rows.push({ t: "notice", id: it.id, text: ci.serialize() });
        break;
      }
    }
  }
  const sf: SessionFile = {
    header: {
      format: "agent-kernel-session",
      version: 1,
      savedAt: new Date().toISOString(),
      providerName,
      modelId: loop.providerId,
      turn: loop.store.turn,
    },
    rows,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(sf, null, 2));
  return sf;
}

/** Restore into a fresh loop. Returns count of restored rows. */
export function restoreSession(loop: AgentLoop, path: string): { header: SessionHeader; restored: number } {
  if (!existsSync(path)) throw new Error(`no session file: ${path}`);
  const sf = JSON.parse(readFileSync(path, "utf8")) as SessionFile;
  if (sf.header?.format !== "agent-kernel-session" || sf.header.version !== 1) {
    throw new Error(`unrecognized session format: ${String(sf.header?.format)}`);
  }
  let restored = 0;
  const hdrTurn = sf.header.turn;
  // Two passes: standing/goal first (identity zone), then turns, lenses, notices
  for (const pass of [1, 2]) {
    for (const r of sf.rows) {
      if (pass === 1 && r.t !== "standing" && r.t !== "goal") continue;
      if (pass === 2 && (r.t === "standing" || r.t === "goal")) continue;
      switch (r.t) {
        case "standing": {
          const s = new StandingItem(r.id, r.kind, r.text);
          s.immutable = r.immutable;
          loop.addRestoredItem(s.toContextItem(), hdrTurn, hdrTurn);
          break;
        }
        case "goal": {
          const g = new GoalItem(r.id, r.text, r.parentId, r.horizon as "session" | "task" | "standing");
          g.status = r.status;
          loop.registerGoalRow(g);
          break;
        }
        case "turn": {
          loop.addRestoredTurn(r.id, r.role, r.verbatim, r.summary, r.rep, r.mergedInto);
          break;
        }
        case "lens": {
          loop.attachLens(r.id, r.target, r.ranges, r.baseBlockTurn, r.state as LensState, r.tag, { selected: r.selected, prefixes: r.prefixes, projection: r.projection });
          break;
        }
        case "notice": {
          const n = new NoticeItem(r.id, "notice", r.text);
          loop.store.add(n.toContextItem());
          break;
        }
      }
      restored++;
    }
  }
  loop.setTurn(sf.header.turn);
  return { header: sf.header, restored };
}

// ── helpers ─────────────────────────────────────────────────────────────

function rowType(it: ContextItem): "standing" | "goal" | "turn" | "lens" | "notice" {
  if (it.kind === "identity" || it.kind === "directive") return "standing";
  if (it.kind === "goal") return "goal";
  if (it.kind === "episodic") return "turn";
  if (it.kind === "lens") return "lens";
  return "notice";
}

function goalFromContext(it: ContextItem): GoalRow {
  const ci = it as ContextItem & { serialize(): string };
  const s = ci.serialize();
  const done = s.startsWith("[done]");
  const body = done ? s.slice(6).trim() : s.replace(/^\[goal:[a-z]+\]\s*/, "");
  return { t: "goal", id: it.id, text: body, status: done ? "completed" : "active" };
}

function stripRolePrefix(s: string): string {
  const m = /^\[(user|model|tool-result)\]\s?/.exec(s);
  return m === null ? s : s.slice(m[0].length);
}

function roleFromId(id: string): "user" | "model" | "tool-result" {
  if (id.endsWith("-user")) return "user";
  if (id.endsWith("-model")) return "model";
  return "tool-result";
}

function turnSummaryOf(it: ContextItem): string | undefined {
  const anyIt = it as { summary?: string };
  return anyIt.summary;
}

function turnRepOf(it: ContextItem): string {
  const anyIt = it as { rep?: string };
  return anyIt.rep ?? "VERBATIM";
}
