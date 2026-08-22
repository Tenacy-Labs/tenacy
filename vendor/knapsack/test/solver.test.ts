import { describe, expect, test } from "bun:test";
import { solve, KnapsackProblem } from "../src/index.ts";
import { solveDp, expectedDpBytes, DEFAULT_DP_BUDGET } from "../src/dp.ts";

/** Deterministic PRNG (mulberry32) so failures reproduce exactly. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface BruteResult {
  best: number;
  feasible: boolean;
}

/** Exhaustive optimum: every combination of one option per group. */
function bruteForce(p: KnapsackProblem): BruteResult {
  let best = -Infinity;
  let feasible = false;
  const combo: number[] = new Array(p.groups.length).fill(0);
  const n = p.groups.length;

  const rec = (gi: number, weight: number, profit: number): void => {
    if (gi === n) {
      feasible = feasible || weight <= p.capacity;
      if (weight <= p.capacity && profit > best) best = profit;
      return;
    }
    for (const o of p.groups[gi]!.options) {
      combo[gi] = o.weight;
      rec(gi + 1, weight + o.weight, profit + o.profit);
    }
  };
  rec(0, 0, 0);
  return { best, feasible };
}

/** Verify the returned choices are valid: one per group, weight <= capacity, value matches. */
function checkChoicesValid(p: KnapsackProblem, result: ReturnType<typeof solve>): void {
  expect(result.status).toBe("optimal");
  const choices = result.choices!;
  expect(choices.length).toBe(p.groups.length);
  let weight = 0;
  let value = 0;
  for (let i = 0; i < choices.length; i++) {
    const g = p.groups[i]!;
    const c = choices[i]!;
    expect(c.groupId).toBe(g.id);
    const opt = g.options.find((o) => o.id === c.optionId);
    expect(opt).toBeDefined();
    weight += opt!.weight;
    value += opt!.profit;
  }
  expect(weight).toBeLessThanOrEqual(p.capacity);
  expect(value).toBe(result.value);
}

describe("solve — randomized brute-force cross-check", () => {
  for (let seed = 1; seed <= 300; seed++) {
    test(`seed ${seed}`, () => {
      const r = rng(seed);
      const nGroups = 2 + Math.floor(r() * 4); // 2..5 groups
      const groups = Array.from({ length: nGroups }, (_, gi) => ({
        id: `g${gi}`,
        options: Array.from(
          { length: 1 + Math.floor(r() * 5) }, // 1..5 options
          (_, oi) => ({
            id: `o${oi}`,
            weight: Math.floor(r() * 30), // 0..29
            profit: Math.floor(r() * 100), // 0..99
          }),
        ),
      }));
      const minW = groups.reduce(
        (s, g) => s + Math.min(...g.options.map((o) => o.weight)),
        0,
      );
      const maxW = groups.reduce(
        (s, g) => s + Math.max(...g.options.map((o) => o.weight)),
        0,
      );
      const capacity = minW + Math.floor(r() * (maxW - minW + 10));
      const problem: KnapsackProblem = { groups, capacity };

      const expected = bruteForce(problem);
      const result = solve(problem);

      if (!expected.feasible || expected.best === -Infinity) {
        // min-weight sum exceeds capacity
        expect(result.status).toBe("infeasible");
        return;
      }
      checkChoicesValid(problem, result);
      expect(result.value).toBe(expected.best);
      // Bounds must bracket the optimum.
      expect(result.bounds!.greedyLower).toBeLessThanOrEqual(result.value);
      expect(result.bounds!.lpUpper).toBeGreaterThanOrEqual(result.value - 1e-9);
    });
  }
});

