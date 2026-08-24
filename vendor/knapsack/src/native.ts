// Native (SIMD) kernel loader — spike 003 productionized.
// Max-compat policy: a prebuilt cdylib is shipped per (platform, arch)
// triple under native/prebuilt/; any host without a matching dylib (or a
// failed dlopen) gets `null` and the caller falls back to the TypeScript
// SoA kernel. Correctness is identical either way — the native kernel is
// differential-tested against solveDpSoa (value, weight, choices, AND
// cellsVisited) wherever a dylib is present.
import { dlopen } from "bun:ffi";
import type { ReducedGroup } from "./types.ts";
import { expectedDpBytes, type DpResult } from "./dp.ts";

// Keep in sync with native/src/lib.rs DEFAULT_DP_BUDGET and dp.ts.
import { DEFAULT_DP_BUDGET } from "./dp.ts";

type NativeFn = (
  flatW: Int32Array, flatP: Int32Array, groupStart: Int32Array,
  n: number, capacity: number, out: Int32Array, outChoices: Int32Array,
) => number;

interface NativeLib {
  readonly knapsack_dp: NativeFn;
}

let cached: NativeLib | null | undefined;

function triple(): string | null {
  const os = process.platform;
  const arch = process.arch;
  if (os === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (os === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (os === "linux" && arch === "arm64") return "aarch64-unknown-linux-gnu";
  if (os === "linux" && arch === "x64") return "x86_64-unknown-linux-gnu";
  return null;
}

function tryLoad(): NativeLib | null {
  if (cached !== undefined) return cached;
  cached = null;
  try {
    const override = process.env.KNAPSACK_NATIVE_DYLIB;
    const t = override !== undefined && override !== "" ? null : triple();
    const path = override !== undefined && override !== ""
      ? override
      : t === null
        ? null
        : `${import.meta.dir}/../native/prebuilt/${t}.dylib`;
    if (path === null) return cached;
    const lib = dlopen(path, {
      knapsack_dp: {
        args: ["ptr", "ptr", "ptr", "int", "int", "ptr", "ptr"],
        returns: "int",
      },
    });
    const fn = (lib.symbols as Record<string, unknown>)["knapsack_dp"];
    if (typeof fn !== "function") return cached;
    cached = { knapsack_dp: fn as NativeFn };
  } catch {
    cached = null;
  }
  return cached;
}

/** Test hook: clear the cached handle (fallback-path tests). */
export function _resetNativeCache(): void {
  cached = undefined;
}

/** True when a native dylib loaded on this host. */
export function nativeAvailable(): boolean {
  return tryLoad() !== null;
}

// Window pre-pass: reproduces solveDpSoa's cellsVisited counter (per-group
// w-loop iterations + g0 option scans) WITHOUT running the DP, so stats
// stay comparable across kernels. Must mirror dp-soa.ts exactly.
function countCells(reduced: readonly ReducedGroup[], capacity: number): number {
  const n = reduced.length;
  let cells = 0;
  const g0 = reduced[0]!;
  let g0Min = g0.options[0]!.weight;
  let g0Max = g0Min;
  for (const opt of g0.options) {
    const wgt = opt.weight;
    if (wgt < g0Min) g0Min = wgt;
    if (wgt > g0Max) g0Max = wgt;
    cells++;
  }
  let windowLo = g0Min;
  let windowHi = g0Max;
  for (let gi = 1; gi < n; gi++) {
    const g = reduced[gi]!;
    let gMin = g.options[0]!.weight;
    let gMax = gMin;
    for (const opt of g.options) {
      if (opt.weight < gMin) gMin = opt.weight;
      if (opt.weight > gMax) gMax = opt.weight;
    }
    const hi = Math.min(capacity, windowHi + gMax);
    const lo = Math.min(capacity, windowLo + gMin);
    cells += hi - lo + 1;
    windowLo += gMin;
    windowHi = hi;
  }
  return cells;
}

/**
 * solveDpNative: the SIMD kernel behind the same budget gate as SoA.
 * Returns null when no dylib is available (caller falls back to
 * solveDpSoa). Over-budget inputs also return null (the caller's budget
 * gate should have routed them to solveDp already; this mirrors the
 * kernel's own rc -1 as belt-and-braces).
 */
export function solveDpNative(
  reduced: readonly ReducedGroup[],
  capacity: number,
  maxDpBytes: number = DEFAULT_DP_BUDGET,
): DpResult | null {
  const lib = tryLoad();
  if (lib === null) return null;
  const n = reduced.length;
  if (n === 0 || expectedDpBytes(n, capacity) > maxDpBytes) return null;
  // i32-range inputs are guaranteed upstream: solve.ts filters weight > capacity
  // (capacity <= 2^21-1 by validation), and profits < 2^31 by the MAX_TOTAL_PROFIT
  // gate; the in-kernel validation (lib.rs, rc -3) is defense in depth.
  const total = reduced.reduce((s, g) => s + g.options.length, 0);
  const flatW = new Int32Array(total);
  const flatP = new Int32Array(total);
  const groupStart = new Int32Array(n + 1);
  let k = 0;
  for (let gi = 0; gi < n; gi++) {
    for (const opt of reduced[gi]!.options) {
      flatW[k] = opt.weight;
      flatP[k] = opt.profit;
      k++;
    }
    groupStart[gi + 1] = k;
  }
  const out = new Int32Array(2);
  const outChoices = new Int32Array(n);
  const rc = lib.knapsack_dp(
    flatW, flatP, groupStart, n, capacity, out, outChoices,
  );
  if (rc === -2) {
    // Infeasible (mirrors solveDpSoa's {value:-1} infeasible result).
    return { value: -1, weight: -1, choiceIndex: [], cellsVisited: countCells(reduced, capacity) };
  }
  if (rc !== 0) return null;
  return {
    value: out[0]!,
    weight: out[1]!,
    choiceIndex: Array.from(outChoices),
    cellsVisited: countCells(reduced, capacity),
  };
}
