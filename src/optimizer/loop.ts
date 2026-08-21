/**
 * The agentic loop — ADR-0002 §1, on the microkernel.
 *
 * drain steering → store.update → render (solver decides) → model call →
 * journal reply → cacheModel.calibrate(usage) → incumbent update.
 * Tools execute at the coordinator (proposer/applier split, 0002g/K7).
 */
import type { ContextItem, Placement, RenderResult, Zone } from "./types.ts";
import type { ParamSet } from "./params.ts";
import { ContextStore } from "./store.ts";
import { render, estTokens } from "./renderer.ts";
import { solve } from "./solver.ts";
import { CacheModel } from "./cache-model.ts";
import { Ledger } from "./ledger.ts";
import type { Provider } from "./providers.ts";
import { GoalItem, FileLensItem } from "./items.ts";
import { executeIntent, bindHost, type SteeringIntent } from "./intents.ts";

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
      toolResults.push(executeIntent(s, this.store, this.ledger));
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
      f = new FileLensItem(id, target, this.fileContent(target));
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
  return {
    id, kind: "episodic", velocity: "stable", immutable: true,
    tokens: estTokens(line),
    serialize: () => line,
    options: () => [{
      id: "verbatim", zones: ["evolving"], representation: "VERBATIM",
      tokens: estTokens(line), purelyAdditive: true,
    }],
    lastTouchTurn: turn, createdTurn: turn,
  };
}
