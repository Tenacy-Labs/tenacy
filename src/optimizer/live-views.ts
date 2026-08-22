/**
 * Live views — ADR-0002d §5/§6. Push-driven lenses: a coordinator-side
 * watcher feeds invalidation without the model polling.
 *
 * - The turn is the sampling boundary: events debounce/coalesce to at
 *   most ONE committed delta per lens per turn; they drain at the same
 *   safe point as steering (no mid-turn mutation).
 * - Render stays pure: the watcher mutates the store/lens outside render.
 * - Sequence legibility (§6): identity stability (same id/slot — updates
 *   mutate, never drop-and-recreate), marked deltas (+/−/→ with turn
 *   citations), tail change-notices, unchanged-stamps.
 * - Churn pricing (§5): realized invalidation cost vs rendered value —
 *   a live lens that thrashes is demoted to polled (optimizer flip,
 *   never feeds value decay).
 *
 * Substrate adapters (0002d §4/§5): one engine, four substrates.
 * - file: fs.watch on the file; change -> refresh content from disk.
 * - dir: fs.watch recursive on the directory; add/unlink/rename markers.
 * - code: fs.watch on the source file; change -> symbol-table refresh,
 *   diff at SYMBOL granularity (untouched symbols keep digests).
 * - ns: fs.watch recursive on the prefix root; events under focus
 *   refresh the producer snapshot; commit replay stays the seq-legible
 *   channel (applyCommits), fs events just trigger the refresh.
 * Conversation/goals are in-process — the coordinator IS the watcher.
 */
import { watch, type FSWatcher } from "node:fs";
import type { Lens } from "./lens.ts";

export interface LensDelta {
  lensId: string;
  /** Turn the delta committed at (assigned at drain). */
  committedTurn: number;
  /** Marked changes, sequence-legible: +path / −path / →path @tN. */
  markers: string[];
  /** Event count coalesced into this delta (churn signal). */
  coalescedEvents: number;
}

export interface WatchEvent {
  lensId: string;
  path: string;
  kind: "change" | "rename" | "add" | "unlink";
}

/**
 * TurnBoundaryWatcher — the coalescing engine. Producers push raw events;
 * the loop drains at the turn boundary into one committed delta per lens.
 * Debounce is structural: nothing commits between turns by construction.
 */
export class TurnBoundaryWatcher {
  private pending = new Map<string, WatchEvent[]>();
  private deltas: LensDelta[] = [];
  private churn = new Map<string, number>();
  /** Demotion policy: events per turn above this => demote to polled. */
  churnDemoteThreshold = 40;

  push(ev: WatchEvent): void {
    const list = this.pending.get(ev.lensId);
    if (list === undefined) this.pending.set(ev.lensId, [ev]);
    else list.push(ev);
  }

  /** Drain at the safe point — returns one delta per lens with events. */
  drain(turn: number): LensDelta[] {
    const out: LensDelta[] = [];
    for (const [lensId, events] of this.pending) {
      const markers = new Set<string>();
      for (const ev of events) {
        const mk = ev.kind === "add" ? `+${ev.path}` : ev.kind === "unlink" ? `−${ev.path}` : ev.kind === "rename" ? `→${ev.path}` : `~${ev.path}`;
        markers.add(`${mk} @t${turn}`);
      }
      const total = (this.churn.get(lensId) ?? 0) + events.length;
      this.churn.set(lensId, total);
      out.push({ lensId, committedTurn: turn, markers: [...markers], coalescedEvents: events.length });
    }
    this.pending.clear();
    this.deltas.push(...out);
    return out;
  }

  /** Realized churn for a lens (demotion input, 0002d §5). */
  churnOf(lensId: string): number { return this.churn.get(lensId) ?? 0; }

  /** Should this lens be demoted live→polled? (optimizer-authored flip) */
  shouldDemote(lensId: string): boolean {
    return this.churnOf(lensId) > this.churnDemoteThreshold;
  }

  /** Sequence-legibility render helpers (§6). */
  static tailNotice(delta: LensDelta): string {
    return `[changed @t${delta.committedTurn}: ${delta.markers.slice(0, 3).join(", ")}${delta.markers.length > 3 ? ", …" : ""}]`;
  }
  static unchangedStamp(lastChangeTurn: number | null): string {
    return lastChangeTurn === null ? "unchanged since load" : `unchanged since turn ${lastChangeTurn}`;
  }
}

/**
 * LiveLensAdapter — substrate-aware live watcher for one lens. Shares the
 * single TurnBoundaryWatcher engine; refreshes the lens from its producer
 * hook when events arrive so render always sees current substrate state.
 */
export class LiveLensAdapter {
  private watcher: FSWatcher | null = null;

  constructor(
    private readonly engine: TurnBoundaryWatcher,
    private readonly lensId: string,
    private readonly root: string,
    /** Substrate: decides path scope + event interpretation + refresh. */
    private readonly substrate: "file" | "dir" | "code" | "ns",
    /** Lens refresh hook — re-reads substrate, returns nothing (mutates lens in place). */
    private readonly refresh: () => void,
  ) {}

  start(): void {
    try {
      const recursive = this.substrate === "dir" || this.substrate === "ns";
      this.watcher = watch(this.root, { recursive }, (event, filename) => {
        const f = filename === null ? "" : String(filename);
        if (f === "" || f.includes(".git") || f.includes("node_modules") || f.includes("dist/")) return;
        const kind: WatchEvent["kind"] = event === "rename" ? "rename" : "change";
        this.engine.push({ lensId: this.lensId, path: f, kind });
        // refresh from producer immediately (event coalescing still applies
        // to the MARKERS; the lens content itself must never go stale)
        this.refresh();
      });
    } catch {
      this.watcher = null;  // OS watch limits (§5 Risks) — degrade to polled
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }
}

// Back-compat alias: the file-substrate adapter keeps its name.
export { LiveLensAdapter as FsWatchAdapter };

/** Apply a committed delta to a lens's legibility fields (identity stable). */
export function applyDeltaToLens(lens: Lens, delta: LensDelta, turn: number): void {
  // Identity stability: mutate in place. lastDelta feeds the render header.
  (lens as unknown as { lastDelta?: string[] }).lastDelta = delta.markers;
  (lens as unknown as { lastChangeTurn?: number }).lastChangeTurn = turn;
}
