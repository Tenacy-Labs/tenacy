/**
 * Concrete ContextItems with their option surfaces (ADR-0002 §2, 0002b §5, 0004 §5–6).
 *
 * Every item presents ≥1 rendering option; where possible one is purely
 * additive (backward-consistent — appends only, preserves the KV prefix).
 * The option space carries the policy; the solver carries the tradeoff.
 */
import type { ConvoRep, ContextItem, ItemKind, LensState, RenderOption, Velocity, Zone } from "./types.ts";
import { estTokens } from "./renderer.ts";

function opt(id: string, zones: readonly Zone[], representation: RenderOption["representation"], text: string, purelyAdditive: boolean): RenderOption {
  return { id, zones, representation, tokens: estTokens(text), purelyAdditive };
}

/** Identity / directive — standing context, cache-pinned head. */
export class StandingItem {
  #text: string;
  constructor(
    public readonly id: string,
    public readonly kind: "identity" | "directive",
    text: string,
    public velocity: Velocity = "frozen",
    public immutable = true,
    public upstreams: readonly string[] = [],
    public hazardOverride?: number,
    public valueBump?: { amount: number; untilTurn: number },
    public watch: "live" | "polled" | "frozen" = "frozen",
    public lastRender?: { position: number; digest: string },
    public lastTouchTurn = 0,
    public createdTurn = 0,
  ) {
    this.#text = text;
  }
  get tokens(): number { return estTokens(this.#text); }
  serialize(): string { return this.#text; }
  options(): RenderOption[] {
    return [opt("as-is", ["identity", "foundational"], "AS_IS", this.#text, true)];
  }
  toContextItem(): ContextItem {
    return {
      id: this.id, kind: this.kind, velocity: this.velocity, immutable: this.immutable,
      tokens: this.tokens, serialize: () => this.#text, options: () => this.options(),
      upstreams: this.upstreams, lastRender: this.lastRender, lastTouchTurn: this.lastTouchTurn,
      createdTurn: this.createdTurn, hazardOverride: this.hazardOverride, valueBump: this.valueBump,
      watch: this.watch,
    };
  }
}

/** Goal — hierarchical, decay-exempt while active (ADR-0002f §3). */
export class GoalItem {
  text: string;
  status: "active" | "completed" = "active";
  constructor(
    public readonly id: string,
    text: string,
    public parentId?: string,
    public horizon: "session" | "task" | "standing" = "task",
    public velocity: Velocity = "stable",
    public immutable = false,
    public upstreams: readonly string[] = [],
    public hazardOverride?: number,
    public valueBump?: { amount: number; untilTurn: number },
    public watch: "live" | "polled" | "frozen" = "frozen",
    public lastRender?: { position: number; digest: string },
    public lastTouchTurn = 0,
    public createdTurn = 0,
  ) {
    this.text = text;
  }
  get tokens(): number { return estTokens(`[goal:${this.horizon}] ${this.text} (${this.status})`); }
  serialize(): string {
    return this.status === "active"
      ? `[goal:${this.horizon}] ${this.text}`
      : `[done] ${this.text}`;
  }
  options(): RenderOption[] {
    if (this.status === "completed") {
      // completed → episodic record, decay resumes (0002f §3); one-line marker only
      return [opt("done-marker", ["foundational"], "AS_IS", this.serialize(), true)];
    }
    return [
      opt("active-full", ["identity"], "AS_IS", this.serialize(), true),
      opt("active-compact", ["foundational"], "AS_IS", `[g] ${this.text.slice(0, 60)}`, false),
    ];
  }
  toContextItem(): ContextItem {
    return {
      id: this.id, kind: "goal", velocity: this.velocity, immutable: this.immutable,
      tokens: this.tokens, serialize: () => this.serialize(), options: () => this.options(),
      upstreams: this.upstreams, lastRender: this.lastRender, lastTouchTurn: this.lastTouchTurn,
      createdTurn: this.createdTurn, hazardOverride: this.hazardOverride, valueBump: this.valueBump,
      watch: this.watch,
    };
  }
}

/** Episodic turn record — immutable; the conversation lens substrate (ADR-0002f §2). */
export class TurnItem {
  #verbatim: string;
  summary?: string;
  rep: ConvoRep = "VERBATIM";
  constructor(
    public readonly id: string,          // "turn-41"
    public readonly role: "model" | "tool-result" | "user",
    verbatim: string,
    public velocity: Velocity = "stable",
    public immutable = true,
    public upstreams: readonly string[] = [],
    public hazardOverride?: number,
    public valueBump?: { amount: number; untilTurn: number },
    public watch: "live" | "polled" | "frozen" = "frozen",
    public lastRender?: { position: number; digest: string },
    public lastTouchTurn = 0,
    public createdTurn = 0,
  ) {
    this.#verbatim = verbatim;
  }
  get verbatim(): string { return this.#verbatim; }
  get tokens(): number { return estTokens(this.#verbatim); }
  serialize(): string {
    const body = this.rep === "VERBATIM" || this.summary === undefined ? this.#verbatim : `[summary of ${this.id}] ${this.summary}`;
    return `[${this.role}] ${body}`;
  }
  /** Conversation-lens options: VERBATIM (additive), SUMMARY (rewrite, penalized by A6 ramp). */
  options(): RenderOption[] {
    const opts: RenderOption[] = [
      opt("verbatim", ["evolving"], "VERBATIM", `[${this.role}] ${this.#verbatim}`, true),
    ];
    if (this.summary !== undefined) {
      opts.push(opt("summary", ["foundational"], "SUMMARY", `[${this.role}] [summary] ${this.summary}`, false));
    }
    return opts;
  }
  toContextItem(): ContextItem {
    return {
      id: this.id, kind: "episodic", velocity: this.velocity, immutable: this.immutable,
      tokens: this.tokens, serialize: () => this.serialize(), options: () => this.options(),
      upstreams: this.upstreams, lastRender: this.lastRender, lastTouchTurn: this.lastTouchTurn,
      createdTurn: this.createdTurn, hazardOverride: this.hazardOverride, valueBump: this.valueBump,
      watch: this.watch,
    };
  }
}

/**
 * FileLens — the worked example (ADR-0002 §3): coalesced line ranges, one
 * entry however many reads. Options present compact-head + distributed
 * (BASE+DELTA) alternatives — the A4 ruling made concrete: the solver
 * trades cache invalidation against content length, not a hard-coded rule.
 */
export class FileLensItem {
  /** Coalesced ranges actually loaded, sorted. */
  ranges: Array<[number, number]> = [];
  baseBlockTurn = -1;   // when the base block was written (-1: no base yet)
  state: LensState = "FULL";
  constructor(
    public readonly id: string,          // "lens:src/kernel.ts"
    public readonly target: string,      // fs path
    public content: string,             // current file content (producer-supplied)
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

  #lines(): string[] { return this.content.split("\n"); }

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

  #selectedText(): string {
    const lines = this.#lines();
    return this.ranges
      .map(([a, b]) => lines.slice(a - 1, b).map((l, i) => `${a + i}| ${l}`).join("\n"))
      .join("\n...\n");
  }

  serialize(): string { return this.#fullText(); }

  #fullText(): string {
    return `⟨file ${this.target} ${this.ranges.length} range(s)⟩\n${this.#selectedText()}`;
  }
  #deltaText(): string {
    return `⟨file ${this.target} +Δ⟩\n${this.#selectedText()}`;
  }

  /**
   * The option surface (A4/A5): compact front block vs distributed
   * deltas vs consolidation vs purge. The solver picks per turn.
   */
  options(): RenderOption[] {
    if (this.ranges.length === 0) return [];   // nothing loaded — presents no options
    const full = this.#fullText();
    const compact = `⟨file ${this.target}: ${this.ranges.length} range(s), ${this.ranges.map(([a, b]) => `${a}-${b}`).join(",")}⟩`;
    const opts: RenderOption[] = [];
    if (this.baseBlockTurn < 0) {
      // no base yet: FULL is the (only) additive first write
      opts.push(opt("full", ["stable"], "FULL", full, true));
      opts.push(opt("compact-full", ["stable"], "FULL", compact, false));
    } else {
      // base exists: deltas are the additive path; re-consolidation is a rewrite
      opts.push(opt("base+delta", ["stable"], "BASE+DELTA", this.#deltaText(), true));
      opts.push(opt("consolidated", ["stable"], "CONSOLIDATED", full, false));
      opts.push(opt("compact", ["foundational"], "FULL", compact, false));
    }
    if (this.tokens > 1500) {
      opts.push(opt("purge", ["volatile"], "PURGED", `⟨file ${this.target}: purged; re-expand on demand⟩`, false));
    }
    return opts;
  }

  get tokens(): number { return estTokens(this.#fullText()); }
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

/** Notice / error evidence — transient tail items (error: A1 slow-decay profile). */
export class NoticeItem {
  constructor(
    public readonly id: string,
    public readonly kind: "notice" | "error",
    public readonly text: string,
    public velocity: Velocity = "volatile",
    public immutable = false,
    public upstreams: readonly string[] = [],
    public hazardOverride?: number,
    public valueBump?: { amount: number; untilTurn: number },
    public watch: "live" | "polled" | "frozen" = "frozen",
    public lastRender?: { position: number; digest: string },
    public lastTouchTurn = 0,
    public createdTurn = 0,
  ) {}
  get tokens(): number { return estTokens(this.text); }
  serialize(): string {
    return this.kind === "error" ? `[error-evidence] ${this.text}` : `[notice] ${this.text}`;
  }
  options(): RenderOption[] {
    return [opt(this.kind === "error" ? "error-ev" : "notice", ["evolving"], "AS_IS", this.serialize(), true)];
  }
  toContextItem(): ContextItem {
    return {
      id: this.id, kind: this.kind, velocity: this.velocity, immutable: this.immutable,
      tokens: this.tokens, serialize: () => this.serialize(), options: () => this.options(),
      upstreams: this.upstreams, lastRender: this.lastRender, lastTouchTurn: this.lastTouchTurn,
      createdTurn: this.createdTurn, hazardOverride: this.hazardOverride, valueBump: this.valueBump,
      watch: this.watch,
    };
  }
}
