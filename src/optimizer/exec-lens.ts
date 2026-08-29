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
import { rmSync } from "node:fs";
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
/** A bounded authorization for the real runner. Minted ONLY at trusted
 *  boundaries (operator command surfaces); the model channel never sees one.
 *  N uses then reverts to deny — a forgotten window cannot outlive its task. */
export interface ExecGrant {
  readonly uses: number;
}

export function gateRunner(authorized: ExecRunner, uses = 1): { grant: ExecGrant; runner: ExecRunner; remaining(): number } {
  // FAIL CLOSED on non-finite N (PR34 gate review): Math.max(0, Math.floor(NaN))
  // is NaN, and NaN <= 0 is false — an unsanitized Infinity/NaN at a future
  // trusted boundary must deny, never authorize forever.
  const n = Number.isFinite(uses) ? Math.max(0, Math.floor(uses)) : 0;
  let remaining = n;
  const grant: ExecGrant = Object.freeze({ uses: n });
  const runner: ExecRunner = (cmd, timeoutMs) => {
    if (remaining <= 0) return denyRunner(cmd, timeoutMs);
    remaining--;
    return authorized(cmd, timeoutMs);
  };
  return { grant, runner, remaining: () => remaining };
}


/** Default runner: DENY. Real execution requires an explicitly authorized
 *  runner injected at a trusted boundary (owner ruling 2026-08-26: gating
 *  wrapper is required BEFORE exec reaches non-coordinator cells). */
export function denyRunner(_cmd: string, _timeoutMs: number): { exit: number; out: string } {
  return { exit: 126, out: "⟨exec denied: no authorized runner installed⟩" };
}

let execSeq = 0;

/** Real runner: /bin/sh -c with a hard timeout, output capped. NOT the
 * default — inject explicitly where execution is authorized.
 *
 * The deadline is enforced by a SHELL-SIDE WATCHDOG, not the runtime:
 * Bun 1.2.5/darwin silently ignores the `timeout` option of both spawn and
 * spawnSync (verified 2026-08-29: `sleep 2` + timeout 300 → 2016ms, exit 0),
 * which blocked the event loop for the full clamp ceiling and reported the
 * which blocked the event loop for the full clamp ceiling and reported the
 * timed-out command as successful. The wrapper backgrounds the command with
 * its output redirected to a FILE — a backgrounded group's children survive
 * the subshell's death and would otherwise hold the inherited stdout pipe,
 * and spawnSync returns on pipe EOF, not process exit — then runs a killer
 * subshell (TERM at the deadline, KILL 200ms later) and decides by a MARKER
 * FILE the killer stamps BEFORE its first signal: race-free whatever the
 * reaping order. Exit contract: 124 on timeout (GNU-timeout convention),
 * otherwise the command's own exit code. Note: a gated (model-controlled)
 * command could in principle rm the marker and downgrade 124 to its own
 * signal exit — a dishonest exit code, never a lost deadline: the killer
 * still kills. */
export function shellRunner(cmd: string, timeoutMs: number): { exit: number; out: string } {
  const ms = clampTimeout(timeoutMs);
  const sec = Math.max(0.001, ms / 1000).toFixed(3);
  const stem = `/tmp/.agent-kernel-exec-${process.pid}-${execSeq++}`;
  const marker = `${stem}.fired`;
  const outfile = `${stem}.out`;
  const wrapped =
    `{ ${cmd}; } > '${outfile}' 2>&1 & __cmd=$!; ` +
    `( sleep ${sec}; : > '${marker}'; kill -TERM $__cmd 2>/dev/null; sleep 0.2; kill -KILL $__cmd 2>/dev/null ) >/dev/null 2>&1 & __killer=$!; ` +
    `wait $__cmd; __rc=$?; ` +
    `kill $__killer 2>/dev/null; wait $__killer 2>/dev/null; ` +
    `cat '${outfile}'; rm -f '${outfile}'; ` +
    `if [ -f '${marker}' ]; then rm -f '${marker}'; exit 124; fi; ` +
    `exit $__rc`;
  const p = Bun.spawnSync(["/bin/sh", "-c", wrapped], { stdout: "pipe", stderr: "pipe" });
  rmSync(marker, { force: true });   // boundary: stamped after the check — the decision already left with the shell
  rmSync(outfile, { force: true });  // orphaned descendant still appending — the snapshot we catted is the verdict
  const timedOut = p.exitCode === 124;
  // The shell's own "Terminated: 15 / Killed: 9" job notice for OUR kill is
  // machinery noise, not command output — strip it on the timeout path.
  const raw = p.stdout.toString() + p.stderr.toString()
    .replace(/^sh: line \d+: \d+ (?:Terminated|Killed): \d+.*$\n?/gm, "");
  const out = timedOut
    ? capOutput(raw.trimStart()) + `\n⟨timeout after ${ms}ms⟩`
    : capOutput(raw);
  return { exit: timedOut ? 124 : p.exitCode ?? -1, out };
}

/** Clamp model-controlled timeouts to a positive bounded range (C1: timeout 0
 *  = no timeout in Bun; arbitrarily large values block the event loop). */
export function clampTimeout(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 10_000;
  return Math.min(ms, 60_000);
}

/** Capture at most 20,000 BYTES (not chars) with an honest truncation marker
 *  (B-M2: truncation must be marked, never silently passed as complete). */
export function capOutput(s: string): string {
  const bytes = Buffer.byteLength(s, "utf8");
  if (bytes <= 20_000) return s;
  let cut = 20_000;
  // Walk back over a possible UTF-8 sequence split mid-boundary.
  const buf = Buffer.from(s, "utf8");
  while (cut > 0 && ((buf[cut] ?? 0) & 0xc0) === 0x80) cut--;
  return buf.subarray(0, cut).toString("utf8") + "\n⟨output truncated at 20000 bytes⟩";
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
    public runner: ExecRunner = denyRunner,
    /** Called for each new run lens (loop: registry + store add). */
    public attach: (lens: ExecRunLens) => void = () => {},
    /** Called when a run is dropped (loop: registry remove) — keeps the
     *  lens registry free of stale entries after exec.release. */
    public detach: (lensId: string) => void = () => {},
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
    for (const id of ids) {
      const l = this.lenses.get(id);
      if (l !== undefined) this.detach(l.id);
      this.lenses.delete(id);
    }
    return this.runs.length < before;
  }

  /** Restore a run from a session row WITHOUT rerunning it (B-M1: run
   *  history must survive save/restore; recoverability is rerun, restore
   *  is replay of the immutable snapshot). Rebuilds the per-run lens,
   *  commit entry, and id allocation head. */
  restoreRun(run: ExecRun): ExecRunLens {
    this.runs.push(run);
    const lens = new ExecRunLens(run);
    lens.lastTouchTurn = run.turn;
    lens.createdTurn = run.turn;
    lens.ranges = [[1, 1]];
    this.lenses.set(run.id, lens);
    this.#commits.push({ turn: run.turn, path: `exec/#${run.id}` });
    this.nextId = Math.max(this.nextId, run.id + 1);
    this.attach(lens);
    return lens;
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
