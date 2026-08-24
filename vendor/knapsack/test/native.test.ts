// Native SIMD kernel tests (spike 003 productionized, 2026-08-24).
// Three invariants:
//  1. Differential: wherever a dylib is present, solveDpNative agrees with
//     solveDpSoa on value, weight, choiceIndex, AND cellsVisited.
//  2. Fallback honesty: with the dylib absent/unloadable, solve.ts with
//     dpKernel "native" returns soa-identical results (graceful TS path).
//  3. Default unchanged: dpKernel "reference"/absent never touches native.
import { describe, expect, test } from "bun:test";
import { solve } from "../src/solve.ts";
import { solveDpSoa } from "../src/dp-soa.ts";
import { solveDpNative, nativeAvailable, _resetNativeCache } from "../src/native.ts";
import type { ReducedGroup } from "../src/types.ts";

function xorshift32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17; s >>>= 0;
    s ^= s << 5; s >>>= 0;
    return s;
  };
}

/** Randomized reduced-group problems (the differential generator). */
function reducedProblem(
  nGroups: number, capacity: number, seed: number, maxOpts = 6, tiePct = 0,
): ReducedGroup[] {
  const rnd = xorshift32(seed);
  const groups: ReducedGroup[] = [];
  for (let g = 0; g < nGroups; g++) {
    const nOpts = 2 + rnd() % maxOpts;
    const options = [];
    for (let o = 0; o < nOpts; o++) {
      const w = 1 + rnd() % Math.max(2, Math.floor(capacity * 0.08));
      const p = tiePct > 0 && rnd() % 100 < tiePct ? 1000 : 1 + rnd() % 5000;
      options.push({ id: "o" + o, weight: w, profit: p });
    }
    options.sort((a, b) => a.weight - b.weight);
    groups.push({ id: "g" + g, options, originalCount: options.length });
  }
  return groups;
}

describe("native SIMD kernel (spike 003 productionized)", () => {
  test("differential: native agrees with soa on value/weight/choices/cells (500 problems)", () => {
    if (!nativeAvailable()) {
      console.log("no dylib on this host -> differential skipped");
      return;
    }
    let mismatches = 0;
    let ran = 0;
    for (let i = 0; i < 500; i++) {
      const nG = 5 + (i % 60);
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
        if (mismatches <= 3) {
          console.log("MISMATCH seed", 1234 + i, "soa", soa.value, soa.weight, "nat", nat.value, nat.weight);
        }
      }
    }
    expect(ran).toBeGreaterThan(0);
    console.log("differential ran", ran, "of 500 problems; mismatches", mismatches);
    expect(mismatches).toBe(0);
  }, 60_000);

  test("fallback: dpKernel native falls back to soa when dylib is absent", () => {
    const groups = reducedProblem(12, 400, 777, 6, 10);
    const viaSolve = solve(
      { groups: groups as never, capacity: 400 },
      { dpKernel: "native" } as never,
    );
    const soa = solveDpSoa(groups, 400);
    const soaIds = soa.choiceIndex.map((ci, gi) => groups[gi]!.options[ci]!.id);
    expect(viaSolve.status).toBe("optimal");
    expect(viaSolve.value).toBe(soa.value);
    expect(JSON.stringify(viaSolve.choices?.map((c) => c.optionId))).toBe(JSON.stringify(soaIds));
  });

  test("fallback honesty: corrupt dylib path -> null loader -> soa-identical solve", () => {
    process.env.KNAPSACK_NATIVE_DYLIB = "/nonexistent/libknapsack_native.dylib";
    _resetNativeCache();
    try {
      expect(nativeAvailable()).toBe(false);
      const groups = reducedProblem(9, 350, 991, 5, 20);
      const viaSolve = solve(
        { groups: groups as never, capacity: 350 },
        { dpKernel: "native" } as never,
      );
      const soa = solveDpSoa(groups, 350);
      const soaIds = soa.choiceIndex.map((ci, gi) => groups[gi]!.options[ci]!.id);
      expect(viaSolve.status).toBe("optimal");
    expect(viaSolve.value).toBe(soa.value);
      expect(JSON.stringify(viaSolve.choices?.map((c) => c.optionId))).toBe(JSON.stringify(soaIds));
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


// PR #5: default dpKernel policy — prefer native, fall back to soa.
// Host-agnostic by construction: a dylib host asserts "native"; an absent
// dylib (CI linux x86_64) asserts the soa fallback. Outputs on the default
// path must equal explicit "reference" outputs either way.

function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dpRequiredProblem(seed: number) {
  const rnd = mulberry32(seed);
  const groups = [];
  for (let g = 0; g < 12; g++) {
    const opts = [];
    for (let o = 0; o < 4; o++) {
      const w = [60, 150, 300, 500][o]! + Math.floor(rnd() * 20);
      opts.push({ id: "o" + o, weight: w, profit: Math.floor(2.2 * w - 0.0028 * w * w + rnd() * 25) });
    }
    groups.push({ id: "g" + g, options: opts, originalCount: 4 });
  }
  return { groups, capacity: 900 };
}

describe("default dpKernel policy (PR #5)", () => {
  test("default solve() prefers native when the dylib is present, soa otherwise", () => {
    const problem = dpRequiredProblem(1);
    const r = solve(problem);
    expect(r.stats!.dpRequired).toBe(true);
    if (nativeAvailable()) {
      expect(r.stats!.dpKernelUsed).toBe("native");
    } else {
      expect(r.stats!.dpKernelUsed).toBe("soa");
    }
  });

  test("forced-absent dylib: default solve() falls back to soa with identical outputs", () => {
    const problem = dpRequiredProblem(2);
    const env = { ...process.env, KNAPSACK_NATIVE_DYLIB: "/nonexistent/knapsack.dylib" };
    process.env = env as Record<string, string>;
    _resetNativeCache();
    try {
      const r = solve(problem);
      const ref = solve(problem, { dpKernel: "reference" });
      expect(r.stats!.dpKernelUsed).toBe("soa");
      expect(r.value).toBe(ref.value);
      expect(JSON.stringify(r.choices)).toBe(JSON.stringify(ref.choices));
    } finally {
      delete process.env.KNAPSACK_NATIVE_DYLIB;
      _resetNativeCache();
    }
  });

  test("explicit reference opt-out unchanged", () => {
    const problem = dpRequiredProblem(3);
    const r = solve(problem, { dpKernel: "reference" });
    expect(r.stats!.dpKernelUsed).toBe("reference");
  });

  test("LP-integral problem: no DP runs, dpKernelUsed none", () => {
    const groups = [
      { id: "g0", options: [{ id: "a", weight: 10, profit: 100 }], originalCount: 1 },
      { id: "g1", options: [{ id: "a", weight: 10, profit: 100 }], originalCount: 1 },
    ];
    const r = solve({ groups, capacity: 1000 });
    expect(r.stats!.dpRequired).toBe(false);
    expect(r.stats!.dpKernelUsed).toBe("none");
  });

  test("default-path outputs equal reference outputs across a sweep (host-agnostic)", () => {
    for (let i = 0; i < 40; i++) {
      const problem = dpRequiredProblem(100 + i);
      const d = solve(problem);
      const r = solve(problem, { dpKernel: "reference" });
      if (d.value !== r.value || JSON.stringify(d.choices) !== JSON.stringify(r.choices)) {
        throw new Error(`mismatch at ${i}: ${d.value} vs ${r.value}`);
      }
    }
  });
});
