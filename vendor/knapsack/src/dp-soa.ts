// SoA variant of the back-pointer DP (perf item 2, 2026-08-24).
// Same recurrence, same tie-breaking, same windowing as dp.ts's
// solveDpBackpointer — the only change is data layout: per-group option
// weights/profits hoisted into flat typed arrays so the hot gather loop
// is property-load-free. Differential-tested cell-for-cell against the
// reference in test/dp-soa.test.ts (stowage) — equal value, weight, and
// choiceIndex on randomized problems.
import type { ReducedGroup } from "./types.ts";
import { expectedDpBytes } from "./dp.ts";

export interface DpResult {
  readonly value: number;
  readonly weight: number;
  readonly choiceIndex: readonly number[];
  readonly cellsVisited: number;
}

/**
 * solveDpSoa: the exact back-pointer DP with structure-of-arrays option
 * data. Deterministic: identical input -> identical output (no locale, no
 * float ordering, all integer arithmetic).
 */
export function solveDpSoa(
  reduced: readonly ReducedGroup[],
  capacity: number,
  maxDpBytes: number = 50 * 1024 * 1024,
): DpResult {
  const n = reduced.length;
  if (expectedDpBytes(n, capacity) > maxDpBytes) {
    throw new Error("solveDpSoa: use dp.ts solveDp (divide-and-conquer fallback) above the memory budget");
  }
  const width = capacity + 1;
  let prev = new Int32Array(width).fill(-1);
  // Per-group option-count min/max weights, precomputed (SoA phase 0).
  const groupMin = new Int32Array(n); const groupMax = new Int32Array(n);
  for (let gi = 0; gi < n; gi++) {
    let mn = reduced[gi]!.options[0]!.weight; let mx = mn;
    for (let i = 0; i < reduced[gi]!.options.length; i++) {
      const wgt = reduced[gi]!.options[i]!.weight;
      if (wgt < mn) mn = wgt;
      if (wgt > mx) mx = wgt;
    }
    groupMin[gi] = mn; groupMax[gi] = mx;
  }
  let cur = new Int32Array(width).fill(-1);
  const bp = new Uint8Array(n * width).fill(255);
  // Hoist option weights/profits into flat SoA arrays ONCE.
  const optCount = reduced.map((g) => g.options.length);
  const flatW = new Int32Array(reduced.reduce((s, g) => s + g.options.length, 0));
  const flatP = new Int32Array(flatW.length);
  let k = 0;
  for (let gi = 0; gi < n; gi++) {
    for (let oi = 0; oi < reduced[gi]!.options.length; oi++) {
      flatW[k] = reduced[gi]!.options[oi]!.weight;
      flatP[k] = reduced[gi]!.options[oi]!.profit;
      k++;
    }
  }
  const groupStart = new Int32Array(n + 1);
  for (let gi = 0; gi < n; gi++) groupStart[gi + 1] = groupStart[gi]! + optCount[gi]!;
  let cells = 0;
  const g0 = reduced[0]!;
  let g0Min = g0.options[0]!.weight;
  let g0Max = g0Min;
  for (let i = 0; i < g0.options.length; i++) {
    const wgt = g0.options[i]!.weight;
    if (wgt < g0Min) g0Min = wgt;
    if (wgt > g0Max) g0Max = wgt;
    if (wgt <= capacity && g0.options[i]!.profit > prev[wgt]!) {
      prev[wgt] = g0.options[i]!.profit; bp[wgt] = i;
    }
    cells++;
  }
  let windowLo = g0Min; let windowHi = g0Max;
  for (let gi = 1; gi < n; gi++) {
    const gMin = groupMin[gi]!; const gMax = groupMax[gi]!;
    const lo = Math.min(capacity, windowLo + gMin);
    const hi = Math.min(capacity, windowHi + gMax);
    const bpBase = gi * width;
    const s0 = groupStart[gi]!; const s1 = groupStart[gi + 1]!;
    cur.fill(-1);
    for (let w = lo; w <= hi; w++) {
      let best = -1; let bestOpt = -1;
      for (let i = s0; i < s1; i++) {
        const pw = w - flatW[i]!;
        if (pw < 0) continue;
        const pv = prev[pw]!;
        if (pv < 0) continue;
        const v = pv + flatP[i]!;
        if (v > best) { best = v; bestOpt = i - s0; }
      }
      if (best >= 0) { cur[w] = best; bp[bpBase + w] = bestOpt; }
      cells++;
    }
    windowLo += gMin; windowHi = hi;
    const t = prev; prev = cur; cur = t;
  }
  let bestVal = -1; let bestW = -1;
  for (let w = 0; w <= capacity; w++) {
    const v = prev[w]!;
    if (v > bestVal) { bestVal = v; bestW = w; }
  }
  if (bestVal < 0) return { value: -1, weight: -1, choiceIndex: [], cellsVisited: cells };
  const choiceIndex: number[] = new Array<number>(n).fill(-1);
  let w = bestW;
  for (let gi = n - 1; gi >= 1; gi--) {
    const optIdx = bp[gi * width + w]!;
    choiceIndex[gi] = optIdx;
    w -= reduced[gi]!.options[optIdx]!.weight;
  }
  choiceIndex[0] = bp[w]!;
  return { value: bestVal, weight: bestW, choiceIndex, cellsVisited: cells };
}
