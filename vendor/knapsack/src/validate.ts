import {
  KnapsackGroup,
  KnapsackProblem,
  KnapsackValidationError,
} from "./types.ts";

/** Max safe value storable in the DP's Int32 rows (profit sums must stay below). */
export const MAX_TOTAL_PROFIT = 0x7fffffff;

/**
 * Max capacity. Bounds the fathom slack term `λp·slack` (λp < 2³¹,
 * slack ≤ C) and every DP index: C < 2²¹ keeps those products < 2⁵².
 *
 * NOTE: this alone does NOT bound λw in the fathom product
 * `(baseP + p)·λw` — λw is a weight DIFF, bounded by the largest weight in
 * the problem, not by C. That bound is enforced separately and adaptively
 * in validateProblem (Σmax-profit · max-weight < 2⁵³).
 */
export const MAX_CAPACITY = 0x1fffff; // 2^21 − 1

/**
 * Max options per group. The DP stores option indices as bytes
 * (Uint8Array back-pointers, 255 = unreachable sentinel), so a group may
 * carry at most 255 options. Hulls are strict non-dominated frontiers —
 * far smaller in practice — but the guarantee is enforced where it is
 * decidable: on the caller's original option array, before reduction.
 */
export const MAX_OPTIONS_PER_GROUP = 255;

/**
 * Every ordering product in the pipeline (hull cross-products, walk argmax
 * compares, fathom bounds) is (profit magnitude ≤ Σ per-group max profits)
 * × (weight magnitude ≤ largest weight). Staying below 2^53 keeps each
 * product an exact IEEE-754 double integer.
 */
export const MAX_EXACT_PRODUCT = 2 ** 53;

function isNonNegInt(n: number): boolean {
  return Number.isInteger(n) && n >= 0;
}

/**
 * Validate structural invariants. Throws KnapsackValidationError on violation.
 *
 * Deliberate scope: weights and profits are NON-NEGATIVE integers, and exactly
 * one option must be chosen per group. A caller that wants "choose nothing"
 * semantics adds a zero-weight, zero-profit option to the group explicitly
 * (agent-kernel's purge option does exactly this).
 */
export function validateProblem(problem: KnapsackProblem): void {
  if (!isNonNegInt(problem.capacity)) {
    throw new KnapsackValidationError("capacity must be a non-negative integer");
  }
  if (problem.capacity > MAX_CAPACITY) {
    throw new KnapsackValidationError(
      `capacity must stay below ${MAX_CAPACITY + 1} (got ${problem.capacity}); ` +
        "scale weights down or solve per subsystem",
    );
  }
  if (!Array.isArray(problem.groups)) {
    throw new KnapsackValidationError("groups must be an array");
  }
  if (problem.groups.length === 0) {
    throw new KnapsackValidationError("at least one group is required");
  }
  const groupIds = new Set<string>();
  let totalMaxProfit = 0;
  let maxWeight = 0;
  for (const g of problem.groups) {
    if (typeof g.id !== "string" || g.id.length === 0) {
      throw new KnapsackValidationError("every group needs a non-empty string id");
    }
    if (groupIds.has(g.id)) {
      throw new KnapsackValidationError(`duplicate group id ${JSON.stringify(g.id)}`);
    }
    groupIds.add(g.id);
    validateGroupOptions(g);
    let groupMaxProfit = 0;
    for (const o of g.options) groupMaxProfit = Math.max(groupMaxProfit, o.profit);
    totalMaxProfit += groupMaxProfit;
    for (const o of g.options) maxWeight = Math.max(maxWeight, o.weight);
  }
  if (totalMaxProfit >= MAX_TOTAL_PROFIT) {
    throw new KnapsackValidationError(
      `sum of per-group max profits must stay below ${MAX_TOTAL_PROFIT} ` +
        `(got ${totalMaxProfit}); scale profits down or solve per subsystem`,
    );
  }
  // Adaptive exactness envelope: every ordering product in hull/walk/fathom
  // is (≤ totalMaxProfit) × (≤ maxWeight). Zero-profit problems are exempt
  // (all products are zero or single-factor).
  if (totalMaxProfit > 0 && totalMaxProfit * maxWeight >= MAX_EXACT_PRODUCT) {
    throw new KnapsackValidationError(
      `exactness envelope exceeded: (sum of max profits)·(largest weight) = ` +
        `${totalMaxProfit}·${maxWeight} must stay below 2^53; ` +
        "scale weights or profits down",
    );
  }
}

function validateGroupOptions(g: KnapsackGroup): void {
  if (!Array.isArray(g.options) || g.options.length === 0) {
    throw new KnapsackValidationError(
      `group ${JSON.stringify(g.id)} needs at least one option`,
    );
  }
  if (g.options.length > MAX_OPTIONS_PER_GROUP) {
    throw new KnapsackValidationError(
      `group ${JSON.stringify(g.id)} has ${g.options.length} options; ` +
        `at most ${MAX_OPTIONS_PER_GROUP} are supported (the exact DP stores ` +
        "option indices as bytes)",
    );
  }
  const ids = new Set<string>();
  for (const o of g.options) {
    if (typeof o.id !== "string" || o.id.length === 0) {
      throw new KnapsackValidationError(
        `group ${JSON.stringify(g.id)} has an option with an invalid id`,
      );
    }
    if (ids.has(o.id)) {
      throw new KnapsackValidationError(
        `duplicate option id ${JSON.stringify(o.id)} in group ${JSON.stringify(g.id)}`,
      );
    }
    ids.add(o.id);
    if (!isNonNegInt(o.weight)) {
      throw new KnapsackValidationError(
        `option ${JSON.stringify(o.id)}: weight must be a non-negative integer`,
      );
    }
    if (!isNonNegInt(o.profit)) {
      throw new KnapsackValidationError(
        `option ${JSON.stringify(o.id)}: profit must be a non-negative integer`,
      );
    }
  }
}

/** True when at least one feasible selection exists (min-weight hull fits). */
export function isFeasible(minWeightSum: number, capacity: number): boolean {
  return minWeightSum <= capacity;
}
