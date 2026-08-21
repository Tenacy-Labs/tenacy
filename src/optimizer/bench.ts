/**
 * Benchmark harness — simple agentic tasks run through the agent as tests.
 *
 * A task = scripted model steps (intents the "model" proposes) + task-level
 * checks over the loop state after the run: store contents, render shape,
 * ledger facts, cache behavior. Deterministic (ScriptedProvider), offline,
 * journaled — the same harness drives live A/B later (0003 §5) by swapping
 * the provider, never the checks.
 */
import type { SteeringIntent } from "./intents.ts";
import type { TurnOutcome } from "./loop.ts";
import { AgentLoop } from "./loop.ts";
import type { Provider } from "./providers.ts";
import { ScriptedProvider } from "./providers.ts";
import { paramSetV1 } from "./params.ts";
import { Ledger } from "./ledger.ts";
import { StandingItem } from "./items.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Placement } from "./types.ts";

export interface BenchmarkTask {
  /** Short slug. */
  name: string;
  /** Human description of the scenario. */
  description: string;
  /** What the "user" says each turn. */
  userMessages: string[];
  /** What the "model" replies + proposes, one entry per turn. */
  modelSteps: Array<{ text?: string; intents?: SteeringIntent[] }>;
  /** File content for files.* targets (target → content). */
  files?: Record<string, string>;
  /** Assertions over the final loop state. */
  check: (state: BenchmarkState) => void;
}

export interface BenchmarkState {
  loop: AgentLoop;
  outcomes: TurnOutcome[];
  placements: Placement[];
  ledgerPath: string | null;
}

export interface BenchmarkResult {
  name: string;
  passed: boolean;
  turns: number;
  error?: string;
  /** Full turn outcomes — for value-density and metric computation. */
  outcomes: TurnOutcome[];
}

/** Run one task to completion; collect state; run checks. */
export async function runTask(task: BenchmarkTask, opts: { ledger?: boolean } = {}): Promise<BenchmarkResult> {
  const provider = new ScriptedProvider(task.modelSteps);
  const dir = mkdtempSync(join(tmpdir(), "ak-bench-"));
  const ledger = opts.ledger === false ? null : new Ledger(join(dir, "ledger.jsonl"));
  const loop = new AgentLoop(provider, paramSetV1("mock-scripted"), ledger);

  // identity/directive head
  loop.store.add(new StandingItem("identity", "identity", "Benchmark agent. Render is a projection, not an accumulator.").toContextItem());
  loop.store.add(new StandingItem("directive", "directive", "Use files.*/ctx.*/goals.* tools. Be precise.").toContextItem());
  if (task.files !== undefined) {
    loop.fileContent = (t) => task.files![t] ?? "";
  }

  const outcomes: TurnOutcome[] = [];
  try {
    for (const msg of task.userMessages) {
      outcomes.push(await loop.run(msg));
    }
    if (ledger !== null) await ledger.drain();
    const placements = outcomes[outcomes.length - 1]?.placements ?? [];
    task.check({ loop, outcomes, placements, ledgerPath: ledger !== null ? join(dir, "ledger.jsonl") : null });
    return { name: task.name, passed: true, turns: outcomes.length, outcomes };
  } catch (e) {
    return { name: task.name, passed: false, turns: outcomes.length, error: String(e), outcomes };
  }
}

/** Convenience: assert helper that throws with context. */
export function ensure(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`task check failed: ${msg}`);
}

/** Value-density metric — realized value per cache-adjusted render cost (0003 T5). */
export function valueDensity(outcomes: TurnOutcome[]): { perTurn: number[]; mean: number } {
  const perTurn = outcomes.map((o) =>
    o.renderTokens > 0
      ? (o.placements.length / o.renderTokens) * 1000
      : 0,
  );
  const mean = perTurn.length > 0 ? perTurn.reduce((a, b) => a + b, 0) / perTurn.length : 0;
  return { perTurn, mean };
}
