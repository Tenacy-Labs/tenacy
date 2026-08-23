/**
 * The agentic loop — ADR-0002 §1, on the microkernel.
 *
 * drain steering → store.update → render (solver decides) → model call →
 * journal reply → cacheModel.calibrate(usage) → incumbent update.
 * Tools execute at the coordinator (proposer/applier split, 0002g/K7).
 */
import type { Block, ContextItem, Placement, RenderOption, RenderResult, Zone, LensState } from "./types.ts";
import type { ParamSet } from "./params.ts";
import { ContextStore } from "./store.ts";
import { render, estTokens } from "./renderer.ts";
import { solve } from "./solver.ts";
import { CacheModel } from "./cache-model.ts";
import { Ledger } from "./ledger.ts";
import type { Provider } from "./providers.ts";
import { GoalItem, FileLensItem, DirectoryLensItem, NoticeItem, TurnItem, Lens } from "./items.ts";
import { CodeLensItem } from "./code-lens.ts";
import { NSLensItem, type NamespaceProducer } from "./ns-lens.ts";
import { executeIntent, bindHost, type SteeringIntent } from "./intents.ts";
import { dreamPass } from "./dream.ts";
import { TurnBoundaryWatcher, applyDeltaToLens, type LensDelta } from "./live-views.ts";

export type { SteeringIntent } from "./intents.ts";

export interface TurnOutcome {
  turn: number;
  modelText: string;
  toolResults: Array<{ op: string; ok: boolean; result: string }>;
  renderTokens: number;
  cacheExpectedHit: number;
  cacheLedger: ReturnType<CacheModel["calibrate"]>;
  placements: Placement[];
}

export interface AgentHooks {
  onRender?(rr: RenderResult, ps: ParamSet): void;
  onTurn?(o: TurnOutcome): void;
}

export class AgentLoop {
  readonly store = new ContextStore();
  readonly cacheModel: CacheModel;
  private failedIntents = 0;
  private incumbent: {
    rendered: Map<string, { position: number; zone: Zone; digest: string; representation: string; optionId: string }>;
    totalTokens: number;
    blockCount: number;
    standingMassDrift?: number | undefined;
    blockMass?: readonly number[] | undefined;
    blockWriteTurns?: readonly number[] | undefined;
  } = { rendered: new Map(), totalTokens: 0, blockCount: 0 };
  /** ADR-0006 §5: EWMA state for the standing-mass drift a_t. */
  private driftEwmaState: number | undefined;
  turn = 0;
  interrupts: SteeringIntent[] = [];

  /** EWMA update for a_t (β = 0.7); returns undefined until a first sample. */
  private driftEwma(sample: number | undefined): number | undefined {
    if (sample === undefined) return this.driftEwmaState;
    this.driftEwmaState = this.driftEwmaState === undefined
      ? sample
      : 0.7 * this.driftEwmaState + 0.3 * sample;
    return this.driftEwmaState;
  }

  constructor(
    private provider: Provider,
    private ps: ParamSet,
    private ledger: Ledger | null = null,
    private hooks: AgentHooks = {},
  ) {
    this.cacheModel = new CacheModel(ps.cache);
    bindHost({
      fileLens: (t) => this.fileLens(t),
      dirLens: (t) => this.dirLens(t),
      codeLens: (t) => this.codeLens(t),
      nsLens: (t) => this.nsLens(t),
      convoTurn: (id) => this.convoTurn(id),
      addStoreItem: (it) => { this.store.add(it.toContextItem()); },
      goal: (id) => this.goalRegistry.get(id),
      setGoal: (g) => this.registerGoal(g),
    });
  }

  steer(intent: SteeringIntent): void {
    this.interrupts.push(intent);
  }

  /** Test/introspection surface: current per-block write turns (§4 TTL provenance). */
  incumbentWriteTurns(): readonly number[] {
    return this.incumbent.blockWriteTurns ?? [];
  }

