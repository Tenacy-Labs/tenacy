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
import { solveDp, DEFAULT_DP_BUDGET, expectedDpBytes } from "./dp.ts";
import { solveDpSoa } from "./dp-soa.ts";
import { solveDpNative } from "./native.ts";
import type { DpResult } from "./dp.ts";

/** Options for advanced callers. All optional. */
export interface SolveOptions {
  /**
   * Back-pointer table budget in bytes (default 50 MiB). When
   * expectedDpBytes(n, C) exceeds it, the exact DP runs in O(C)-memory
   * divide-and-conquer mode instead (≤ 2× time, same results).
   */
  readonly maxDpBytes?: number;
  /**
   * DP kernel selection (PR #5 default): "native" (default; compiled
   * SIMD kernel, automatic soa fallback), "soa", or "reference".
   * Same recurrence, tie-breaking, and outputs; differential-tested in
   * stowage's test/dp-soa.test.ts. "soa" is exact; if the problem exceeds
   * maxDpBytes the reference divide-and-conquer path is used regardless.
   */
  readonly dpKernel?: "reference" | "soa" | "native";
  /**
   * Bounded mode (2026-08-24, stowage perf item 1): "exact" (default) or
   * "bounded". In bounded mode, when the exact DP table would exceed
   * maxDpBytes, the certified integral greedy incumbent is returned with
   * honest [greedyLower, lpUpper] bounds (status "bounded") instead of the
   * O(capacity)-memory divide-and-conquer DP — which at full-window scale
   * means O(groups x capacity) TIME (measured 37-42s at 10k groups / 1M
   * capacity). Below the budget, behavior is identical to "exact".
   */
  readonly reliefMode?: "exact" | "bounded";
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
        dpKernelUsed: "none",
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
        dpKernelUsed: "none",
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
  // Exact scale filter (PR4 review C1 root fix, 2026-08-24): an option
  // with weight > capacity can never appear in any feasible selection
  // (exactly one option chosen per group, total weight <= capacity), so
  // dropping it is exact. Capacity is validated <= 2^21-1 (MAX_CAPACITY),
  // so every surviving weight fits i32; profits are already bounded by
  // MAX_TOTAL_PROFIT < 2^31. This closes the silent-truncation class for
  // BOTH the SoA Int32Array flattening and the native Int32 FFI flatten —
  // inputs the reference D&C handled via float64 were silently corrupted
  // (SoA returned infeasible, native could panic) before this filter.
  let scaleFiltered = false;
  for (const g of dpGroups) {
    for (const o of g.options) {
      if (o.weight > problem.capacity) { scaleFiltered = true; break; }
    }
    if (scaleFiltered) break;
  }
  if (scaleFiltered) {
    dpGroups = dpGroups.map((g) => {
      const keep = g.options.filter((o) => o.weight <= problem.capacity);
      return keep.length > 0 ? { ...g, options: keep } : g;
    });
  }
  const optionsAfterFathoming = dpGroups.reduce((s, g) => s + g.options.length, 0);

  // 5. Exact DP.
  // Kernel dispatch (PR #5 default): native-first under budget with soa
  // fallback; reference divide-and-conquer above the budget (all settings)
  // and as the explicit opt-out.
  const resolvedDpBudget = options.maxDpBytes ?? DEFAULT_DP_BUDGET;
  // Bounded mode (2026-08-24, stowage perf item 1): when the exact DP table
  // would exceed the memory budget — the divide-and-conquer fallback's 2x
  // time is O(groups x capacity) at full-window scale (measured 7.6-15.2B
  // cells, 37-42s at 10k groups / 1M capacity) — return the certified
  // integral greedy incumbent instead. The Dantzig lpUpper brackets OPT
  // from above; greedyLower (the walk incumbent) brackets from below. The
  // selection is feasible by construction (every hull index is a real
  // option) and honest: status "bounded", never "optimal".
  if (options.reliefMode === "bounded" && expectedDpBytes(dpGroups.length, problem.capacity) > resolvedDpBudget) {
    const walk = greedyWalk(dpGroups, problem.capacity);
    const choices = extractChoices(dpGroups, walk.state.indices);
    return {
      status: "bounded",
      value: walk.lowerBound,
      choices,
      bounds: { lpUpper: Math.max(lp.upperBound, walk.break.upperBound), greedyLower: walk.lowerBound },
      stats: {
        groups: pareto.length,
        optionsTotal,
        optionsAfterDominance,
        optionsAfterFathoming: optionsAfterFathoming,
        dpRequired: false,
        dpCellsVisited: 0,
        dpKernelUsed: "none",
      },
    };
  }
  // Kernel dispatch (2026-08-24): native SIMD when requested and its
  // dylib loaded (budget-gated, same gate as soa); soa when requested;
  // reference solveDp otherwise. Native returns null when absent or over
  // budget -> the chain falls through to soa (same shape under budget) or
  // solveDp (reference, D&C fallback above budget). Bounded mode above
  // budget is handled earlier and takes precedence.
  let dp: DpResult;
  let dpKernelUsed: "native" | "soa" | "reference";
  // Default policy (PR #5, owner ruling 2026-08-24): prefer the compiled
  // native kernel, fall back to the TypeScript SoA kernel when the dylib
  // is absent or unloadable (identical outputs, differential-proven).
  // "reference" remains the explicit opt-out. Above budget, all paths
  // route to the divide-and-conquer reference.
  const wantKernel = options.dpKernel ?? "native";
  if (wantKernel === "native" && expectedDpBytes(dpGroups.length, problem.capacity) <= resolvedDpBudget) {
    const native = solveDpNative(dpGroups, problem.capacity, resolvedDpBudget);
    if (native !== null) {
      dp = native; dpKernelUsed = "native";
    } else {
      dp = solveDpSoa(dpGroups, problem.capacity, resolvedDpBudget); dpKernelUsed = "soa";
    }
  } else if (wantKernel === "soa" && expectedDpBytes(dpGroups.length, problem.capacity) <= resolvedDpBudget) {
    dp = solveDpSoa(dpGroups, problem.capacity, resolvedDpBudget); dpKernelUsed = "soa";
  } else {
    dp = solveDp(dpGroups, problem.capacity, resolvedDpBudget); dpKernelUsed = "reference";
  }

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
      dpKernelUsed,
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
