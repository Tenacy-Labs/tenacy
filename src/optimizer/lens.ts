/**
 * Lens hierarchy — proper OOP substrate for ADR-0002d.
 *
 * The abstract `Lens` owns everything generic:
 *   - the expand/release algebra (coalesced ranges, idempotent re-expand,
 *     partial release splitting)
 *   - the option surface (A4/A5 template method: FULL-only first write,
 *     base+delta as the additive path, consolidation, compact header,
 *     purge past threshold)
 *   - ContextItem plumbing (serialize/options/tokens/toContextItem)
 *
 * A concrete substrate implements only:
 *   - sliceRange(a, b)   — materialize lines a..b of its substrate
 *   - substrateTag()     — the ⟨tag …⟩ header token ("file", "dir", …)
 *   - rangeCount()       — substrate extent, for bounds honesty (optional)
 *
 * Adding a lens = one small subclass; the solver, renderer, ledger,
 * sessions, and intents see the same ContextItem shape regardless of
 * substrate. FileLensItem keeps its exact byte-level output (cache
 * digests depend on it).
 */
import type { ContextItem, LensState, RenderOption, Velocity } from "./types.ts";
import { opt } from "./items.ts";
import { estTokens } from "./renderer.ts";

export abstract class Lens {
  /** Coalesced ranges actually loaded, sorted. */
  ranges: Array<[number, number]> = [];
  baseBlockTurn = -1;   // when the base block was written (-1: no base yet)
  state: LensState = "FULL";
  constructor(
    public readonly id: string,          // "lens:src/kernel.ts"
    public readonly target: string,      // substrate address (fs path, dir, …)
    public velocity: Velocity = "evolving",
    public immutable = false,
    public upstreams: readonly string[] = [],
    public hazardOverride?: number,
    public valueBump?: { amount: number; untilTurn: number },
    public watch: "live" | "polled" | "frozen" = "polled",
    public lastRender?: { position: number; digest: string },
    public lastTouchTurn = 0,
    public createdTurn = 0,
  ) {}

  // ── substrate hooks (the only subclass obligations) ────────────────────

  /** Materialize lines [a..b] of the substrate, 1-indexed, `a|i` prefixed. */
  protected abstract sliceRange(a: number, b: number): string;
  /** Header token identifying the substrate family. */
  protected abstract substrateTag(): string;
  /** Substrate extent in lines; undefined = unknown/unbounded. */
  extentLines(): number | undefined { return undefined; }
  /** Public view of the substrate tag (serialization). */
  substrateTagView(): string { return this.substrateTag(); }

  // ── generic range algebra (0002d: one expand algebra across substrates) ─

  expand(from: number, to: number): void {
    // merge into coalesced ranges (idempotent re-expand)
    this.ranges.push([from, to]);
    this.ranges.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const r of this.ranges) {
      const last = merged[merged.length - 1];
      if (last !== undefined && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    this.ranges = merged;
  }

  release(from: number, to: number): void {
    this.ranges = this.ranges.flatMap(([a, b]): Array<[number, number]> => {
      if (to < a || from > b) return [[a, b]];
      const parts: Array<[number, number]> = [];
      if (from > a) parts.push([a, from - 1]);
      if (to < b) parts.push([to + 1, b]);
      return parts;
    });
  }

  // ── generic render text (template pieces over the hooks) ───────────────

  protected selectedText(): string {
    return this.ranges
      .map(([a, b]) => this.sliceRange(a, b))
      .join("\n...\n");
  }

  fullText(): string {
    return `⟨${this.substrateTag()} ${this.target} ${this.ranges.length} range(s)⟩\n${this.selectedText()}`;
  }
  deltaText(): string {
    return `⟨${this.substrateTag()} ${this.target} +Δ⟩\n${this.selectedText()}`;
  }
  compactText(): string {
    return `⟨${this.substrateTag()} ${this.target}: ${this.ranges.length} range(s), ${this.ranges.map(([a, b]) => `${a}-${b}`).join(",")}⟩`;
  }

  serialize(): string { return this.fullText(); }

  /**
   * The option surface (A4/A5): compact front block vs distributed
   * deltas vs consolidation vs purge. The solver picks per turn.
   * Template method — substrate-invariant by design.
   */
  options(): RenderOption[] {
    if (this.ranges.length === 0) return [];   // nothing loaded — presents no options
    const full = this.fullText();
    const compact = this.compactText();
    const opts: RenderOption[] = [];
    if (this.baseBlockTurn < 0) {
      // No base yet: FULL is the ONLY first write. A content-free compact
      // header is not a representation of unseen data — offering it let the
      // solver drop bytes the model had never received (caught live by
      // glm-5.2 refusing to answer from an empty lens).
      opts.push(opt("full", ["stable"], "FULL", full, true));
    } else {
      // base exists: deltas are the additive path; re-consolidation is a rewrite
      opts.push(opt("base+delta", ["stable"], "BASE+DELTA", this.deltaText(), true));
      opts.push(opt("consolidated", ["stable"], "CONSOLIDATED", full, false));
      opts.push(opt("compact", ["foundational"], "FULL", compact, false));
    }
    if (this.tokens > 1500) {
      opts.push(opt("purge", ["volatile"], "PURGED", `⟨${this.substrateTag()} ${this.target}: purged; re-expand on demand⟩`, false));
    }
    return opts;
  }

  get tokens(): number { return estTokens(this.fullText()); }
  toContextItem(): ContextItem {
    return {
      id: this.id, kind: "lens", velocity: this.velocity, immutable: this.immutable,
      tokens: this.tokens, serialize: () => this.serialize(), options: () => this.options(),
      upstreams: this.upstreams, lastRender: this.lastRender, lastTouchTurn: this.lastTouchTurn,
      createdTurn: this.createdTurn, hazardOverride: this.hazardOverride, valueBump: this.valueBump,
      watch: this.watch,
    };
  }
}

/**
 * FileLensItem — line-range lens over a file's content (0002d instance 1).
 * Content is producer-supplied (the host's fileContent hook); this class
 * only slices. Byte-identical output to the pre-hierarchy implementation.
 */
export class FileLensItem extends Lens {
  constructor(
    id: string,
    target: string,
    public content: string,             // current file content (producer-supplied)
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

  protected substrateTag(): string { return "file"; }
  override extentLines(): number | undefined { return this.content === "" ? 0 : this.content.split("\n").length; }

  protected sliceRange(a: number, b: number): string {
    const lines = this.content.split("\n");
    return lines.slice(a - 1, b).map((l, i) => `${a + i}| ${l}`).join("\n");
  }
}

/**
 * DirectoryLensItem — line-range lens over a directory listing (0002d
 * instance 4, polled form). Lines are sorted entries; expand 1-40 shows
 * the first 40 entries. The listing is producer-supplied (host hook) for
 * the same testability reasons as file content. fs.watch subscription is
 * the 0002d live-view upgrade, not required for the polled form.
 */
export class DirectoryLensItem extends Lens {
  constructor(
    id: string,
    target: string,
    public listing: string,             // sorted entries, one per line (producer-supplied)
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

  protected substrateTag(): string { return "dir"; }
  override extentLines(): number | undefined { return this.listing === "" ? 0 : this.listing.split("\n").length; }

  protected sliceRange(a: number, b: number): string {
    const lines = this.listing.split("\n");
    return lines.slice(a - 1, b).map((l, i) => `${a + i}| ${l}`).join("\n");
  }
}