  async run(userMessage: string): Promise<TurnOutcome> {
    const steering = this.interrupts.splice(0);
    const toolResults: TurnOutcome["toolResults"] = [];
    for (const s of steering) {
      let r: { op: string; ok: boolean; result: string };
      try {
        r = executeIntent(s, this.store, this.ledger);
      } catch (e) {
        r = { op: s.op, ok: false, result: String(e) };
      }
      toolResults.push(r);
      if (!r.ok) {
        // A1 (0004 §2): failures classed as error evidence at journal time —
        // estimators always need them as calibration labels, not console noise.
        // Id includes an attempt counter: the same op failing twice in one
        // turn (retry loop, repeated probe) must not collide on the store's
        // duplicate-id check. A1: failures stay distinct evidence.
        const errId = `err:${this.store.turn}:${s.op}:${this.failedIntents++}`;
        const err = new NoticeItem(errId, "error", `${s.op}: ${r.result}`);
        this.store.add(err.toContextItem());
      }
    }

    this.store.nextTurn();
    this.turn = this.store.turn;
    const userItem = makeTurnItem(`turn-${this.turn}-user`, "user", userMessage, this.turn);
    this.turnRegistry.set(userItem.id, userItem as unknown as TurnItem);
    this.store.add(userItem);

    // Finer splits: materialize split-mode fragments (one item per range)
    // before solving — they join the snapshot as independent items.
    this.materializeFragments();

    // Live views (0002d §5): drain watcher events at the turn-boundary safe
    // point — BEFORE solve/render so tail notices ride THIS turn's render.
    const tailNotices: string[] = [];
    if (this.watcher !== null) {
      for (const d of this.watcher.drain(this.turn)) {
        const lens = this.lensRegistry.get(d.lensId);
        if (lens !== undefined) {
          applyDeltaToLens(lens, d, this.turn);
          // Review B-5 fix (2026-08-23): the drain loop fed markers, hazard,
          // churn, and notices — everything EXCEPT the lattice. noteLiveDelta
          // had zero production callers: pendingDeltas stayed empty forever
          // and the consolidation lattice never armed past base. Line
          // numbers are not derivable from a path-bearing FS event, so v1
          // records the COARSE delta: affected lines = the lens's range
          // union. The snapshot defaults to the live substrate slice (fresh
          // at drain by construction — refresh ran at event time), so the
          // fusion/chain bodies stay byte-honest; only affected-line
          // granularity is coarse until producers supply real line sets.
          const lv = lens as unknown as {
            noteLiveDelta?: (t: number, l: number[]) => void;
            ranges?: Array<[number, number]>;
          };
          if (typeof lv.noteLiveDelta === "function" && lv.ranges !== undefined && lv.ranges.length > 0) {
            const lo = Math.min(...lv.ranges.map((r) => r[0]));
            const hi = Math.max(...lv.ranges.map((r) => r[1]));
            const lines: number[] = [];
            for (let li = lo; li <= hi; li++) lines.push(li);
            lv.noteLiveDelta(this.turn, lines);
          }
          // Churn pricing (0002d §5): observed hazard feeds the lens item —
          // the solver, not a hard threshold, decides what thrash costs.
          // Both the registry object AND the store's ContextItem copy must
          // see it (items snapshot fields by value at toContextItem time).
          const obs = this.watcher.observedHazardOf(d.lensId);
          if (obs > 0) {
            (lens as unknown as { hazardOverride?: number }).hazardOverride = obs;
            const storeItem = this.store.get(d.lensId);
            if (storeItem !== undefined) (storeItem as unknown as { hazardOverride?: number }).hazardOverride = obs;
          }
          // ChurnProfile promotion (ADR-0006 §2.3): churn leaves its
          // watcher-local silo and becomes an item property, so the FV
          // stream prices content renewal. Same dual-write as hazard —
          // registry object + store copy (fields snapshot by value).
          const churnE = this.watcher.churnOf(d.lensId);
          const churnProfile = { ewmaChurn: churnE, lastChangeTurn: this.turn };
          (lens as unknown as { churnProfile?: { ewmaChurn: number; lastChangeTurn: number } }).churnProfile = churnProfile;
          const storeItem2 = this.store.get(d.lensId);
          if (storeItem2 !== undefined) (storeItem2 as unknown as { churnProfile?: { ewmaChurn: number; lastChangeTurn: number } }).churnProfile = churnProfile;
        }
        tailNotices.push(TurnBoundaryWatcher.tailNotice(d));
        this.ledger?.recordSignal({ type: "live-delta", itemId: d.lensId, markers: d.markers, coalesced: d.coalescedEvents, turn: this.turn });
        if (this.watcher.shouldDemote(d.lensId)) {
          const lens2 = this.lensRegistry.get(d.lensId);
          if (lens2 !== undefined && lens2.watch === "live") {
            lens2.watch = "polled";  // optimizer flip — never feeds value decay (§7)
            this.ledger?.recordSignal({ type: "churn-demotion", itemId: d.lensId, churn: this.watcher.churnOf(d.lensId), turn: this.turn });
          }
        }
      }
    }

    const snap = this.store.snapshot();
    const solved = solve(snap, this.incumbent, this.ps, this.turn);
    const rr = render(solved.placements, snap, this.ps, tailNotices);
    this.lastRender = rr;

    // Consolidation ratchet (Daniel ruling 2026-08-22): a chosen lattice
    // option permanently consumes the pending deltas — the lens folds them
    // into its base and retires the finer-grained states. Commit AFTER the
    // render so the chosen option's bytes were priced from live state.
    // Base arming (2026-08-22 adversarial battery): commit on EVERY placed
    // lens, not only when deltas pend — otherwise a mid-session attach can
    // never establish its base (pendingDeltas starts empty; the gate made
    // arming unreachable and noteLiveDelta a permanent no-op).
    for (const p of solved.placements) {
      const lens = this.lensRegistry.get(p.id);
      if (lens !== undefined && (lens.pendingDeltas.length > 0 || lens.baseBlockTurn < 0)) {
        lens.commitConsolidation(p.optionId, this.turn);
      }
    }

    this.hooks.onRender?.(rr, this.ps);

    const expected = this.cacheModel.expectedHit(rr.blocks);
    const response = await this.callWithRetry(rr.blocks, userMessage);

    const modelItem = makeTurnItem(`turn-${this.turn}-model`, "model", response.text, this.turn);
    this.turnRegistry.set(modelItem.id, modelItem as unknown as TurnItem);
    this.store.add(modelItem);

    // Model-proposed intents execute at the coordinator (proposer/applier split)
    if (response.intents !== undefined) {
      for (const intent of response.intents) {
        let r: { op: string; ok: boolean; result: string };
        try {
          r = executeIntent(intent, this.store, this.ledger);
        } catch (e) {
          r = { op: intent.op, ok: false, result: String(e) };
        }
        toolResults.push(r);
        if (!r.ok) {
          // A1 (0004 §2): failures classed as error evidence at journal time.
          const errId = `err:${this.store.turn}:${intent.op}:${this.failedIntents++}`;
          const err = new NoticeItem(errId, "error", `${intent.op}: ${r.result}`);
          this.store.add(err.toContextItem());
        }
      }
    }

    // Dream pass: aged episodic items gain SUMMARY options (0002f §4) —
    // off the hot path; the solver will price them next render.
    const dreamt = dreamPass(this.store.all(), this.turn, 3);
    if (dreamt.length > 0) this.ledger?.recordSignal({ type: "dream-pass", count: dreamt.length, turn: this.turn });

    const cl = this.cacheModel.calibrate(rr.blocks, response.usage, expected);
    this.cacheModel.update(rr.blocks);
    this.ledger?.recordTurn(rr, this.ps, this.turn, solved.itemLedgers);
    this.ledger?.recordCache(cl);
    // Review A-minor-4: shared-bill credit is journaled, never a selection
    // input — but it never reached the Ledger at all. Signal it per turn.
    if (solved.sharedBillCredit !== 0) {
      this.ledger?.recordSignal({ type: "shared-bill-credit", credit: solved.sharedBillCredit, turn: this.turn });
    }

    // Review M5/B12/B20: write turns carry FORWARD for digest-identical
    // blocks — a byte-identical keep does not re-write the KV block, so
    // its TTL age is the ORIGINAL write. Only changed/new blocks stamp
    // the current turn. (Sliding-TTL refresh-on-read semantics would make
    // the §4 expiry branch dead code; honest write provenance instead.)
    const prevWriteTurns = this.incumbent.blockWriteTurns;
    const prevChain = new Map<string, number>();
    const prevMass = this.incumbent.blockMass;
    const prevMassMap = new Map<string, number>();
    // Review B-3 fix (2026-08-23): carry-forward must be keyed by the
    // PREVIOUS chain's digests, not zipped positionally against the NEW
    // chain. cacheModel.update() already ran (line ~221): believedChain()
    // here is the new layout. Positional zip of new-chain digests against
    // old write-turns shifts provenance on any non-prefix change — a
    // mid-chain insertion stamps the freshest block with an old turn (TTL
    // inversion). The previous chain is the incumbent's own digests; we
    // recover them from the rendered map (the incumbent's blocks in order).
    const prevDigests = [...this.incumbent.rendered.values()].map((r) => r.digest);
    if (prevWriteTurns !== undefined) {
      prevDigests.forEach((d, i) => {
        const wt = prevWriteTurns[i];
        if (wt !== undefined) prevChain.set(d, wt);
      });
    }
    if (prevMass !== undefined) {
      prevDigests.forEach((d, i) => prevMassMap.set(d, prevMass[i] ?? 0));
    }
    this.incumbent = {
      rendered: new Map(rr.placements.map((p) => [p.id, {
        position: p.position, zone: p.zone, digest: p.digest,
        representation: p.representation, optionId: p.optionId,
      }])),
      totalTokens: rr.blocks.reduce((s, b) => s + b.tokens, 0),
      blockCount: rr.blocks.length,
      // ADR-0006 §5: EWMA of net standing-mass drift (tokens/turn). ΔW
      // includes restructures (this turn's realized layout mass change is
      // the honest drift signal while we lack per-move attribution).
      standingMassDrift: this.driftEwma(
        this.incumbent.totalTokens > 0
          ? rr.blocks.reduce((s, b) => s + b.tokens, 0) - this.incumbent.totalTokens
          : undefined,
      ),
      blockMass: rr.blocks.map((b) => prevMassMap.get(b.digest) ?? b.tokens),
      blockWriteTurns: rr.blocks.map((b) => prevChain.get(b.digest) ?? this.turn),
    };

    const outcome: TurnOutcome = {
      turn: this.turn,
      modelText: response.text,
      toolResults,
      renderTokens: this.incumbent.totalTokens,
      cacheExpectedHit: expected.hitTokens,
      cacheLedger: cl,
      placements: rr.placements,
    };
    this.hooks.onTurn?.(outcome);
    return outcome;
  }

