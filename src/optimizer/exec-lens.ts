/**
 * Exec lenses — process output as a lens substrate, one Lens per run.
 *
 * ExecCollection owns the run history, id allocation, and the ns entry
 * point. Each run materializes its OWN ExecRunLens (a full Lens: own
 * ContextItem, own options/digest/purge path) so the solver prices every
 * run independently. `exec.run` on the collection is the single entry
 * point; runs are immutable snapshots — recoverability is RERUN, not
 * reread (ADR-0006 §3 class).
 *
 * The runner is producer-supplied (same doctrine as fileContent/dirListing):
 * the default shells out; tests inject a deterministic fake.
 */
import { Lens } from "./lens.ts";
import type { NamespaceNode, NamespaceProducer } from "./ns-lens.ts";

/** One executed command and its captured output. */
export interface ExecRun {
  id: number;
  cmd: string;
  exit: number;
  out: string;
  turn: number;
}

/** Producer-injected runner: execute a command, return exit + output. */
export type ExecRunner = (cmd: string, timeoutMs: number) => { exit: number; out: string };

/** Default runner: /bin/sh -c with a hard timeout, output capped. */
export function shellRunner(cmd: string, timeoutMs: number): { exit: number; out: string } {
  const p = Bun.spawnSync(["/bin/sh", "-c", cmd], {
    stdout: "pipe", stderr: "pipe", timeout: timeoutMs,
  });
  const out = `${p.stdout.toString()}${p.stderr.toString()}`.slice(0, 20_000);
  const timedOut = p.exitCode === null;
  return { exit: timedOut ? 124 : p.exitCode ?? -1, out: timedOut ? `${out}\n⟨timeout after ${timeoutMs}ms⟩` : out };
}

/**
 * ExecRunLens — ONE run as its own lens. Content = the run's captured
 * output; full/compact options inherit the Lens template method (FULL-only
 * first write, compact head as zeroValue). The substrate never mutates:
 * watch is frozen, expand/release are no-ops (a run is atomic).
 */
export class ExecRunLens extends Lens {
  constructor(
    public readonly run: ExecRun,
    immutable = true,
    upstreams: readonly string[] = [],
    hazardOverride?: number,
    valueBump?: { amount: number; untilTurn: number },
    watch: "live" | "polled" | "frozen" = "frozen",
    lastRender?: { position: number; digest: string },
    lastTouchTurn = 0,
    createdTurn = 0,
  ) {
    super(`lens:exec#${run.id}`, `exec/#${run.id}`, immutable, upstreams, hazardOverride, valueBump, watch, lastRender, lastTouchTurn, createdTurn);
  }

  protected substrateTag(): string { return "exec"; }

  /** Compact head for the structure projection of this run. */
  override compactText(): string {
    return `⟨exec #${this.run.id}: exit=${this.run.exit}, ${this.run.cmd.slice(0, 60)}⟩`;
  }

  /** The run's content — cmd banner + captured output. */
  override fullText(): string {
    return `⟨exec #${this.run.id} ${this.run.turn} turn(s) 1 range(s)⟩\n` +
      `#. ${this.run.cmd} (exit ${this.run.exit}, t${this.run.turn})\n${this.run.out.trimEnd()}`;
  }

  // A run is atomic: expand/release over its (empty) range space are no-ops.
  override expand(_from: number, _to: number): void { this.ranges = [[1, 1]]; }
  override release(_from: number, _to: number): void { this.ranges = []; }

  protected sliceRange(_a: number, _b: number): string {
    return `#. ${this.run.cmd} (exit ${this.run.exit}, t${this.run.turn})\n${this.run.out.trimEnd()}`;
  }
}

/**
 * ExecCollection — the run-history substrate and ns entry point. Not a
 * ContextItem itself: it owns allocation, materializes per-run lenses into
 * the store (via the attach callback), and replays the ns commit log.
 */
export class ExecCollection {
  runs: ExecRun[] = [];
  lenses = new Map<number, ExecRunLens>();
  nextId = 1;
  #commits: Array<{ turn: number; path: string }> = [];

  constructor(
    public runner: ExecRunner = shellRunner,
    /** Called for each new run lens (loop: registry + store add). */
    public attach: (lens: ExecRunLens) => void = () => {},
  ) {}

  /** Execute a command; materialize + attach its per-run lens. */
  run(cmd: string, turn: number, timeoutMs = 10_000): ExecRunLens {
    const { exit, out } = this.runner(cmd, timeoutMs);
    const r: ExecRun = { id: this.nextId++, cmd, exit, out, turn };
    this.runs.push(r);
    const lens = new ExecRunLens(r);
    lens.lastTouchTurn = turn;
    lens.createdTurn = turn;
    lens.ranges = [[1, 1]];   // selected by construction: the run just happened
    this.lenses.set(r.id, lens);
    this.#commits.push({ turn, path: `exec/#${r.id}` });
    this.attach(lens);
    return lens;
  }

  /** Structure listing: one line per run (history order). */
  listingLines(): string[] {
    return this.runs.map((r) => `#${r.id}  exit=${r.exit}  ${r.cmd.slice(0, 80)}`);
  }

  structureText(): string {
    return `⟨exec runs: ${this.runs.length}⟩\n` +
      this.listingLines().map((l, i) => `${i + 1}| ${l}`).join("\n");
  }

  /** Drop runs (and their lenses) entirely, by id. */
  drop(ids: number[]): boolean {
    const before = this.runs.length;
    const drop = new Set(ids);
    this.runs = this.runs.filter((r) => !drop.has(r.id));
    for (const id of ids) this.lenses.delete(id);
    return this.runs.length < before;
  }

  /** ns entry point: runs as value nodes + commit replay. */
  nsProducer(): NamespaceProducer {
    const c = this;
    return {
      children(prefix: string): NamespaceNode[] {
        if (prefix !== "" && prefix !== "exec") return [];
        return c.runs.map((r) => ({
          path: `exec/#${r.id}`,
          kind: "value" as const,
          repr: `exit=${r.exit}  ${r.cmd.slice(0, 60)}`,
        }));
      },
      commitsSince(turn: number) {
        return c.#commitsSince(turn);
      },
    };
  }

  #commitsSince(turn: number) {
    return this.#commits
      .filter((c) => c.turn > turn)
      .map((c) => ({ turn: c.turn, changes: [{ marker: "+" as const, path: c.path }] }));
  }
}
