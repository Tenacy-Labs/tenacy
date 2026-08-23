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
      // Per-turn churn EWMA (review C3 fix, 2026-08-22): churnOf must feed
      // churn.ts a per-TURN rate (contract: "EWMA of events per turn; 1 =
      // every turn"), not the lifetime total. Same EWMA discipline as the
      // hazard signal: blend this turn's event count, decay when quiet.
      const perTurn = events.length;                     // this turn's count
      const prevC = this.churnEwma.get(lensId) ?? 0;
      this.churnEwma.set(lensId, 0.5 * prevC + 0.5 * perTurn);
      // Observed-hazard EWMA (0002d §5 churn pricing): binary did-change
      // signal — a file that mutates every turn converges to hazard 1.0,
      // a quiet one decays to 0. Feeds item.hazardOverride → solver.
      const obs = events.length > 0 ? 1 : 0;
      const prevH = this.observedHazard.get(lensId) ?? 0;
      this.observedHazard.set(lensId, 0.5 * prevH + 0.5 * obs);
      out.push({ lensId, committedTurn: turn, markers: [...markers], coalescedEvents: events.length });
    }
    const fired = new Set(out.map((d) => d.lensId));
    // Quiet lenses settle toward 0; lenses that fired keep this turn's blend.
    for (const [lensId, h] of this.observedHazard) {
      if (!fired.has(lensId)) this.observedHazard.set(lensId, 0.5 * h);
    }
    this.pending.clear();
    this.deltas.push(...out);
    // Review B-8 fix (2026-08-23): the delta journal had zero readers and no
    // bound — a long-lived watcher grew it without limit. Ring-cap at 1000:
    // keep the MOST RECENT deltas (diagnostic tail), drop the oldest.
    if (this.deltas.length > 1000) this.deltas.splice(0, this.deltas.length - 1000);
    return out;
  }

  private observedHazard = new Map<string, number>();
  private churnEwma = new Map<string, number>();

  /** Realized per-turn hazard belief for a lens (solver input, EWMA). */
  observedHazardOf(lensId: string): number { return this.observedHazard.get(lensId) ?? 0; }

  /** Realized per-turn churn rate for a lens (EWMA; churnProfile input). */
  churnOf(lensId: string): number { return this.churnEwma.get(lensId) ?? 0; }

  /** Lifetime event total (demotion input, 0002d §5). */
  churnLifetimeOf(lensId: string): number { return this.churn.get(lensId) ?? 0; }

  /** Should this lens be demoted live→polled? (optimizer-authored flip) */
  shouldDemote(lensId: string): boolean {
    return this.churnLifetimeOf(lensId) > this.churnDemoteThreshold;
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
