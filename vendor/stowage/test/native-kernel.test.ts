// Native SIMD kernel: stowage-side coverage of the vendored copy.
// The dylib ships for aarch64-apple-darwin; other hosts (CI linux x86_64)
// exercise the loader's fallback contract: nativeAvailable() === false and
// dpKernel "native" silently degrades to the TS SoA kernel with identical
// results. On aarch64 hosts this file also runs the full 500-problem
// differential against the shipped dylib.
import { describe, expect, test } from "bun:test";
import { solve } from "../../knapsack/src/solve.ts";
import { solveDpSoa } from "../../knapsack/src/dp-soa.ts";
import {
  solveDpNative,
  nativeAvailable,
  _resetNativeCache,
} from "../../knapsack/src/native.ts";
import type { ReducedGroup } from "../../knapsack/src/types.ts";

function xorshift32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17; s >>>= 0;
    s ^= s << 5; s >>>= 0;
    return s;
  };
}

function reducedProblem(nGroups: number, capacity: number, seed: number, maxOpts: number, tiePct: number): ReducedGroup[] {
  const rnd = xorshift32(seed);
  const groups: ReducedGroup[] = [];
  for (let g = 0; g < nGroups; g++) {
    const nOpts = 2 + rnd() % maxOpts;
    const options: { id: string; weight: number; profit: number }[] = [];
    for (let o = 0; o < nOpts; o++) {
      const w = 1 + rnd() % Math.max(2, Math.floor(capacity * 0.02));
      const p = tiePct > 0 && rnd() % 100 < tiePct ? 1000 : 1 + rnd() % 5000;
      options.push({ id: "o" + o, weight: w, profit: p });
    }
    options.sort((a, b) => a.weight - b.weight);
    groups.push({ id: "g" + g, options, originalCount: options.length });
  }
  return groups;
}

describe("vendored native kernel (stowage side)", () => {
  test("differential vs soa incl cellsVisited when dylib present (500 problems)", () => {
    if (!nativeAvailable()) {
      console.log("[native-kernel] no dylib on this host (expected on CI linux) -> differential skipped");
      return;
    }
    let ran = 0;
    let mismatches = 0;
    for (let i = 0; i < 500; i++) {
      const nG = 5 + (i % 40);
      const cap = 200 + (i * 37) % 3000;
      const tiePct = i % 3 === 0 ? 15 : 0;
      const groups = reducedProblem(nG, cap, 1234 + i, 6, tiePct);
      const soa = solveDpSoa(groups, cap);
      const nat = solveDpNative(groups, cap);
      if (nat === null) continue;
      ran++;
      if (
        soa.value !== nat.value || soa.weight !== nat.weight ||
        JSON.stringify(soa.choiceIndex) !== JSON.stringify(nat.choiceIndex) ||
        soa.cellsVisited !== nat.cellsVisited
      ) {
        mismatches++;
      }
    }
    expect(ran).toBeGreaterThan(0);
    console.log("[native-kernel] differential ran", ran, "problems; mismatches", mismatches);
    expect(mismatches).toBe(0);
  }, 60_000);

  test("dpKernel native: soa-identical results whether dylib present or absent", () => {
    const groups = reducedProblem(14, 500, 555, 6, 10);
    const soa = solveDpSoa(groups, 500);
    const soaIds = soa.choiceIndex.map((ci, gi) => groups[gi]!.options[ci]!.id);
    const viaNative = solve(
      { groups: groups as never, capacity: 500 },
      { dpKernel: "native" } as never,
    );
    expect(viaNative.status).toBe("optimal");
    expect(viaNative.value).toBe(soa.value);
    expect(JSON.stringify(viaNative.choices?.map((c) => c.optionId))).toBe(JSON.stringify(soaIds));
  });

  test("forced-absent dylib: graceful fallback with soa-identical results", () => {
    process.env.KNAPSACK_NATIVE_DYLIB = "/nonexistent/path.dylib";
    _resetNativeCache();
    try {
      expect(nativeAvailable()).toBe(false);
      const groups = reducedProblem(11, 450, 31337, 5, 20);

      const soa = solveDpSoa(groups, 450);
      const soaIds = soa.choiceIndex.map((ci, gi) => groups[gi]!.options[ci]!.id);
      const viaNative = solve(
        { groups: groups as never, capacity: 450 },
        { dpKernel: "native" } as never,
      );
      expect(viaNative.status).toBe("optimal");
      expect(viaNative.value).toBe(soa.value);
      expect(JSON.stringify(viaNative.choices?.map((c) => c.optionId))).toBe(JSON.stringify(soaIds));
    } finally {
      delete process.env.KNAPSACK_NATIVE_DYLIB;
      _resetNativeCache();
    }
  });

  test("C1 regression: out-of-i32 weight passes validation, must not crash — falls back to soa", () => {
    // PR4 review C1: a weight of 2^31+100 passes validateProblem (only
    // profit sums and the 2^53 envelope are bounded), truncates negative in
    // the Int32Array flatten, and crashed the native kernel (SIGABRT via
    // panic=abort). The TS i32 guard must reject -> null -> soa fallback,
    // producing the same answer as dpKernel "reference".
    const groups = [
      { id: "g0", options: [
        { id: "a", weight: 1, profit: 1 },
        { id: "b", weight: 2, profit: 3 },
      ], originalCount: 2 },
      { id: "g1", options: [
        { id: "a", weight: 2147483748, profit: 5 }, // 2^31 + 100
        { id: "b", weight: 3, profit: 2 },
      ], originalCount: 2 },
    ];
    const problem = { groups, capacity: 10 };
    const ref = solve(problem, { dpKernel: "reference" });
    expect(ref.status).toBe("optimal");
    expect(ref.value).toBe(5);
    // The exact crash repro: this call aborted the process pre-fix.
    const nat = solve(problem, { dpKernel: "native" });
    expect(nat.status).toBe("optimal");
    expect(nat.value).toBe(5);
    expect(JSON.stringify(nat.choices?.map((c) => c.optionId))).toBe(
      JSON.stringify(ref.choices?.map((c) => c.optionId)),
    );
  });


  test("C1 regression (g0 placement): out-of-i32 weight in the FIRST group — pre-fix SIGABRT shape", () => {
    const groups = [
      { id: "g0", options: [
        { id: "a", weight: 2147483748, profit: 5 }, // 2^31 + 100, FIRST group
        { id: "b", weight: 2, profit: 3 },
      ], originalCount: 2 },
      { id: "g1", options: [
        { id: "a", weight: 1, profit: 1 },
        { id: "b", weight: 3, profit: 2 },
      ], originalCount: 2 },
    ];
    const problem = { groups, capacity: 10 };
    const ref = solve(problem, { dpKernel: "reference" });
    expect(ref.status).toBe("optimal");
    const nat = solve(problem, { dpKernel: "native" });
    expect(nat.status).toBe("optimal");
    expect(nat.value).toBe(ref.value);
    expect(JSON.stringify(nat.choices?.map((c) => c.optionId))).toBe(
      JSON.stringify(ref.choices?.map((c) => c.optionId)),
    );
  });

});