describe("solve — determinism", () => {
  test("identical problems yield byte-identical choices", () => {
    const r = rng(4242);
    const problem: KnapsackProblem = {
      groups: Array.from({ length: 12 }, (_, gi) => ({
        id: `g${gi}`,
        options: Array.from({ length: 4 }, (_, oi) => ({
          id: `o${oi}`,
          weight: Math.floor(r() * 200),
          profit: Math.floor(r() * 500),
        })),
      })),
      capacity: 800,
    };
    const a = solve(problem);
    const b = solve(problem);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("solve — u8 back-pointer boundary", () => {
  // One group at the full 255-option cap plus a small partner. Exercises
  // option indices up to 254 — adjacent to the 255 unreachable sentinel —
  // through the whole pipeline, against the exhaustive oracle.
  test("255-option group solves correctly at the boundary", () => {
    const wide = Array.from({ length: 255 }, (_, i) => ({
      id: `w${i}`,
      weight: (i * 7) % 97 + 1,
      profit: (i * 13) % 89 + 1,
    }));
    const problem: KnapsackProblem = {
      groups: [
        { id: "wide", options: wide },
        {
          id: "small",
          options: [
            { id: "s0", weight: 2, profit: 3 },
            { id: "s1", weight: 5, profit: 9 },
          ],
        },
      ],
      capacity: 60,
    };
    const expected = bruteForce(problem);
    const result = solve(problem);
    checkChoicesValid(problem, result);
    expect(result.value).toBe(expected.best);
  });

  // The optimum at capacity 60 lands on the option with INDEX 254 (weight
  // 55, profit 500): verify it round-trips through the u8 back-pointers
  // without sentinel aliasing — direct solveDp call, so the DP path is
  // exercised regardless of certificate behavior.
  test("option index 254 is recoverable from the u8 traceback", () => {
    const wide = Array.from({ length: 255 }, (_, i) => ({
      id: `w${i}`,
      weight: i === 254 ? 55 : i + 1, // make the LAST option the winner
      profit: i === 254 ? 500 : 1,
    }));
    const partner = {
      id: "p",
      options: [
        { id: "p0", weight: 0, profit: 0 },
        { id: "p1", weight: 7, profit: 15 },
      ],
      originalCount: 2,
    };
    const reduced = [
      { id: "wide", options: wide, originalCount: 255 },
      partner,
    ];
    const res = solveDp(reduced, 60);
    // Brute oracle over 255 x 2 combos: best is w254 (55,500) + p0 (0,0).
    expect(res.value).toBe(500);
    expect(res.choiceIndex[0]).toBe(254);
    expect(res.choiceIndex[1]).toBe(0);
    // Traceback consistency: weights sum to the reported final weight.
    let w = 0;
    for (let gi = 0; gi < reduced.length; gi++) {
      w += reduced[gi]!.options[res.choiceIndex[gi]!]!.weight;
    }
    expect(w).toBe(res.weight);
    expect(w).toBeLessThanOrEqual(60);
  });
});

describe("solve — divide-and-conquer mode (forced via budget 0)", () => {
  // The D&C path is normally entered only on huge shapes; budget 0 forces
  // it for EVERY problem, so the exhaustive oracle below exercises it the
  // way the randomized battery exercises the back-pointer path.
  for (let seed = 1; seed <= 300; seed++) {
    test(`seed ${seed}`, () => {
      const r = rng(seed);
      const nGroups = 2 + Math.floor(r() * 4); // 2..5 groups
      const groups = Array.from({ length: nGroups }, (_, gi) => ({
        id: `g${gi}`,
        originalCount: 1 + Math.floor(r() * 5),
        options: Array.from(
          { length: 1 + Math.floor(r() * 5) }, // 1..5 options
          (_, oi) => ({
            id: `o${oi}`,
            weight: Math.floor(r() * 30), // 0..29
            profit: Math.floor(r() * 100), // 0..99
          }),
        ),
      }));
      const minW = groups.reduce(
        (s, g) => s + Math.min(...g.options.map((o) => o.weight)),
        0,
      );
      const maxW = groups.reduce(
        (s, g) => s + Math.max(...g.options.map((o) => o.weight)),
        0,
      );
      const capacity = minW + Math.floor(r() * (maxW - minW + 10));

      const res = solveDp(groups as any, capacity, 0);
      const expected = bruteForce({ groups, capacity } as KnapsackProblem);
      if (!expected.feasible || expected.best === -Infinity) {
        expect(res.value).toBe(-1);
        return;
      }
      expect(res.value).toBe(expected.best);
      // Choices must be valid and their weight sum must match res.weight.
      expect(res.weight).toBeLessThanOrEqual(capacity);
      let w = 0;
      for (let i = 0; i < groups.length; i++) {
        const idx = res.choiceIndex[i]!;
        expect(idx).toBeGreaterThanOrEqual(0);
        w += groups[i]!.options[idx]!.weight;
      }
      expect(w).toBe(res.weight);
    });
  }
});

describe("solve — budget switch consistency", () => {
  test("D&C and back-pointer modes agree on identical inputs", () => {
    const r = rng(777);
    for (let t = 0; t < 50; t++) {
      const nGroups = 3 + Math.floor(r() * 5);
      const groups = Array.from({ length: nGroups }, (_, gi) => ({
        id: `g${gi}`,
        originalCount: 4,
        options: Array.from({ length: 2 + Math.floor(r() * 5) }, (_, oi) => ({
          id: `o${oi}`,
          weight: Math.floor(r() * 50),
          profit: Math.floor(r() * 200),
        })),
      }));
      const minW = groups.reduce(
        (s, g) => s + Math.min(...g.options.map((o) => o.weight)),
        0,
      );
      const capacity = minW + Math.floor(r() * 300);
      const a = solveDp(groups as any, capacity, 0); // forced D&C
      const b = solveDp(groups as any, capacity, Infinity); // forced back-pointer
      expect(a.value).toBe(b.value);
      expect(a.weight).toBe(b.weight);
      // Both must achieve the same optimum value; chosen options may differ
      // among co-optimal ties, but the WEIGHT SUMS must match exactly.
      let wa = 0;
      let wb = 0;
      for (let i = 0; i < groups.length; i++) {
        wa += groups[i]!.options[a.choiceIndex[i]!]!.weight;
        wb += groups[i]!.options[b.choiceIndex[i]!]!.weight;
      }
      expect(wa).toBe(wb);
    }
  });

  test("expectedDpBytes matches the documented formula and flips at 50MiB", () => {
    // n·(C+1) + 8·(C+1)
    expect(expectedDpBytes(120, 47316)).toBe(120 * 47317 + 8 * 47317);
    // A3 (n=480, C≈371k): 480·371k ≈ 178MB > 50MiB → D&C
    expect(expectedDpBytes(480, 371000) > DEFAULT_DP_BUDGET).toBe(true);
    // Stress shape (n=120, C≈48k): 5.8MB < 50MiB → back-pointer
    expect(expectedDpBytes(120, 48000) < DEFAULT_DP_BUDGET).toBe(true);
  });
});

describe("solve — edge cases", () => {
  test("infeasible when min weights exceed capacity", () => {
    const result = solve({
      groups: [
        { id: "a", options: [{ id: "x", weight: 10, profit: 5 }] },
        { id: "b", options: [{ id: "y", weight: 10, profit: 5 }] },
      ],
      capacity: 15,
    });
    expect(result.status).toBe("infeasible");
    expect(result.choices).toBeNull();
  });

  test("capacity 0 with zero-weight options is feasible", () => {
    const result = solve({
      groups: [
        { id: "a", options: [{ id: "free", weight: 0, profit: 7 }] },
        { id: "b", options: [{ id: "free", weight: 0, profit: 3 }] },
      ],
      capacity: 0,
    });
    expect(result.status).toBe("optimal");
    expect(result.value).toBe(10);
  });

  test("zero-capacity purge-only problem picks zero-weight options", () => {
    const result = solve({
      groups: [
        {
          id: "a",
          options: [
            { id: "purge", weight: 0, profit: 0 },
            { id: "keep", weight: 5, profit: 9 },
          ],
        },
      ],
      capacity: 0,
    });
    expect(result.status).toBe("optimal");
    expect(result.value).toBe(0);
    expect(result.choices![0]!.optionId).toBe("purge");
  });

  test("LP gap zero skips the DP", () => {
    const result = solve({
      groups: [
        {
          id: "a",
          options: [
            { id: "small", weight: 1, profit: 1 },
            { id: "big", weight: 2, profit: 2 },
          ],
        },
      ],
      capacity: 100, // everything fits; LP integral
    });
    expect(result.status).toBe("optimal");
    expect(result.value).toBe(2);
    expect(result.stats!.dpRequired).toBe(false);
  });

  test("validation rejects negative/float weights", () => {
    expect(() =>
      solve({
        groups: [{ id: "a", options: [{ id: "x", weight: -1, profit: 1 }] }],
        capacity: 5,
      }),
    ).toThrow(/weight/);
    expect(() =>
      solve({
        groups: [{ id: "a", options: [{ id: "x", weight: 1.5, profit: 1 }] }],
        capacity: 5,
      }),
    ).toThrow(/weight/);
    expect(() =>
      solve({
        groups: [{ id: "a", options: [{ id: "x", weight: 1, profit: 1 }] }],
        capacity: -5,
      }),
    ).toThrow(/capacity/);
  });
});

describe("dominance — hull reduction", () => {
  test("dominated options vanish", async () => {
    const { reduceGroupToHull } = await import("../src/dominance.ts");
    const hull = reduceGroupToHull({
      id: "g",
      options: [
        { id: "bad-heavy-poor", weight: 10, profit: 1 }, // dominated by light-rich
        { id: "light-rich", weight: 3, profit: 9 },
        { id: "mid", weight: 5, profit: 6 },
        { id: "heavy-best", weight: 12, profit: 20 },
        { id: "dominated-tie", weight: 5, profit: 5 }, // dominated by mid
      ],
    });
    const ids = hull.options.map((o) => o.id);
    // mid(5,6) IS dominated: light-rich(3,9) has lower weight AND higher profit.
    expect(ids).toEqual(["light-rich", "heavy-best"]);
    // Hull invariants: weight strictly increasing, profit strictly increasing.
    for (let i = 1; i < hull.options.length; i++) {
      expect(hull.options[i]!.weight).toBeGreaterThan(hull.options[i - 1]!.weight);
      expect(hull.options[i]!.profit).toBeGreaterThan(hull.options[i - 1]!.profit);
    }
  });
});
