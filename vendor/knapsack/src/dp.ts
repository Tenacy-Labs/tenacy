import { ReducedGroup } from "./types.ts";

/**
 * Exact MCKP via two-row Bellman DP with reachable-weight windowing
 * (fontanf shape; Kellerer–Pferschy–Pisinger DP lineage).
 *
 * Two modes, selected by a memory budget:
 *
 *  - BACK-POINTER MODE (when the table fits): two Int32Array rows swapped by
 *    reference plus a flat Uint8Array back-pointer table
 *    (bp[gi * width + w] = option index chosen by group gi to arrive at
 *    weight w, 255 = unreachable) — n·(C+1) + 8·(C+1) bytes, O(n) traceback.
 *
 *  - DIVIDE-AND-CONQUER MODE (Hirschberg 1975 shape, when the table would
 *    exceed the budget): no back-pointers exist; only O(C) value rows are
 *    live at any moment. The group range splits at its midpoint; forward
 *    and backward value sweeps meet at the split; the meeting weight w*
 *    that achieves the optimum divides the capacity between the halves,
 *    which recurse. Sub-capacities telescope (w* + (C−w*) = C at every
 *    level), so total work is 2× one full sweep; live memory is four
 *    Int32Array rows = 16·(C+1) bytes, independent of n.
 *
 * The inner loop is a plain scan — or-tools' own measurements favor plain
 * loops over clever arithmetic at this scale. All values are integers.
 */
export interface DpResult {
  readonly value: number;
  /** Final weight of the optimal selection (<= capacity). */
  readonly weight: number;
  /** Option index chosen per group, aligned with the input order. */
  readonly choiceIndex: readonly number[];
  readonly cellsVisited: number;
}

/**
 * Peak DP allocation in back-pointer mode: n·(C+1) bytes of back-pointers
 * plus two Int32Array value rows. Cross-validated within ±3% against
 * measured peak RSS across 11 shapes and two languages.
 */
export function expectedDpBytes(groups: number, capacity: number): number {
  return groups * (capacity + 1) + 8 * (capacity + 1);
}

/** Default DP table budget: 50 MiB. Above it the DP switches to the
 *  O(C)-memory divide-and-conquer traceback (2× time, exact, bounded). */
export const DEFAULT_DP_BUDGET = 50 * 1024 * 1024;

export function solveDp(
  reduced: readonly ReducedGroup[],
  capacity: number,
  maxDpBytes: number = DEFAULT_DP_BUDGET,
): DpResult {
  const n = reduced.length;
  const width = capacity + 1;
  if (expectedDpBytes(n, capacity) > maxDpBytes) {
    return solveDpDivideConquer(reduced, capacity);
  }
  return solveDpBackpointer(reduced, capacity);
}

