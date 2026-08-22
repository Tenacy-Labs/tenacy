import { ReducedGroup } from "./types.ts";
import { maxProfitOf, minWeightOf } from "./dominance.ts";

/**
 * LP relaxation via the hull-increment parametrization (Dyer–Zemel).
 *
 * With each group reduced to its upper hull, walk the hulls' incremental
 * (Δweight, Δprofit) segments in decreasing efficiency order:
 *   - the FIRST segment (in density order) that does not fit is the LP break:
 *     its fraction supplies the Dantzig upper bound and the break gradient;
 *   - the integral incumbent KEEPS WALKING past the break, skipping segments
 *     that do not fit (segments from different groups are independent; a
 *     skipped segment permanently closes its group, since hull segments are
 *     sequential and total weight only grows).
 *
 * All ordering comparisons are integer cross-products — no divisions in any
 * decision; the only float produced is the reported upper bound.
 */
export interface LpSolution {
  /** Best integral profit found by the greedy walk (valid lower bound). */
  readonly zValue: number;
  /** Dantzig upper bound (may be fractional; never used for decisions). */
  readonly upperBound: number;
  /** Greedy integral incumbent value (valid lower bound). */
  readonly lowerBound: number;
  /** Break segment (Δp, Δw) as an integer pair; (0,1) when no break. */
  readonly breakGradient: { readonly p: number; readonly w: number };
  /** The group containing the fractional (break) segment, if any. */
  readonly breakGroupId: string | null;
  /** Index of the segment's start option within the break group's hull. */
  readonly breakOptionIndex: number;
  /**
   * Maximum increment density over ALL segments, as an integer pair — a valid
   * uniform over-estimate for fathoming bounds (never undershoots a marginal).
   */
  readonly maxGradient: { readonly p: number; readonly w: number };
  /** Total hull-minimum weight (sum of first options). */
  readonly minWeightSum: number;
  /** Total hull-maximum profit. */
  readonly maxProfitSum: number;
}

export interface WalkState {
  readonly indices: readonly number[];
  readonly weight: number;
  readonly profit: number;
}

/**
 * Shared greedy walk. Returns the final per-group hull indices, the incumbent
 * (best integral state seen), and the break info (first non-fitting segment
 * in density order). Pure; no allocation beyond small arrays.
 */
export function greedyWalk(
  reduced: readonly ReducedGroup[],
  capacity: number,
): {
  state: WalkState;
  lowerBound: number;
  break: {
    groupId: string | null;
    optionIndex: number;
    gradient: { p: number; w: number };
    upperBound: number;
  };
  maxGradient: { p: number; w: number };
} {
  const n = reduced.length;
  const idx = reduced.map(() => 0);
  const closed = reduced.map(() => false); // group's next segment skipped
  let weight = 0;
  let profit = 0;
  for (let i = 0; i < n; i++) {
    weight += minWeightOf(reduced[i]!);
    profit += reduced[i]!.options[0]!.profit;
  }
  let lowerBound = profit;

  let maxGp = 0;
  let maxGw = 1;
  let breakGroupId: string | null = null;
  let breakOptionIndex = 0;
  let breakGradient = { p: 0, w: 1 };
  let upperBound = 0;
  let breakSeen = false;

  for (;;) {
    let bestG = -1;
    let bestP = 0;
    let bestW = 0;
    for (let i = 0; i < n; i++) {
      if (closed[i]) continue;
      const g = reduced[i]!;
      const at = idx[i]!;
      if (at + 1 >= g.options.length) {
        closed[i] = true;
        continue;
      }
      const from = g.options[at]!;
      const to = g.options[at + 1]!;
      const dp = to.profit - from.profit;
      const dw = to.weight - from.weight;
      if (dw <= 0) {
        closed[i] = true; // hull guarantees dw > 0; defensive
        continue;
      }
      if (dp * maxGw > maxGp * dw) {
        maxGp = dp;
        maxGw = dw;
      }
      if (bestG < 0 || dp * bestW > bestP * dw) {
        bestG = i;
        bestP = dp;
        bestW = dw;
      }
    }
    if (bestG < 0) break; // no open segments remain
    const g = reduced[bestG]!;
    const from = g.options[idx[bestG]!]!;
    const to = g.options[idx[bestG]! + 1]!;
    const dw = to.weight - from.weight;
    if (weight + dw <= capacity) {
      weight += dw;
      profit += to.profit - from.profit;
      idx[bestG] = idx[bestG]! + 1;
      if (profit > lowerBound) lowerBound = profit;
    } else {
      if (!breakSeen) {
        // First non-fitting segment in density order: the LP break.
        const rem = capacity - weight;
        upperBound = profit + (rem / dw) * (to.profit - from.profit);
        breakGroupId = g.id;
        breakOptionIndex = idx[bestG]!;
        breakGradient = { p: to.profit - from.profit, w: dw };
        breakSeen = true;
      }
      closed[bestG] = true; // sequential hull: this group is done
    }
  }
  if (!breakSeen) upperBound = profit; // fully integral LP solution

  return {
    state: { indices: idx, weight, profit },
    lowerBound,
    break: { groupId: breakGroupId, optionIndex: breakOptionIndex, gradient: breakGradient, upperBound },
    maxGradient: { p: maxGp, w: maxGw },
  };
}

/** LP solution wrapper: run the walk and expose bound bookkeeping. */
export function solveLp(
  reduced: readonly ReducedGroup[],
  capacity: number,
): LpSolution {
  const minWeightSum = reduced.reduce((s, g) => s + minWeightOf(g), 0);
  const maxProfitSum = reduced.reduce((s, g) => s + maxProfitOf(g), 0);
  if (minWeightSum > capacity) {
    return {
      zValue: 0,
      upperBound: 0,
      lowerBound: 0,
      breakGradient: { p: 0, w: 1 },
      breakGroupId: null,
      breakOptionIndex: 0,
      maxGradient: { p: 0, w: 1 },
      minWeightSum,
      maxProfitSum,
    };
  }
  const walk = greedyWalk(reduced, capacity);
  return {
    zValue: walk.lowerBound,
    upperBound: walk.break.upperBound,
    lowerBound: walk.lowerBound,
    breakGradient: walk.break.gradient,
    breakGroupId: walk.break.groupId,
    breakOptionIndex: walk.break.optionIndex,
    maxGradient: walk.maxGradient,
    minWeightSum,
    maxProfitSum,
  };
}
