/**
 * @connectotron/knapsack — exact multiple-choice knapsack (MCKP) solver.
 *
 * Pure functions, integer arithmetic for all bounds and pruning decisions,
 * deterministic output (no locale collation, no float ordering anywhere).
 */

/** A single choice within a group. Weight and profit are non-negative integers. */
export interface KnapsackOption {
  readonly id: string;
  readonly weight: number;
  readonly profit: number;
}

/** A group of mutually exclusive options; exactly one must be chosen. */
export interface KnapsackGroup {
  readonly id: string;
  readonly options: readonly KnapsackOption[];
}

/** The problem: choose one option per group, total weight <= capacity, maximize profit. */
export interface KnapsackProblem {
  readonly groups: readonly KnapsackGroup[];
  readonly capacity: number;
}

/** The solver's selection: one entry per group. */
export interface KnapsackChoice {
  readonly groupId: string;
  readonly optionId: string;
}

export interface KnapsackBounds {
  /** Dantzig upper bound from the LP relaxation (rational, reported as float). */
  readonly lpUpper: number;
  /** Integral greedy lower bound from rounding the LP solution down. */
  readonly greedyLower: number;
}

export interface KnapsackStats {
  readonly groups: number;
  readonly optionsTotal: number;
  readonly optionsAfterDominance: number;
  readonly optionsAfterFathoming: number;
  /** True when the exact DP ran (LP gap was non-zero). */
  readonly dpRequired: boolean;
  /** Inner-loop iterations executed by the DP (0 when skipped). */
  readonly dpCellsVisited: number;
  /**
   * Which DP kernel actually produced the result (2026-08-24, PR #5):
   * "native" (compiled SIMD dylib), "soa" (TypeScript structure-of-arrays),
   * "reference" (divide-and-conquer; explicit opt-out or above budget),
   * "none" (no DP ran — LP-integral / infeasible / bounded early return).
   * Default policy prefers native with automatic soa fallback, so this
   * field is how a caller observes which path served the answer.
   */
  readonly dpKernelUsed?: "native" | "soa" | "reference" | "none";
}

export interface KnapsackResult {
  /**
   * 'optimal' — a proven-optimal selection is returned (either LP gap was zero,
   *   or the exact DP closed it).
   * 'infeasible' — no selection satisfies the capacity (min-weight sum exceeds it).
   * 'bounded' — bounded-heuristic mode (2026-08-24): the exact DP would exceed
   *   maxDpBytes, so the certified integral greedy incumbent is returned with
   *   honest [greedyLower, lpUpper] bounds. NOT optimal: value is within the
   *   reported interval of OPT, and the interval width is reported in bounds.
   *   Deterministic (integer arithmetic end to end).
   */
  readonly status: "optimal" | "infeasible" | "bounded";
  readonly value: number;
  readonly choices: readonly KnapsackChoice[] | null;
  readonly bounds: KnapsackBounds | null;
  readonly stats: KnapsackStats | null;
}

/** Internal: one group reduced to its strict upper hull, sorted by weight ascending. */
export interface ReducedGroup {
  readonly id: string;
  /** Hull options, weight strictly increasing, profit strictly increasing. */
  readonly options: readonly KnapsackOption[];
  /** Original (pre-reduction) option count, for stats. */
  readonly originalCount: number;
}

export class KnapsackValidationError extends Error {
  constructor(message: string) {
    super(`invalid problem: ${message}`);
    this.name = "KnapsackValidationError";
  }
}
