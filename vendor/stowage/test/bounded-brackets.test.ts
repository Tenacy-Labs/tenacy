// R2-1 regression (2026-08-24): the bounded branch reported
// walk.break.upperBound - a Dantzig bound valid ONLY on convex hulls - as
// lpUpper for the fathomed (non-convex) sets. On non-convex shapes the
// walk's break bound can fall below OPT, so the "certified" interval
// failed to bracket OPT (reviewer repro: lpUpper 84 < OPT 98; four more
// found by seeded xorshift search - this file is machine-generated from
// that search, /tmp/r21gen.ts). Fix: lpUpper = max(lp.upperBound,
// walk.break.upperBound) - the hull LP is already computed at solve.ts:78.
import { solve } from "../../knapsack/src/solve.ts";
import type { KnapsackProblem } from "../../knapsack/src/types.ts";
import { test, expect } from "bun:test";

const CASES: KnapsackProblem[] = [
  {"groups": [{"id": "g0","options": [{"id": "o0","weight": 6,"profit": 1},{"id": "o1","weight": 6,"profit": 2},{"id": "o2","weight": 1,"profit": 1},{"id": "o3","weight": 9,"profit": 15}]},{"id": "g1","options": [{"id": "o0","weight": 5,"profit": 10},{"id": "o1","weight": 9,"profit": 10},{"id": "o2","weight": 9,"profit": 14}]},{"id": "g2","options": [{"id": "o0","weight": 2,"profit": 9},{"id": "o1","weight": 3,"profit": 18},{"id": "o2","weight": 2,"profit": 11},{"id": "o3","weight": 6,"profit": 15}]},{"id": "g3","options": [{"id": "o0","weight": 4,"profit": 13},{"id": "o1","weight": 6,"profit": 2}]}],"capacity": 24},
  {"groups": [{"id": "g0","options": [{"id": "o0","weight": 1,"profit": 15},{"id": "o1","weight": 1,"profit": 9}]},{"id": "g1","options": [{"id": "o0","weight": 3,"profit": 14},{"id": "o1","weight": 1,"profit": 8},{"id": "o2","weight": 5,"profit": 12},{"id": "o3","weight": 5,"profit": 13}]},{"id": "g2","options": [{"id": "o0","weight": 2,"profit": 2},{"id": "o1","weight": 6,"profit": 15},{"id": "o2","weight": 3,"profit": 4},{"id": "o3","weight": 6,"profit": 12}]},{"id": "g3","options": [{"id": "o0","weight": 6,"profit": 5},{"id": "o1","weight": 3,"profit": 15},{"id": "o2","weight": 1,"profit": 2}]}],"capacity": 11},
  {"groups": [{"id": "g0","options": [{"id": "o0","weight": 4,"profit": 1},{"id": "o1","weight": 1,"profit": 1},{"id": "o2","weight": 5,"profit": 9}]},{"id": "g1","options": [{"id": "o0","weight": 7,"profit": 3},{"id": "o1","weight": 8,"profit": 13},{"id": "o2","weight": 6,"profit": 2}]},{"id": "g2","options": [{"id": "o0","weight": 2,"profit": 13},{"id": "o1","weight": 7,"profit": 12}]},{"id": "g3","options": [{"id": "o0","weight": 3,"profit": 1},{"id": "o1","weight": 8,"profit": 10},{"id": "o2","weight": 5,"profit": 15}]}],"capacity": 19},
  {"groups": [{"id": "g0","options": [{"id": "o0","weight": 1,"profit": 10},{"id": "o1","weight": 1,"profit": 3},{"id": "o2","weight": 3,"profit": 9},{"id": "o3","weight": 8,"profit": 15}]},{"id": "g1","options": [{"id": "o0","weight": 7,"profit": 17},{"id": "o1","weight": 5,"profit": 11},{"id": "o2","weight": 7,"profit": 6},{"id": "o3","weight": 2,"profit": 10}]},{"id": "g2","options": [{"id": "o0","weight": 9,"profit": 13},{"id": "o1","weight": 3,"profit": 17},{"id": "o2","weight": 2,"profit": 3},{"id": "o3","weight": 9,"profit": 18}]}],"capacity": 15},
];

test("bounded lpUpper brackets OPT (R2-1: non-convex Dantzig violation)", () => {
  for (const problem of CASES) {
    const exact = solve(problem, {});
    expect(exact.status).toBe("optimal");
    const bnd = solve(problem, { reliefMode: "bounded", maxDpBytes: 5 });
    expect(bnd.status).toBe("bounded");
    expect(bnd.value).toBe(bnd.bounds!.greedyLower);
    expect(bnd.bounds!.lpUpper).toBeGreaterThanOrEqual(exact.value - 1e-9);
  }
});