  /** Goal/file item factories for intents. */
  goalItem(id: string): GoalItem | undefined {
    return this.goalRegistry.get(id);
  }
  private goalRegistry = new Map<string, GoalItem>();

  /** Swap the live provider mid-session (REPL /provider). Re-pins the param set per A2. */
  /**
   * Transient-failure recovery: retry provider calls with exponential
   * backoff (1s, 2s, 4s). Non-transient errors (auth, bad request) and
   * exhaustion rethrow — the surface layer reports them honestly.
   */
  private async callWithRetry(blocks: Block[], userMessage: string, maxAttempts = 3): Promise<Awaited<ReturnType<Provider["call"]>>> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.provider.call(blocks, userMessage);
      } catch (e) {
        lastErr = e;
        const msg = String(e).toLowerCase();
        // Review B-10 fix (2026-08-23): "rate" as a bare substring matched
        // "generate", "moderate", "generate completion" — non-transient auth/
        // bad-request errors retried as if transient. Word-boundary the
        // rate-limit token: match "rate limit"/"rate-limit"/"rate_limit" or
        // the standalone word, not every word containing the letters.
        const rateHit = /\brate[- _]?limit|\brates\b|\brate\b/.test(msg);
        const transient = msg.includes("429") || rateHit || msg.includes("overload") ||
          msg.includes("502") || msg.includes("503") || msg.includes("504") || msg.includes("timeout") ||
          msg.includes("econnreset") || msg.includes("econnrefused") || msg.includes("fetch failed") ||
          msg.includes("network") || msg.includes("eai_again");
        if (!transient || attempt === maxAttempts) throw e;
        this.ledger?.recordSignal({ type: "provider-retry", turn: this.turn, attempt, error: msg.slice(0, 120) });
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
      }
    }
    throw lastErr;
  }

  swapProvider(provider: Provider, ps: ParamSet): void {
    this.provider = provider;
    this.ps = ps;
  }

  get providerId(): string {
    return this.provider.modelId;
  }
  registerGoal(g: GoalItem): void {
    this.goalRegistry.set(g.id, g);
    g.lastTouchTurn = this.store.turn;
    g.createdTurn = this.store.turn;
    this.store.add(g.toContextItem());
  }
  // ── session persistence surface (sessions.ts is the only consumer) ─────

  /** Read access for session serialization — lenses with live content. */
  lensRegistryView(): ReadonlyMap<string, Lens> { return this.lensRegistry; }
  /** Read access for session serialization — goals. */
  goalRegistryView(): ReadonlyMap<string, GoalItem> { return this.goalRegistry; }

  /** Restore primitives (sessions.ts) — rehydrate without turn-stamp clobber. */
  addRestoredItem(item: ContextItem, createdTurn: number, lastTouchTurn: number): void {
    // Idempotent restore: boot-time standing items (identity) may already
    // exist — the session's copy wins (it carries the saved turn stamps).
    this.store.remove(item.id);
    item.createdTurn = createdTurn;
    item.lastTouchTurn = lastTouchTurn;
    this.store.addRestored(item);
  }
  registerGoalRow(g: GoalItem): void {
    this.store.remove(g.id);
    g.lastTouchTurn = this.store.turn;
    g.createdTurn = this.store.turn;
    this.registerGoal(g);
  }
  addRestoredTurn(id: string, role: "user" | "model" | "tool-result", verbatim: string, summary: string | undefined, rep: string, mergedInto?: string, createdTurn?: number, lastTouchTurn?: number): void {
    this.store.remove(id);
    const t = new TurnItem(id, role, verbatim);
    this.turnRegistry.set(id, t);
    if (summary !== undefined) t.summary = summary;
    if (mergedInto !== undefined) t.mergedInto = mergedInto;
    t.rep = (rep === "SUMMARY" ? "SUMMARY" : "VERBATIM");
    // Review B-2 fix (2026-08-23): restored turns carry their save-time
    // stamps. The old path stamped store.turn (0 during the restore loop —
    // setTurn runs AFTER the rows) and then store.add re-stamped 0: every
    // restored turn arrived as if created this instant, zeroing decay age.
    t.lastTouchTurn = lastTouchTurn ?? this.store.turn;
    t.createdTurn = createdTurn ?? this.store.turn;
    // addRestored, not add: add() re-stamps created/lastTouch to the CURRENT
    // store turn — during restore that is 0, clobbering what we just set.
    this.store.addRestored(t.toContextItem());
  }
  attachLens(id: string, target: string, ranges: Array<[number, number]>, baseBlockTurn: number, state: LensState, tag?: string, extra?: { selected?: string[] | undefined; prefixes?: string[] | undefined; projection?: string | undefined }): void {
    let f: Lens;
    if (tag === "dir") {
      const listing = this.dirListing(target);
      if (listing === "") return;
      f = new DirectoryLensItem(id, target, listing);
    } else if (tag === "code") {
      const content = this.fileContent(target.replace(/^code:/, ""));
      if (content === "") return;
      const c = new CodeLensItem(id, target, content);
      if (extra?.selected !== undefined) c.selected = extra.selected;
      f = c;
    } else if (tag === "ns") {
      const producer = this.nsProducer(target);
      if (producer === null) return;
      const n = new NSLensItem(id, target, producer);
      if (extra?.prefixes !== undefined) n.prefixes = extra.prefixes;
      if (extra?.projection !== undefined) n.projection = extra.projection as "structure" | "content";
      f = n;
    } else {
      const content = this.fileContent(target);
      if (content === "") return;
      f = new FileLensItem(id, target, content);
    }
    f.ranges = ranges;
    f.baseBlockTurn = baseBlockTurn;
    f.state = state;
    f.lastTouchTurn = this.store.turn;
    f.createdTurn = this.store.turn;
    this.lensRegistry.set(id, f);
    this.store.add(f.toContextItem());
  }
  setTurn(turn: number): void {
    this.store.turn = turn;
  }

  codeLens(target: string): CodeLensItem {
    // Review B-12 fix (2026-08-23): canonicalize the target — a bare path and
    // a code:-prefixed path previously minted two different lens ids
    // (lens:code:<f> and lens:code:code:<f>) for the same file, splitting
    // watchers, cache blocks, and restore rows across two items.
    const canon = target.replace(/^code:/, "");
    const id = `lens:code:${canon}`;
    let c = this.lensRegistry.get(id);
    if (c === undefined) {
      const content = this.fileContent(canon);
      if (content === "") throw new Error(`no such file: ${canon}`);
      c = new CodeLensItem(id, canon, content);
      c.lastTouchTurn = this.store.turn;
      c.createdTurn = this.store.turn;
      this.lensRegistry.set(id, c);
      this.store.add(c.toContextItem());
    }
    if (!(c instanceof CodeLensItem)) throw new Error(`${id} is not a code lens`);
    return c;
  }
  nsLens(target: string): NSLensItem {
    // target = namespace root name; producer supplies children/commits
    const id = `lens:ns:${target}`;
    let n = this.lensRegistry.get(id);
    if (n === undefined) {
      const producer = this.nsProducer(target);
      if (producer === null) throw new Error(`no namespace producer: ${target}`);
      n = new NSLensItem(id, target, producer);
      n.lastTouchTurn = this.store.turn;
      n.createdTurn = this.store.turn;
      this.lensRegistry.set(id, n);
      this.store.add(n.toContextItem());
    }
    if (!(n instanceof NSLensItem)) throw new Error(`${id} is not a namespace lens`);
    return n;
  }
  /** Namespace producer registry — injectable; default provides nothing. */
  nsProducers = new Map<string, () => NamespaceProducer | null>();
  nsProducer(name: string): NamespaceProducer | null {
    const factory = this.nsProducers.get(name);
    return factory === undefined ? null : factory();
  }
  convoTurn(id: string): { id: string; summary?: string | undefined; mergedInto?: string | undefined; verbatim(): string; markReexpanded(): void } | undefined {
    const t = this.turnRegistry.get(id);
    if (t === undefined) return undefined;
    // Works for both real TurnItem instances and makeTurnItem closure items.
    const anyT = t as unknown as {
      summary?: string | undefined; mergedInto?: string | undefined;
      verbatim?: () => string; markReexpanded?: () => void;
    };
    // Review A-M3: real TurnItems expose `verbatim` as a getter (string),
    // not a method — only live makeTurnItem closures have the function form.
    // Restored sessions register real TurnItems; requiring the function form
    // broke convo.merge / ctx.reexpand across hibernation.
    const v = (t as { verbatim?: (() => string) | string | undefined }).verbatim;
    if (typeof v !== "function" && typeof v !== "string") return undefined;
    return {
      id,
      get summary() { return anyT.summary; },
      set summary(v: string | undefined) { anyT.summary = v; },
      get mergedInto() { return anyT.mergedInto; },
      set mergedInto(v: string | undefined) {
        anyT.mergedInto = v;
        const setter = (t as unknown as { setMergedInto?: (x: string | undefined) => void }).setMergedInto;
        if (setter !== undefined) setter(v);
      },
      // A-M3 cont.: the facade must serve BOTH shapes — call the closure
      // form, return the getter string directly.
      verbatim: () => (typeof anyT.verbatim === "function" ? anyT.verbatim() : anyT.verbatim as unknown as string),
      markReexpanded: () => { if (anyT.markReexpanded !== undefined) anyT.markReexpanded(); t.lastTouchTurn = this.store.turn; },
    };
  }
  private turnRegistry = new Map<string, TurnItem | ReturnType<typeof makeTurnItem>>();

  dirLens(target: string): DirectoryLensItem {
    const id = `lens:${target}`;
    let d = this.lensRegistry.get(id);
    if (d === undefined) {
      const listing = this.dirListing(target);
      if (listing === "") throw new Error(`no such directory: ${target}`);
      d = new DirectoryLensItem(id, target, listing);
      d.lastTouchTurn = this.store.turn;
      d.createdTurn = this.store.turn;
      this.lensRegistry.set(id, d);
      this.store.add(d.toContextItem());
    }
    if (!(d instanceof DirectoryLensItem)) throw new Error(`${id} is not a directory lens`);
    return d;
  }
  /** Directory listing provider — injectable; default reads nothing. */
  dirListing: (target: string) => string = () => "";

  fileLens(target: string): FileLensItem {
    const id = `lens:${target}`;
    let f = this.lensRegistry.get(id);
    if (f === undefined) {
      const content = this.fileContent(target);
      if (content === "") throw new Error(`no such file: ${target}`);
      f = new FileLensItem(id, target, content);
      f.lastTouchTurn = this.store.turn;
      f.createdTurn = this.store.turn;
      this.lensRegistry.set(id, f);
      this.store.add(f.toContextItem());
    }
    if (!(f instanceof FileLensItem)) throw new Error(`${id} is not a file lens`);
    return f;
  }
  /** Unified lens registry — every substrate, keyed by lens id (OOP hierarchy). */
  private lensRegistry = new Map<string, Lens>();

  /**
   * Materialize split fragments: for every lens in split mode, sync its
   * fragment items into the store (add new, update ranges, remove stale).
   * Parent option surface keeps the aggregated alternatives — coupled.
   */
  /**
   * Watcher-driven substrate refresh (0002d §5): re-read the substrate
   * through the producer hooks and update the lens IN PLACE — identity
   * stable, digests recomputed on next options() call. The adapter calls
   * this on every fs event; markers still coalesce per turn.
   */
  refreshLensFromSubstrate(lensId: string): void {
    const lens = this.lensRegistry.get(lensId);
    if (lens === undefined) return;
    const target = lens.target;
    if (lens instanceof DirectoryLensItem) {
      const listing = this.dirListing(target);
      if (listing !== "") lens.listing = listing;
    } else if (lens instanceof CodeLensItem) {
      const content = this.fileContent(target.replace(/^code:/, ""));
      if (content !== "") lens.content = content;
    } else if (lens instanceof NSLensItem) {
      const prod = this.nsProducer(target);
      if (prod?.refresh !== undefined) prod.refresh();
    } else if (lens instanceof FileLensItem) {
      const content = this.fileContent(target);
      if (content !== "") lens.content = content;
    }
  }

  materializeFragments(): void {
    for (const lens of this.lensRegistry.values()) {
      const frags = lens.fragments();
      const want = new Set(frags.map((f) => f.id));
      // remove stale fragments (ranges shrunk/changed)
      for (const id of [...this.store.snapshot().keys()]) {
        if (id.startsWith(`${lens.id}#`) && !want.has(id)) this.store.remove(id);
      }
      for (const f of frags) {
        // Upsert, not add (fresh-context review 2026-08-22): fragments() mints
        // a fresh LensFragmentItem each turn; store.add throws on the second
        // turn of a split lens (duplicate item id: lens:X#1). The store copy
        // must be refreshed, not re-inserted.
        const existing = this.store.get(f.id);
        if (existing !== undefined) this.store.remove(f.id);
        this.store.add(f.toContextItem());
      }
    }
  }
  /** Last render result — exposed for surfaces and tests. */
  lastRender: ReturnType<typeof render> | null = null;

  /** Live-views watcher engine — set by the surface to enable push lenses. */
  watcher: TurnBoundaryWatcher | null = null;
  /** Tail change-notices from the last drain (sequence legibility §6). */
  lastTailNotices: string[] = [];
  /** Content provider — injectable; default reads nothing. */
  fileContent: (target: string) => string = () => "";
}

