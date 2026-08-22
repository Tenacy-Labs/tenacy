/**
 * Kernel namespace lens — ADR-0002d §3. The kernel's own namespace
 * (bindings, cells, values) as a focusable, recursive tree.
 *
 * - focus(scope) binds to a path prefix; expand reveals children;
 *   refocus deeper reuses the same algebra (depth is priced).
 * - Two projections: STRUCTURE (which bindings exist — cheap, stable)
 *   and CONTENT (a cell's source / a value's repr — per-leaf).
 * - Subscription: the commons versioned-commit diff IS the namespace's
 *   mutation event stream — the lens subscribes to commit diffs, not
 *   polling; no second event system. v1 supplies the commit log as an
 *   injectable producer; a live kernel wires its real commit stream.
 */
import { Lens } from "./lens.ts";
import type { Velocity } from "./types.ts";

export interface NamespaceNode {
  path: string;                 // "mcp/tools/http"
  kind: "binding" | "cell" | "value" | "group";
  /** Value repr for value/content leaves (structure omits it). */
  repr?: string;
}

/** Versioned commit — the namespace's mutation event (commons log). */
export interface NamespaceCommit {
  turn: number;
  /** Changed paths with markers: + added, − removed, → moved/renamed. */
  changes: Array<{ marker: "+" | "-" | "->"; path: string; repr?: string }>;
}

export interface NamespaceProducer {
  /** Children of a prefix ("" = root). */
  children(prefix: string): NamespaceNode[];
  /** The commit log since a turn, for replay-diff subscription. */
  commitsSince(turn: number): NamespaceCommit[];
  /**
   * Optional watcher hook (0002d §5): called by the live adapter when a
   * substrate event lands under the namespace. The producer re-scans its
   * snapshot and appends to its commit log; the lens then replays via
   * applyCommits at the turn boundary. Producers without external state
   * simply omit it (namespace is subscribable BY DESIGN, not by default).
   */
  refresh?: () => void;
}

/**
 * NSLensItem — selection is a SET OF PATH PREFIXES (focus scopes). The
 * structure projection lists bindings under the focused prefixes; the
 * content projection adds leaf reprs. Expanding a prefix selects its
 * children (recursive focus = re-expand).
 */
export class NSLensItem extends Lens {
  /** Focused path prefixes — the durable state. */
  prefixes: string[] = [];
  /** Projection mode. */
  projection: "structure" | "content" = "structure";
  /** Turn of last applied commit (subscription cursor — 0002d §5). */
  commitCursor = 0;
  /** Last diff markers rendered (sequence legibility, 0002d §6). */
  lastDelta: string[] = [];

  constructor(
    id: string,
    target: string,
    public producer: NamespaceProducer,
    velocity: Velocity = "evolving",
    immutable = false,
    upstreams: readonly string[] = [],
    hazardOverride?: number,
    valueBump?: { amount: number; untilTurn: number },
    watch: "live" | "polled" | "frozen" = "polled",
    lastRender?: { position: number; digest: string },
    lastTouchTurn = 0,
    createdTurn = 0,
  ) {
    super(id, target, velocity, immutable, upstreams, hazardOverride, valueBump, watch, lastRender, lastTouchTurn, createdTurn);
  }

  protected substrateTag(): string { return "ns"; }

  /** Focus a path prefix — bind the lens to that subtree. */
  focus(prefix: string): void {
    const norm = prefix.replace(/^\/+|\/+$/g, "");
    if (!this.prefixes.includes(norm)) this.prefixes.push(norm);
    this.#sync();
  }
  unfocus(prefix: string): void {
    const norm = prefix.replace(/^\/+|\/+$/g, "");
    this.prefixes = this.prefixes.filter((p) => p !== norm);
    this.#sync();
  }

  /** Expand = focus (the same algebra per 0002d §2). */
  override expand(from: number, to: number): void {
    // Index-range expand over the listing of focusable prefixes.
    const listing = this.#focusableListing();
    for (let i = from - 1; i < to && i < listing.length; i++) {
      const n = listing[i];
      if (n !== undefined) this.focus(n.path);
    }
    this.#sync();
  }
  override release(from: number, to: number): void {
    const listing = this.#focusableListing();
    for (let i = from - 1; i < to && i < listing.length; i++) {
      const n = listing[i];
      if (n !== undefined) this.unfocus(n.path);
    }
    this.#sync();
  }

  #focusableListing(): NamespaceNode[] {
    const out: NamespaceNode[] = [];
    const seen = new Set<string>();
    const walk = (prefix: string, depth: number): void => {
      if (depth > 4) return;   // recursion priced: bounded depth v1
      for (const c of this.producer.children(prefix)) {
        if (seen.has(c.path)) continue;
        seen.add(c.path);
        out.push(c);
        if (c.kind === "group") walk(c.path, depth + 1);
      }
    };
    const roots = this.prefixes.length === 0 ? [""] : this.prefixes;
    for (const r of roots) walk(r, 0);
    return out;
  }

  #sync(): void {
    this.ranges = this.prefixes.length === 0 ? [] : [[1, this.prefixes.length]];
  }

  /** Listing lines for both projections. */
  listingLines(): string[] {
    return this.#focusableListing().map((n) =>
      this.projection === "content" && n.repr !== undefined
        ? `${n.path}  ${n.kind}  ${n.repr}`
        : `${n.path}  ${n.kind}`,
    );
  }

  override extentLines(): number | undefined { return this.listingLines().length; }

  protected sliceRange(a: number, b: number): string {
    const lines = this.listingLines();
    return lines.slice(a - 1, b).map((l, i) => `${a + i}| ${l}`).join("\n");
  }

  /**
   * Apply the commit log since our cursor — sequence-legible deltas
   * (0002d §6): markers with turn citations; identity stable.
   */
  applyCommits(currentTurn: number): void {
    const commits = this.producer.commitsSince(this.commitCursor);
    const markers: string[] = [];
    for (const c of commits) {
      for (const ch of c.changes) {
        markers.push(`${ch.marker === "->" ? "→" : ch.marker}${ch.path} @t${c.turn}`);
      }
    }
    if (commits.length > 0) {
      this.commitCursor = Math.max(...commits.map((c) => c.turn));
    }
    this.lastDelta = markers;
    if (markers.length > 0) this.baseBlockTurn = currentTurn;  // delta since
  }
}
