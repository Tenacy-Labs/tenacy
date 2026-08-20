/**
 * agent-kernel — a persistent TypeScript/JavaScript kernel for LLM agents.
 *
 * Born from a design study of prime-agent (RLM kernel concept) re-implemented
 * on Bun/JavaScriptCore for speed, with jcode-inspired session efficiency.
 *
 * Invariants (see docs/design.md):
 *   1. NEVER replay journal cells — side effects must fire exactly once.
 *      Amnesia is acceptable; duplication is not.
 *   2. Snapshot is the SOLE recovery source; the journal is audit-only.
 *   3. Snapshot commit is atomic (tmp + rename).
 *   4. Snapshots read LIVE values from global scope (stale-capture bug).
 *   5. Non-serializable values become explicit tombstones, never silent loss.
 */
import { appendFileSync, writeFileSync, renameSync, readFileSync, existsSync } from "node:fs";

type Snap = { index: number; data: Record<string, any>; tombstones: string[] };

/**
 * Pre-encode walk (runs BEFORE JSON.stringify). Necessary because stringify applies
 * Date.toJSON *before* any replacer — a replacer never sees a Date instance.
 * Converts all non-JSON natives into tagged plain objects, recursively.
 */
function preEncode(v: any): any {
  if (v instanceof Date) return { __t: "Date", e: v.toISOString() };
  if (v instanceof Map) return { __t: "Map", e: [...v.entries()].map(([a, b]) => [preEncode(a), preEncode(b)]) };
  if (v instanceof Set) return { __t: "Set", e: [...v.values()].map(preEncode) };
  if (v instanceof RegExp) return { __t: "RegExp", e: v.source, f: v.flags };
  if (Array.isArray(v)) return v.map(preEncode);
  if (v && typeof v === "object" && Object.getPrototypeOf(v)?.constructor?.name === "Object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(v)) out[k] = preEncode(v[k]);
    return out;
  }
  return v;
}

/** Revive encoded natives. */
export function revive(v: any): any {
  if (v && typeof v === "object") {
    if (v.__t === "Map") return new Map((v.e as [any, any][]).map(([a, b]) => [revive(a), revive(b)]));
    if (v.__t === "Set") return new Set((v.e as any[]).map(revive));
    if (v.__t === "Date") return new Date(v.e);
    if (v.__t === "RegExp") return new RegExp(v.e, v.f);
    for (const k of Object.keys(v)) v[k] = revive(v[k]);
  }
  return v;
}

/** Live resources (sockets, fds, class instances with behavior): unrestorable by snapshot. */
const ENCODABLE = new Set(["Map", "Set", "Date", "RegExp"]); // encoded by the replacer
function isUnrestorable(v: any): boolean {
  if (typeof v === "function") return false; // handled separately as fn-source
  if (v === null || typeof v !== "object") return false;
  const ctor = Object.getPrototypeOf(v)?.constructor?.name;
  if (ENCODABLE.has(ctor)) return false;
  return ctor !== undefined && ctor !== "Object" && ctor !== "Array";
}

export interface TurnResult { ok: boolean; value?: any; error?: string; turnMs: number }

export class Kernel {
  ns: Record<string, any> = {};
  cells: string[] = [];
  #known = new Set(Object.getOwnPropertyNames(globalThis));

  constructor(public journalPath: string, public snapPath: string) {}

  /** Execute a cell: journal (audit) -> execute -> snapshot (atomic commit). */
  eval(src: string): TurnResult {
    const t0 = performance.now();
    appendFileSync(this.journalPath, JSON.stringify({ i: this.cells.length, ts: Date.now(), src }) + "\n");
    let ok = true, value: any, error: string | undefined;
    try {
      value = (0, eval)(src);
      for (const k of Object.getOwnPropertyNames(globalThis)) {
        if (!this.#known.has(k)) { this.#known.add(k); (this.ns as any)[k] = (globalThis as any)[k]; }
      }
    } catch (e) {
      ok = false;
      error = String(e);
    }
    // Invariant 4: refresh from LIVE global values — primitives captured at binding time go stale.
    for (const k of Object.keys(this.ns)) {
      const v = (globalThis as any)[k];
      if (v !== undefined) (this.ns as any)[k] = v;
    }
    this.#writeSnapshot();
    this.cells.push(src);
    return { ok, value, error, turnMs: performance.now() - t0 };
  }

  #writeSnapshot(): { ms: number; bytes: number } {
    const t0 = performance.now();
    const data: Record<string, any> = {};
    const tombstones: string[] = [];
    for (const k of Object.keys(this.ns)) {
      const v = (this.ns as any)[k];
      if (isUnrestorable(v)) { tombstones.push(k); continue; }
      if (typeof v === "function") { data[k] = { __fn: v.toString() }; continue; }
      let s: string | undefined;
      try { s = JSON.stringify(preEncode(v)); } catch { s = undefined; } // cycles throw -> tombstone
      if (s === undefined) { tombstones.push(k); continue; }
      data[k] = v;
    }
    const snap: Snap = { index: this.cells.length + 1, data, tombstones };
    const json = JSON.stringify(preEncode(snap));
    const tmp = this.snapPath + ".tmp";
    writeFileSync(tmp, json);
    renameSync(tmp, this.snapPath); // atomic: never half-written
    return { ms: performance.now() - t0, bytes: json.length };
  }

  /**
   * Recovery: snapshot ONLY. No code path replays journal cells (invariants 1–2).
   * Worst case under total persistence failure: an empty namespace (we forget;
   * we never redo). The journal remains on disk as a readable audit record.
   */
  static recover(journalPath: string, snapPath: string): { k: Kernel; seeded: number; tombstoned: number; replayed: 0; ms: number } {
    const t0 = performance.now();
    const k = new Kernel(journalPath, snapPath);
    if (existsSync(journalPath)) {
      k.cells = readFileSync(journalPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).src);
    }
    let seeded = 0, tombstoned = 0;
    if (!existsSync(snapPath)) return { k, seeded, tombstoned, replayed: 0, ms: performance.now() - t0 };
    const snap: Snap = JSON.parse(readFileSync(snapPath, "utf8"));
    for (const [key, raw] of Object.entries(snap.data)) {
      let val: any;
      const v = revive(raw);
      if (v && v.__fn) val = (0, eval)("(" + v.__fn + ")");
      else val = v;
      (k.ns as any)[key] = val;
      (globalThis as any)[key] = val; // recovered cells resolve names in global scope
      seeded++;
    }
    for (const key of snap.tombstones) {
      const tomb = { __dead: true, kind: "unrestorable", note: "re-establish this resource explicitly" };
      (k.ns as any)[key] = tomb;
      (globalThis as any)[key] = tomb;
      tombstoned++;
    }
    k.#known = new Set([...k.#known, ...Object.keys(snap.data), ...snap.tombstones]);
    return { k, seeded, tombstoned, replayed: 0, ms: performance.now() - t0 };
  }
}