export function makeTurnItem(id: string, role: "user" | "model", text: string, turn: number): ContextItem {
  const line = `[${role}] ${text}`;
  // Closure state for the convoTurn host proxy (verbatim + merge slot).
  const convo = { verbatim: text, mergedInto: undefined as string | undefined };
  const item: ContextItem = {
    id, kind: "episodic", immutable: true,
    tokens: estTokens(line),
    serialize: () => line,
    options: () => {
      if (convo.mergedInto !== undefined) {
        // member of a merge group: the group carries the representation
        return [{
          id: "in-merge", zones: ["evolving"], representation: "MERGED",
          tokens: estTokens(`[${role}] [merged into ${convo.mergedInto}]`),
          purelyAdditive: false, text: `[${role}] [merged into ${convo.mergedInto}]`,
        }];
      }
      const opts: RenderOption[] = [{
        id: "verbatim", zones: ["evolving"], representation: "VERBATIM",
        tokens: estTokens(line), purelyAdditive: true, text: line,
      }];
      if (item.summary !== undefined) {
        // Price the full rendered block — [role] [summary] prefix included —
        // not the bare summary text (second-pass review finding 2).
        const summaryText = `[${role}] [summary] ${item.summary}`;
        opts.push({
          id: "summary", zones: ["foundational"], representation: "SUMMARY",
          tokens: estTokens(summaryText), purelyAdditive: false,
          text: summaryText,
        });
      }
      return opts;
    },
    lastTouchTurn: turn, createdTurn: turn, summary: undefined,
    // Conversation-lens surface (0002f §2) — closure-backed:
    verbatim: () => convo.verbatim,
    mergedInto: undefined as string | undefined,
    // Review A-minor-2: the closure pins the CREATION turn (module-level fn,
    // no store access) — the convoTurn facade corrects the clock to the
    // STORE's current turn after delegation, so re-expand at logical turn 5
    // leaves lastTouchTurn = 5, not 1.
    markReexpanded: () => { item.lastTouchTurn = turn; },
    setMergedInto: (v: string | undefined) => { convo.mergedInto = v; item.mergedInto = v; },
  };
  return item;
}
