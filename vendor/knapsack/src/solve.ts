import {
  KnapsackChoice,
  KnapsackProblem,
  KnapsackResult,
  KnapsackStats,
  ReducedGroup,
} from "./types.ts";
import { validateProblem } from "./validate.ts";
import { reduceAll, convexHull } from "./dominance.ts";
import { solveLp, greedyWalk } from "./lp.ts";
import { fathomOptions } from "./fathom.ts";
import { solveDp, DEFAULT_DP_BUDGET } from "./dp.ts";

/** Options for advanced callers. All optional. */
export interface SolveOptions {
  /**
   * Back-pointer table budget in bytes (default 50 MiB). When
   * expectedDpBytes(n, C) exceeds it, the exact DP runs in O(C)-memory
   * divide-and-conquer mode instead (≤ 2× time, same results).
   */
  readonly maxDpBytes?: number;
}

/**
 * Solve an MCKP exactly.
 *
 * Pipeline (classical lineage, adapted for latency-sensitive in-process use —
 * see docs/survey.md Part II):
 *
 *   1. validate          — structural checks, integer domain enforcement
 *   2. Pareto reduction  — within-group dominance (exact; safe for the DP)
 *   3. LP relaxation     — on CONVEX hulls (bounds only); integer compares;
 *                          yields Dantzig UB, greedy incumbent LB, break λ
 *   4. fathom            — on convex hulls; drop options whose λ_max bound
 *                          cannot reach the incumbent
 *   5. exact DP          — on Pareto sets (fathomed options removed), two-row
 *                          Int32Array windowed Bellman (budget-dispatched
 *                          back-pointer or divide-and-conquer mode)
 *   6. report            — value, choices, bounds, stats
 *
 * Determinism: no locale collation, no float ordering, no unordered-map
 * iteration in any decision path. The only float produced anywhere is the
 * reported lpUpper — never used for decisions.
 */
export function solve(
  problem: KnapsackProblem,
  options: SolveOptions = {},
): KnapsackResult {
  validateProblem(problem);

  // 2. Pareto reduction (exact — no optimal solution uses a dominated option).
  const pareto = reduceAll(problem.groups);
  const optionsTotal = problem.groups.reduce((s, g) => s + g.options.length, 0);
  const optionsAfterDominance = pareto.reduce((s, g) => s + g.options.length, 0);

  // 3. LP relaxation on convex hulls (bounds only — a non-convex Pareto point
  // may be integral-optimal, so hulls are never used for the final selection).
  const hulls = pareto.map(convexHull);
  const lp = solveLp(hulls, problem.capacity);

  if (lp.minWeightSum > problem.capacity) {
    return {
      status: "infeasible",
      value: 0,
      choices: null,
      bounds: { lpUpper: 0, greedyLower: 0 },
      stats: {
        groups: pareto.length,
        optionsTotal,
        optionsAfterDominance,
        optionsAfterFathoming: optionsAfterDominance,
        dpRequired: false,
        dpCellsVisited: 0,
      },
    };
  }

  // LP fully integral on hulls: every hull segment fit, so the walk consumed
  // all of them — the terminal state is the LP optimum AND a real selection,
  // hence integral-optimal (nothing anywhere can beat the LP bound).
  if (lp.breakGroupId === null) {
    const walk = greedyWalk(hulls, problem.capacity);
    const choices = extractChoices(hulls, walk.state.indices);
    return {
      status: "optimal",
      value: lp.zValue,
      choices,
      bounds: { lpUpper: lp.upperBound, greedyLower: lp.lowerBound },
      stats: {
        groups: pareto.length,
        optionsTotal,
        optionsAfterDominance,
        optionsAfterFathoming: optionsAfterDominance,
        dpRequired: false,
        dpCellsVisited: 0,
      },
    };
  }

  // 4. Fathom hull options against the greedy incumbent.
  const fathomed = fathomOptions(hulls, problem.capacity, lp, lp.lowerBound);

  // Map dropped hull options onto the Pareto sets for the exact DP.
  // KEYED PER GROUP: option ids are unique within a group only, never globally.
  const droppedByGroup = new Map<string, Set<string>>();
  for (let i = 0; i < hulls.length; i++) {
    const hull = hulls[i]!;
    const fGroup = fathomed.groups[i]!;
    if (fGroup.options.length < hull.options.length) {
      const kept = new Set(fGroup.options.map((o) => o.id));
      const dropped = new Set<string>();
      for (const o of hull.options) {
        if (!kept.has(o.id)) dropped.add(o.id);
      }
      droppedByGroup.set(hull.id, dropped);
    }
  }
  let dpGroups = pareto;
  if (droppedByGroup.size > 0) {
    dpGroups = pareto.map((g) => {
      const dropped = droppedByGroup.get(g.id);
      if (!dropped) return g;
      const keep = g.options.filter((o) => !dropped.has(o.id));
      // The incumbent path (a real selection) is never fathomed, so a group
      // never empties; guard defensively regardless.
      return keep.length > 0 ? { ...g, options: keep } : g;
    });
  }
  const optionsAfterFathoming = dpGroups.reduce((s, g) => s + g.options.length, 0);

  // 5. Exact DP.
  const dp = solveDp(dpGroups, problem.capacity, options.maxDpBytes ?? DEFAULT_DP_BUDGET);
  const choices = extractChoices(dpGroups, dp.choiceIndex);

  return {
    status: "optimal",
    value: dp.value,
    choices,
    bounds: { lpUpper: lp.upperBound, greedyLower: lp.lowerBound },
    stats: {
      groups: pareto.length,
      optionsTotal,
      optionsAfterDominance,
      optionsAfterFathoming,
      dpRequired: true,
      dpCellsVisited: dp.cellsVisited,
    },
  };
}

function extractChoices(
  groups: readonly { id: string; options: readonly { id: string }[] }[],
  indices: readonly number[],
): KnapsackChoice[] {
  const choices: KnapsackChoice[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    const opt = g.options[indices[i]!];
    if (opt === undefined) continue; // defensive; cannot happen
    choices.push({ groupId: g.id, optionId: opt.id });
  }
  return choices;
}

export { solveLp } from "./lp.ts";
export { reduceGroupToHull, convexHull } from "./dominance.ts";
export { solveDp } from "./dp.ts";
export { fathomOptions } from "./fathom.ts";
export {
  KnapsackValidationError,
  type KnapsackProblem,
  type KnapsackOption,
  type KnapsackGroup,
  type KnapsackResult,
  type KnapsackBounds,
  type KnapsackStats,
  type KnapsackChoice,
  type ReducedGroup,
} from "./types.ts";
