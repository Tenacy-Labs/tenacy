/**
 * The agentic loop — ADR-0002 §1, on the microkernel.
 *
 * drain steering → store.update → render (solver decides) → model call →
 * journal reply → cacheModel.calibrate(usage) → incumbent update.
 * Tools execute at the coordinator (proposer/applier split, 0002g/K7).
 */
import type { ContextItem, Placement, RenderOption, RenderResult, Zone } from "./types.ts";
import type { ParamSet } from "./params.ts";
import { ContextStore } from "./store.ts";
import { render, estTokens } from "./renderer.ts";
import { solve } from "./solver.ts";
import { CacheModel } from "./cache-model.ts";
import { Ledger } from "./ledger.ts";
import type { Provider } from "./providers.ts";
import { GoalItem, FileLensItem, NoticeItem } from "./items.ts";
import { executeIntent, bindHost, type SteeringIntent } from "./intents.ts";
import { dreamPass } from "./dream.ts";

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
  private incumbent: {
    rendered: Map<string, { position: number; zone: Zone; digest: string; representation: string; optionId: string }>;
    totalTokens: number;
  } = { rendered: new Map(), totalTokens: 0 };
  turn = 0;
  interrupts: SteeringIntent[] = [];

  constructor(
    private provider: Provider,
    private ps: ParamSet,
    private ledger: Ledger | null = null,
    private hooks: AgentHooks = {},
  ) {
    this.cacheModel = new CacheModel(ps.cache);
    bindHost({
      fileLens: (t) => this.fileLens(t),
      goal: (id) => this.goalRegistry.get(id),
      setGoal: (g) => this.registerGoal(g),
    });
  }

  steer(intent: SteeringIntent): void {
    this.interrupts.push(intent);
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
        const err = new NoticeItem(`err:${this.store.turn}:${s.op}`, "error", `${s.op}: ${r.result}`);
        this.store.add(err.toContextItem());
      }
    }

    this.store.nextTurn();
    this.turn = this.store.turn;
    this.store.add(makeTurnItem(`turn-${this.turn}-user`, "user", userMessage, this.turn));

    const snap = this.store.snapshot();
    const solved = solve(snap, this.incumbent, this.ps, this.turn);
    const rr = render(solved.placements, snap, this.ps);
    this.hooks.onRender?.(rr, this.ps);

    const expected = this.cacheModel.expectedHit(rr.blocks);
    const response = await this.provider.call(rr.blocks, userMessage);

    this.store.add(makeTurnItem(`turn-${this.turn}-model`, "model", response.text, this.turn));

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
          const err = new NoticeItem(`err:${this.store.turn}:${intent.op}`, "error", `${intent.op}: ${r.result}`);
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

    this.incumbent = {
      rendered: new Map(rr.placements.map((p) => [p.id, {
        position: p.position, zone: p.zone, digest: p.digest,
        representation: p.representation, optionId: p.optionId,
      }])),
      totalTokens: rr.blocks.reduce((s, b) => s + b.tokens, 0),
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
  registerGoal(g: GoalItem): void {
    this.goalRegistry.set(g.id, g);
    g.lastTouchTurn = this.store.turn;
    g.createdTurn = this.store.turn;
    this.store.add(g.toContextItem());
  }
  fileLens(target: string): FileLensItem {
    const id = `lens:${target}`;
    let f = this.fileRegistry.get(id);
    if (f === undefined) {
      const content = this.fileContent(target);
      if (content === "") throw new Error(`no such file: ${target}`);
      f = new FileLensItem(id, target, content);
      f.lastTouchTurn = this.store.turn;
      f.createdTurn = this.store.turn;
      this.fileRegistry.set(id, f);
      this.store.add(f.toContextItem());
    }
    return f;
  }
  private fileRegistry = new Map<string, FileLensItem>();
  /** Content provider — injectable; default reads nothing. */
  fileContent: (target: string) => string = () => "";
}

export function makeTurnItem(id: string, role: "user" | "model", text: string, turn: number): ContextItem {
  const line = `[${role}] ${text}`;
  const item: ContextItem = {
    id, kind: "episodic", velocity: "stable", immutable: true,
    tokens: estTokens(line),
    serialize: () => line,
    options: () => {
      const opts: RenderOption[] = [{
        id: "verbatim", zones: ["evolving"], representation: "VERBATIM",
        tokens: estTokens(line), purelyAdditive: true, text: line,
      }];
      if (item.summary !== undefined) {
        opts.push({
          id: "summary", zones: ["foundational"], representation: "SUMMARY",
          tokens: estTokens(item.summary), purelyAdditive: false,
          text: `[${role}] [summary] ${item.summary}`,
        });
      }
      return opts;
    },
    lastTouchTurn: turn, createdTurn: turn, summary: undefined,
  };
  return item;
}
