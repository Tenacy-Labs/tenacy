/**
 * Concrete ContextItems with their option surfaces (ADR-0002 §2, 0002b §5, 0004 §5–6).
 *
 * Every item presents ≥1 rendering option; where possible one is purely
 * additive (backward-consistent — appends only, preserves the KV prefix).
 * The option space carries the policy; the solver carries the tradeoff.
 */
import type { ConvoRep, ContextItem, ItemKind, LensState, RenderOption, Velocity, Zone } from "./types.ts";
import { estTokens } from "./renderer.ts";

export { FileLensItem, Lens, DirectoryLensItem } from "./lens.ts";

export function opt(id: string, zones: readonly Zone[], representation: RenderOption["representation"], text: string, purelyAdditive: boolean): RenderOption {
  return { id, zones, representation, tokens: estTokens(text), purelyAdditive, text };
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
      // Multi-period honesty (2026-08-22): the compact form is a LOSSY
      // truncation (60 chars) — typed SUMMARY so the A6 fidelity penalty and
      // qLossy price its future stream. Typed AS_IS it rode at full
      // realization while costing less seat, undercutting the full goal in
      // identity — goals stopped riding identity (goal-zone test failure).
      opt("active-compact", ["foundational"], "SUMMARY", `[g] ${this.text.slice(0, 60)}`, false),
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
  summary?: string | undefined;
  rep: ConvoRep = "VERBATIM";
  /** MERGED: if set, this turn renders inside the merge-group item instead. */
  mergedInto?: string | undefined;
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
    if (this.mergedInto !== undefined) {
      // member of a merge group: the group carries the bytes. in-merge is a
      // zeroValue 0-byte ride (no content, no value, no free FV); verbatim
      // stays available — the coupling pass swaps to it when the group does
      // NOT carry (purged/dropped), so member content never vanishes with
      // the group's tombstone.
      const inMerge = opt("in-merge", ["evolving"], "MERGED", "", false);
      inMerge.zeroValue = true;
      return [
        inMerge,
        opt("verbatim", ["evolving"], "VERBATIM", `[${this.role}] ${this.#verbatim}`, true),
      ];
    }
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
      // ADR-0006 §3 (review C-C1): the turn's verbatim never leaves the
      // store — SUMMARY renders (dream output) stay re-expandable.
      recoverability: "verbatim-preserving",
    };
  }
}

/**
 * MergeGroup — one lightweight-LLM transform combining several contiguous
 * turns (ADR-0002f §2 MERGED). Members keep verbatim in the store; the
 * group item carries the merged representation; boundaries chosen by the
 * dream pass (v1: contiguous runs of aged turns).
 */
export class MergeGroupItem {
  /**
   * Value mass: the SUM of member values at merge time (multi-period pass
   * 2026-08-22). A group carrying eight members' content has eight members'
   * value — a single episodic profile on the group undercounts the mass and
   * structurally biases against transforms ever amortizing. The group's own
   * decay clock is fresh (the transform re-presents aged content).
   */
  valueMass = 0;
  constructor(
    public readonly id: string,          // "merge:3-6"
    public readonly memberIds: readonly string[],
    public text: string,                 // the merged representation
    public createdTurn = 0,
  ) {}
  get tokens(): number { return estTokens(this.#header() + this.text); }
  #header(): string { return `⟨merged ${this.memberIds[0]}..${this.memberIds[this.memberIds.length - 1]}⟩`; }
  serialize(): string { return this.#header() + "\n" + this.text; }
  options(): RenderOption[] {
    const purge = opt("purge", ["volatile"], "PURGED",
      `⟨merged ${this.memberIds[0]}..${this.memberIds[this.memberIds.length - 1]}: purged; convo.reexpand restores verbatim⟩`, false);
    purge.zeroValue = true;   // handle only — re-expand pays the writeback
    return [
      opt("merged", ["foundational"], "MERGED", this.serialize(), false),
      purge,
    ];
  }
  toContextItem(): ContextItem {
    return {
      id: this.id, kind: "episodic", velocity: "stable", immutable: false,
      tokens: this.tokens, serialize: () => this.serialize(), options: () => this.options(),
      upstreams: this.memberIds, lastTouchTurn: this.createdTurn, createdTurn: this.createdTurn,
      watch: "frozen", valueMass: this.valueMass,
      // ADR-0006 §3 (review C-C1): merge groups keep every member's verbatim
      // in the store — the MERGED render is re-expandable to full value.
      recoverability: "verbatim-preserving",
    };
  }
}

/**
 * FileLens — the worked example (ADR-0002 §3): coalesced line ranges, one
 * entry however many reads. Options present compact-head + distributed
 * (BASE+DELTA) alternatives — the A4 ruling made concrete: the solver
 * trades cache invalidation against content length, not a hard-coded rule.
 */
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