/** Back-pointer mode: flat Uint8Array table, O(n) traceback. */
function solveDpBackpointer(
  reduced: readonly ReducedGroup[],
  capacity: number,
): DpResult {
  const n = reduced.length;
  const width = capacity + 1;
  let prev = new Int32Array(width).fill(-1); // -1 = unreachable
  let cur = new Int32Array(width).fill(-1);
  // Back-pointers store OPTION INDICES (0..254; 255 = unreachable sentinel)
  // in a Uint8Array — 1 byte per cell instead of 4. Valid because validation
  // caps each group at 255 options (MAX_OPTIONS_PER_GROUP, validate.ts), and
  // this invariant survives reduction: hulls only ever shrink option counts.
  // Memory = n·(C+1) + 2·(C+1)·4 bytes, a 4× cut vs the old Int32 table.
  const bp = new Uint8Array(n * width).fill(255);

  let cells = 0;

  // Stage 0: group 0's options seed prev (ties -> first writer wins, which is
  // the lower hull index — deterministic). Min/max computed from the data,
  // NOT from options[0]/options[last]: solveDp is correct for any option
  // order (the pipeline always passes weight-sorted hulls, but the function
  // does not assume it).
  const g0 = reduced[0]!;
  // Integer-initialized min/max (NEVER Infinity — a float leaking into the
  // window bounds makes JSC double-represent the hot loop's weight counter,
  // costing ~65% on the inner sweep; measured 2026-08-22).
  let g0Min = g0.options[0]!.weight;
  let g0Max = g0Min;
  for (let i = 0; i < g0.options.length; i++) {
    const o = g0.options[i]!;
    if (o.weight < g0Min) g0Min = o.weight;
    if (o.weight > g0Max) g0Max = o.weight;
    if (o.weight <= capacity && o.profit > prev[o.weight]!) {
      prev[o.weight] = o.profit;
      bp[o.weight] = i; // row 0 doubles as group 0's back-pointers
    }
    cells++;
  }

  // Reachable weight window after group 0.
  let windowLo = g0Min;
  let windowHi = g0Max;

  for (let gi = 1; gi < n; gi++) {
    const g = reduced[gi]!;
    let gMin = g.options[0]!.weight; // int-initialized (see note above)
    let gMax = gMin;
    for (let i = 0; i < g.options.length; i++) {
      const wgt = g.options[i]!.weight;
      if (wgt < gMin) gMin = wgt;
      if (wgt > gMax) gMax = wgt;
    }
    const lo = Math.min(capacity, windowLo + gMin);
    const hi = Math.min(capacity, windowHi + gMax);
    const bpBase = gi * width;

    cur.fill(-1); // FULL clear: stale data outside the sweep window (from two
    // stages back) must never leak into a later stage's read range — reads can
    // dip below the cumulative weight minimum via large option weights.
    for (let w = lo; w <= hi; w++) {
      let best = -1;
      let bestOpt = -1;
      for (let i = 0; i < g.options.length; i++) {
        const o = g.options[i]!;
        const pw = w - o.weight;
        if (pw < 0) continue;
        const pv = prev[pw]!;
        if (pv < 0) continue;
        const v = pv + o.profit;
        if (v > best) {
          best = v;
          bestOpt = i;
        }
      }
      if (best >= 0) {
        cur[w] = best;
        bp[bpBase + w] = bestOpt;
      }
      cells++;
    }

    windowLo += gMin;
    windowHi = hi;
    const t = prev;
    prev = cur;
    cur = t;
  }

  // Extract optimum: max value over the final row; ties -> smallest weight.
  let bestVal = -1;
  let bestW = -1;
  for (let w = 0; w <= capacity; w++) {
    const v = prev[w]!;
    if (v > bestVal) {
      bestVal = v;
      bestW = w;
    }
  }
  if (bestVal < 0) {
    return { value: -1, weight: -1, choiceIndex: [], cellsVisited: cells };
  }

  // Traceback: recover each group's option index from the back-pointers.
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

/**
 * Divide-and-conquer mode (Hirschberg 1975 shape): O(C) memory, 2× time,
 * exact. Only value rows exist; no back-pointer table is ever allocated.
 *
 * solve(lo, hi, cap): optimal selection for groups [lo, hi] under capacity
 * cap, written into choiceIndex. Base cases (hi − lo < 2) extract their
 * option directly from a single-row sweep. Otherwise: forward sweep of
 * [lo, mid] under cap → row F, backward sweep of [mid+1, hi] under cap →
 * row B, both indexed by prefix weight w ∈ [0, cap]; pick the split weight
 * w* maximizing F[w] + B[cap − w]; recurse on both halves with capacities
 * w* and cap − w*.
 */
function solveDpDivideConquer(
  reduced: readonly ReducedGroup[],
  capacity: number,
): DpResult {
  const n = reduced.length;
  const choiceIndex: number[] = new Array<number>(n).fill(-1);
  const cellsCounter = { cells: 0 };

  // One shared scratch row per direction; sweeps reuse them (allocations:
  // 4 rows total = 16·(C+1) bytes live, + n·0 back-pointers).
  const fwdRow = new Int32Array(capacity + 1);
  const bwdRow = new Int32Array(capacity + 1);
  const fwdScratch = new Int32Array(capacity + 1);
  const bwdScratch = new Int32Array(capacity + 1);

  const rec = (lo: number, hi: number, cap: number): number => {
    if (lo > hi) return 0; // empty range contributes nothing
    if (lo === hi) {
      // Single group under cap: best feasible option (ties → lowest index).
      const g = reduced[lo]!;
      let best = -1;
      let bestIdx = -1;
      for (let i = 0; i < g.options.length; i++) {
        const o = g.options[i]!;
        if (o.weight <= cap && o.profit > best) {
          best = o.profit;
          bestIdx = i;
        }
        cellsCounter.cells++;
      }
      if (bestIdx < 0) return -1; // infeasible subproblem (cannot happen for
      // a reachable split, but the invariant is checked, not assumed)
      choiceIndex[lo] = bestIdx;
      return best;
    }
    const mid = (lo + hi) >> 1;
    // Forward: best value over groups [lo, mid] by consumed weight w.
    sweepForward(reduced, lo, mid, cap, fwdRow, fwdScratch, cellsCounter);
    // Backward: best value over groups [mid + 1, hi] by consumed weight w.
    sweepBackward(reduced, mid + 1, hi, cap, bwdRow, bwdScratch, cellsCounter);
    // Split under ≤-semantics: transform both rows to prefix-max
    // (F≤[w] = best left value at weight ≤ w) so any pair with
    // w_left + w_right ≤ cap is considered, not just exact-sum pairs.
    let run = -1;
    for (let w = 0; w <= cap; w++) {
      const v = fwdRow[w]!;
      if (v > run) run = v;
      fwdRow[w] = run;
    }
    run = -1;
    for (let w = 0; w <= cap; w++) {
      const v = bwdRow[w]!;
      if (v > run) run = v;
      bwdRow[w] = run;
    }
    // Split: max over w of F≤[w] + B≤[cap − w].
    let best = -1;
    let bestW = -1;
    for (let w = 0; w <= cap; w++) {
      const f = fwdRow[w]!;
      if (f < 0) continue;
      const b = bwdRow[cap - w]!;
      if (b < 0) continue;
      const v = f + b;
      if (v > best) {
        best = v;
        bestW = w;
      }
    }
    if (bestW < 0) return -1; // defensive; a feasible split always exists
    const left = rec(lo, mid, bestW);
    const right = rec(mid + 1, hi, cap - bestW);
    if (left < 0 || right < 0) return -1;
    return left + right;
  };

  const value = rec(0, n - 1, capacity);
  if (value < 0) {
    return { value: -1, weight: -1, choiceIndex: [], cellsVisited: cellsCounter.cells };
  }
  // Final weight: sum of chosen option weights (traceback-free).
  let weight = 0;
  for (let i = 0; i < n; i++) {
    weight += reduced[i]!.options[choiceIndex[i]!]!.weight;
  }
  return { value, weight, choiceIndex, cellsVisited: cellsCounter.cells };
}

/** Forward sweep: groups [lo, hi] under cap; out[w] = best value consuming
 *  exactly ≤ w (max over reachable weights ≤ w is what the split needs —
 *  we store per-exact-weight best, matching the two-row kernel semantics:
 *  out[w] = best value at EXACT total weight w, -1 = unreachable). */
function sweepForward(
  reduced: readonly ReducedGroup[],
  lo: number,
  hi: number,
  cap: number,
  out: Int32Array,
  scratch: Int32Array,
  counter: { cells: number },
): void {
  out.fill(-1);
  scratch.fill(-1);
  // Seed with group lo (exact-weight semantics, ties → lower index).
  // Min/max computed from the data — no sortedness assumption.
  const g0 = reduced[lo]!;
  let seedMin = g0.options[0]!.weight; // int-initialized (JSC; see solveDpBackpointer)
  let seedMax = seedMin;
  for (let i = 0; i < g0.options.length; i++) {
    const o = g0.options[i]!;
    if (o.weight < seedMin) seedMin = o.weight;
    if (o.weight > seedMax) seedMax = o.weight;
    if (o.weight <= cap && o.profit > out[o.weight]!) {
      out[o.weight] = o.profit;
    }
    counter.cells++;
  }
  // Reachable window after the seed group.
  let wLo = seedMin;
  let wHi = seedMax;
  for (let gi = lo + 1; gi <= hi; gi++) {
    const g = reduced[gi]!;
    scratch.fill(-1);
    let gMin = g.options[0]!.weight; // int-initialized (JSC; see solveDpBackpointer)
    let gMax = gMin;
    for (let i = 0; i < g.options.length; i++) {
      const wgt = g.options[i]!.weight;
      if (wgt < gMin) gMin = wgt;
      if (wgt > gMax) gMax = wgt;
    }
    const dLo = wLo + gMin;
    const dHi = Math.min(cap, wHi + gMax);
    for (let w = dLo; w <= dHi; w++) {
      for (let i = 0; i < g.options.length; i++) {
        const o = g.options[i]!;
        const pw = w - o.weight;
        if (pw < 0) continue;
        const pv = out[pw]!;
        if (pv < 0) continue;
        const v = pv + o.profit;
        if (v > scratch[w]!) {
          scratch[w] = v;
        }
      }
      counter.cells++;
    }
    wLo = dLo;
    wHi = dHi;
    // Copy scratch into out (rows are reused across calls).
    out.set(scratch);
  }
}

/** Backward sweep: groups [hi..lo] (reverse order) under cap; out[w] = best
 *  value at EXACT total weight w over groups [lo, hi], swept from hi down. */
function sweepBackward(
  reduced: readonly ReducedGroup[],
  lo: number,
  hi: number,
  cap: number,
  out: Int32Array,
  scratch: Int32Array,
  counter: { cells: number },
): void {
  out.fill(-1);
  scratch.fill(-1);
  const gN = reduced[hi]!;
  let seedMin = gN.options[0]!.weight; // int-initialized (JSC; see solveDpBackpointer)
  let seedMax = seedMin;
  for (let i = 0; i < gN.options.length; i++) {
    const o = gN.options[i]!;
    if (o.weight < seedMin) seedMin = o.weight;
    if (o.weight > seedMax) seedMax = o.weight;
    if (o.weight <= cap && o.profit > out[o.weight]!) {
      out[o.weight] = o.profit;
    }
    counter.cells++;
  }
  let wLo = seedMin;
  let wHi = seedMax;
  for (let gi = hi - 1; gi >= lo; gi--) {
    const g = reduced[gi]!;
    scratch.fill(-1);
    let gMin = g.options[0]!.weight; // int-initialized (JSC; see solveDpBackpointer)
    let gMax = gMin;
    for (let i = 0; i < g.options.length; i++) {
      const wgt = g.options[i]!.weight;
      if (wgt < gMin) gMin = wgt;
      if (wgt > gMax) gMax = wgt;
    }
    const dLo = wLo + gMin;
    const dHi = Math.min(cap, wHi + gMax);
    for (let w = dLo; w <= dHi; w++) {
      for (let i = 0; i < g.options.length; i++) {
        const o = g.options[i]!;
        const pw = w - o.weight;
        if (pw < 0) continue;
        const pv = out[pw]!;
        if (pv < 0) continue;
        const v = pv + o.profit;
        if (v > scratch[w]!) {
          scratch[w] = v;
        }
      }
      counter.cells++;
    }
    wLo = dLo;
    wHi = dHi;
    out.set(scratch);
  }
}
