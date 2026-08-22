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
import { opt } from "./items.ts";
import { estTokens } from "./renderer.ts";
import type { ContextItem, LensState, RenderOption } from "./types.ts";

export abstract class Lens {
  /** Coalesced ranges actually loaded, sorted. */
  ranges: Array<[number, number]> = [];
  baseBlockTurn = -1;   // when the base block was written (-1: no base yet)
  state: LensState = "FULL";
  /** ADR-0006 §2.3: content-renewal descriptor (watcher-fed; absent → no renewal credit). */
  churnProfile?: { ewmaChurn: number; lastChangeTurn?: number | undefined } | undefined;
  constructor(
    public readonly id: string,          // "lens:src/kernel.ts"
    public readonly target: string,      // substrate address (fs path, dir, …)
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

  /** Fragment access to substrate slicing (split mode). */
  sliceRangePublic(a: number, b: number): string { return this.sliceRange(a, b); }
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

  // ── live-delta ledger & consolidation lattice (0002d + Daniel ruling
  //    2026-08-22) ─────────────────────────────────────────────────────────
  //
  // Deltas accumulate as a JOURNAL of substrate snapshots. The option
  // surface presents the consolidation lattice over {base, d1..dn}:
  //   base+d1+d2      chain: base bytes + each delta snapshot in commit
  //                   order (sequence-legible); ADDITIVE (appends after
  //                   the base render).
  //   base+(d1,d2)    fusion: base + ONE re-derived block = the OPTIMAL
  //                   rendering of the combined contents (latest-wins over
  //                   the union of affected lines; byte-equal to the fresh
  //                   substrate slice). REWRITE.
  //   (base,d1,d2)    atomic: everything in one fresh block. REWRITE.
  // The solver picks per turn (it alone knows the render context). RATCHET:
  // once a combined option wins, the consolidation is permanent — the
  // consumed deltas are folded into the base and finer-grained states are
  // discarded (the lattice never re-opens downward).
  /** Pending (unconsolidated) live deltas, in commit order. */
  pendingDeltas: Array<{ turn: number; lines: number[]; snapshot: string }> = [];

  /** Record a live substrate change (TurnBoundaryWatcher drain, or LLM
   *  expand() of new ranges while a base exists). `lines` = 1-based
   *  affected line numbers; snapshot = post-change slice of those lines. */
  noteLiveDelta(turn: number, lines: number[], snapshot?: string): void {
    if (this.baseBlockTurn < 0) return;              // no base: FULL is the only first write
    this.pendingDeltas.push({ turn, lines, snapshot: snapshot ?? this.sliceRangePublic(Math.min(...lines), Math.max(...lines)) });
  }

  /** The affected-lines union across all pending deltas (for fusion). */
  private deltaUnion(): Set<number> {
    const u = new Set<number>();
    for (const d of this.pendingDeltas) for (const l of d.lines) u.add(l);
    return u;
  }

  /** Snapshot journal from base through pending deltas — the chain body. */
  private deltaChainText(): string {
    const parts = this.pendingDeltas.map((d) =>
      `+Δ@${d.turn} lines ${Math.min(...d.lines)}-${Math.max(...d.lines)}:\n${d.snapshot}`);
    return parts.join("\n");
  }

  /** Fusion body: latest-wins re-derivation over the affected-lines union.
   *  By construction at the turn boundary this is byte-equal to the fresh
   *  substrate slice over the union — NOT a concatenation of diffs. */
  private deltaFusionText(): string {
    const u = this.deltaUnion();
    const lo = Math.min(...u), hi = Math.max(...u);
    return this.sliceRangePublic(lo, hi);
  }

  /** Ratchet: fold consumed deltas into the base. Permanent. */
  commitConsolidation(choiceId: string, turn: number): void {
    // Base establishment (STRESS A gap, probe-confirmed 2026-08-22): the
    // first committed byte-carrying render CREATES the base the lattice
    // consolidates against. Without it baseBlockTurn stays −1 forever,
    // noteLiveDelta no-ops, and a 5-delta burst renders 'full' x8 with the
    // lattice never arming (probe-burst: identical arms, $3.234 each).
    if (this.baseBlockTurn < 0) {
      if (choiceId === "full" || choiceId === "consolidated") this.baseBlockTurn = turn;
      else return;                    // header-only/fragment picks carry no substrate bytes
      this.pendingDeltas = [];
      return;
    }
    if (this.pendingDeltas.length === 0) return;
    if (choiceId === "full" || choiceId === "consolidated") {
      // base re-written wholesale: nothing pending remains
    } else if (choiceId.startsWith("base+(") || /^\(base,/.test(choiceId)) {
      // fusion-class pick (any arity): base+(d1) / base+(d1,d2,d3) / (base,d1,…)
      // — structural match; the shipped literal-id check silently skipped
      // 1- and 3+-delta fusions, leaving a consumed journal pending
      // (probe-burst 2026-08-22: t7 fusion, t8 still carrying it).
      this.baseBlockTurn = turn;
    } else {
      // chain (base+d1+d2) KEEPS the journal open — choosing the sequential
      // formulation IS the "publish deltas separately" policy; purge/compact/
      // split likewise leave deltas pending. Only a fusion choice consumes
      // (ruling #2). Consuming on chain would make publish-then-fuse
      // unreachable in live flow (probe question 2026-08-22).
      return;
    }
    this.pendingDeltas = [];                          // finer states discarded (ratchet)
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
    if (this.pendingDeltas.length === 0) return `⟨${this.substrateTag()} ${this.target} +Δ⟩\n${this.selectedText()}`;
    return `⟨${this.substrateTag()} ${this.target} +Δ⟩\n${this.deltaChainText()}`;
  }
  /** Fusion: base + re-derived combined block (latest-wins). */
  fusionText(): string {
    if (this.pendingDeltas.length === 0) return this.fullText();
    return `${this.basePrefixText()}\n${this.deltaFusionText()}`;
  }
  /** Bytes the base block holds (post last consolidation). */
  private basePrefixText(): string {
    return `⟨${this.substrateTag()} ${this.target} base@${this.baseBlockTurn}⟩\n${this.selectedText()}`;
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
  /**
   * Render mode (finer splits, 0004/0005 refinement): when "split", the
   * lens presents a tiny header option and each range becomes its own
   * additive fragment item the solver holds/drops independently. The
   * aggregated forms remain available — the parent's consolidated/base+delta
   * options stay on the surface, coupled: choosing one drops fragments.
   */
  renderMode: "aggregated" | "split" = "aggregated";

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
      // base exists: the consolidation lattice over {base, pending deltas}.
      if (this.pendingDeltas.length === 0) {
        // no live deltas: the pre-lattice surface (byte-stable legacy path)
        opts.push(opt("base+delta", ["stable"], "BASE+DELTA", this.deltaText(), true));
        opts.push(opt("consolidated", ["stable"], "CONSOLIDATED", full, false));
      } else {
        const n = this.pendingDeltas.length;
        const dnums = this.pendingDeltas.map((_, i) => `d${i + 1}`).join("+");
        const dlist = this.pendingDeltas.map((_, i) => `d${i + 1}`).join(",");
        // chain: base + each delta snapshot (sequence-legible) — ADDITIVE
        opts.push(opt(`base+${dnums}`, ["stable"], "BASE+DELTA", this.deltaText(), true));
        // fusion: base + ONE re-derived combined block (latest-wins) — REWRITE
        opts.push(opt(`base+(${dlist})`, ["stable"], "CONSOLIDATED", this.fusionText(), false));
        // atomic: everything in one fresh block — REWRITE
        opts.push(opt(`(${["base", ...this.pendingDeltas.map((_, i) => `d${i + 1}`)].join(",")})`, ["stable"], "FULL", full, false));
      }
      if (this.renderMode === "split") {
        // split IS the compact form of a lattice-bearing lens — the parent's
        // aggregated lattice options stay available, coupled: choosing one drops fragments.
        const split = opt("split", ["foundational"], "SPLIT", this.splitHeaderText(), false);
        split.zeroValue = true;   // header-only: handle value, not content value
        opts.push(split);
      } else {
        // types.ts zeroValue contract: "renders no content — scores zero
        // value (purge/compact-head/range-drop)". A compact head carries the
        // re-reference HANDLE (qHandle), never the content's qRendered —
        // pricing it at full value let a content-free header beat every
        // byte-carrying option under tight Λ.
        const comp = opt("compact", ["foundational"], "FULL", compact, false);
        comp.zeroValue = true;
        opts.push(comp);
      }
    }
    if (this.tokens > 1500) {
      const purge = opt("purge", ["volatile"], "PURGED", `⟨${this.substrateTag()} ${this.target}: purged; re-expand on demand⟩`, false);
      purge.zeroValue = true;   // a tombstone renders no content — no value
      opts.push(purge);
    }
    return opts;
  }

  get tokens(): number { return estTokens(this.fullText()); }

  /**
   * Split fragments — one item per selected range (id lens:X#1..N).
   * Each carries range-full (additive) / range-drop options; value
   * prorated by byte share via valueBump on the fragment (the parent's
   * solver value is subtracted in the coupling pass so the family never
   * double-counts against the aggregated options).
   */
  fragments(): LensFragmentItem[] {
    if (this.renderMode !== "split" || this.ranges.length === 0) return [];
    return this.ranges.map((r, i) => new LensFragmentItem(`${this.id}#${i + 1}`, this, r, i));
  }

  /** Header text for split mode — the parent renders ONLY this. */
  splitHeaderText(): string {
    return `⟨${this.substrateTag()} ${this.target}: split into ${this.ranges.length} fragment(s)⟩`;
  }

  /** True when the chosen parent option carries the bytes (aggregated forms). */
  carriesBytes(choice: string): boolean {
    return choice === "full" || choice === "consolidated" || choice === "base+delta" || choice === "split-body";
  }
  toContextItem(): ContextItem {
    return {
      id: this.id, kind: "lens", immutable: this.immutable,
      tokens: this.tokens, serialize: () => this.serialize(), options: () => this.options(),
      upstreams: this.upstreams, lastRender: this.lastRender, lastTouchTurn: this.lastTouchTurn,
      createdTurn: this.createdTurn, hazardOverride: this.hazardOverride, valueBump: this.valueBump,
      watch: this.watch,
      // ADR-0006 §2.3: content-renewal descriptor travels with the snapshot
      // so the solver's FV stream can credit renewal (value decay ≠ content decay).
      churnProfile: this.churnProfile,
      // ADR-0006 §3 (review C-C1): lens bytes are re-readable from the host
      // substrate (file/dir content) — a SUMMARY/compact render is
      // recoverable by re-reading, not lost.
      recoverability: "rereadable",
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
    immutable = false,
    upstreams: readonly string[] = [],
    hazardOverride?: number,
    valueBump?: { amount: number; untilTurn: number },
    watch: "live" | "polled" | "frozen" = "polled",
    lastRender?: { position: number; digest: string },
    lastTouchTurn = 0,
    createdTurn = 0,
  ) {
    super(id, target, immutable, upstreams, hazardOverride, valueBump, watch, lastRender, lastTouchTurn, createdTurn);
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
    immutable = false,
    upstreams: readonly string[] = [],
    hazardOverride?: number,
    valueBump?: { amount: number; untilTurn: number },
    watch: "live" | "polled" | "frozen" = "polled",
    lastRender?: { position: number; digest: string },
    lastTouchTurn = 0,
    createdTurn = 0,
  ) {
    super(id, target, immutable, upstreams, hazardOverride, valueBump, watch, lastRender, lastTouchTurn, createdTurn);
  }

  protected substrateTag(): string { return "dir"; }
  override extentLines(): number | undefined { return this.listing === "" ? 0 : this.listing.split("\n").length; }

  protected sliceRange(a: number, b: number): string {
    const lines = this.listing.split("\n");
    return lines.slice(a - 1, b).map((l, i) => `${a + i}| ${l}`).join("\n");
  }
}


/**
 * LensFragmentItem — one selected range as an independent item (finer
 * splits). Additive range-full keeps the bytes as a separate block; the
 * parent's aggregated options remain coupled alternatives. Value is
 * prorated from the parent profile by byte share.
 */
export class LensFragmentItem {
  constructor(
    public readonly id: string,            // "lens:src/x.ts#3"
    private readonly parent: Lens,
    public readonly range: [number, number],
    public readonly index: number,
    public createdTurn = 0,
  ) {}

  private bodyText(): string {
    return this.parent.sliceRangePublic(this.range[0], this.range[1]);
  }

  options(): RenderOption[] {
    const body = this.bodyText();
    const drop = opt("range-drop", ["volatile"], "SPLIT", "", false);
    drop.zeroValue = true;   // renders nothing — no free value
    return [
      opt("range-full", ["evolving"], "SPLIT", `⟨range ${this.range[0]}-${this.range[1]}⟩\n${body}`, true),
      drop,
    ];
  }

  get tokens(): number { return estTokens(this.bodyText()); }

  /** Byte share of the parent's total — value proration input. */
  byteShare(): number {
    const total = this.parent.tokens;
    return total > 0 ? this.tokens / total : 0;
  }

  toContextItem(): ContextItem {
    return {
      id: this.id, kind: "lens", immutable: false,
      tokens: this.tokens, serialize: () => this.bodyText(), options: () => this.options(),
      upstreams: [this.parent.id], lastTouchTurn: this.parent.lastTouchTurn,
      createdTurn: this.parent.createdTurn, watch: this.parent.watch === undefined ? "polled" : this.parent.watch,
    };
  }
}