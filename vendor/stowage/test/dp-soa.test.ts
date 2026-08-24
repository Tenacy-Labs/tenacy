// Differential test: SoA DP vs reference DP - equal value/weight/choiceIndex.
import { describe, expect, test } from "bun:test";
import { solveDp } from "../../knapsack/src/dp.ts";
import { solveDpSoa } from "../../knapsack/src/dp-soa.ts";
import type { ReducedGroup } from "../../knapsack/src/types.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
  };
}

function mkGroup(id: string, options: { id: string; weight: number; profit: number }[]): ReducedGroup {
  return { id, options, originalCount: options.length };
}

function assertEq(groups: ReducedGroup[], cap: number) {
  const ref = solveDp(groups, cap);
  const soa = solveDpSoa(groups, cap);
  expect(soa.value).toBe(ref.value);
  expect(soa.weight).toBe(ref.weight);
  expect(soa.choiceIndex).toEqual(ref.choiceIndex);
}

describe("SoA DP differential", () => {
  test("equal outputs on randomized problems", () => {
    const rng = mulberry32(42);
    for (let trial = 0; trial < 300; trial++) {
      const n = 2 + Math.floor(rng() * 12);
      const cap = 50 + Math.floor(rng() * 450);
      const groups: ReducedGroup[] = [];
      for (let gi = 0; gi < n; gi++) {
        const k = 1 + Math.floor(rng() * 4);
        const options = [];
        for (let i = 0; i < k; i++) options.push({ id: "o" + i, weight: 1 + Math.floor(rng() * 40), profit: 1 + Math.floor(rng() * 500) });
        groups.push(mkGroup("g" + gi, options));
      }
      assertEq(groups, cap);
    }
  });
  test("tied-profits relief geometry", () => {
    const rng = mulberry32(7);
    for (let trial = 0; trial < 50; trial++) {
      const n = 20 + Math.floor(rng() * 30);
      const cap = 200 + Math.floor(rng() * 300);
      const groups: ReducedGroup[] = [];
      for (let gi = 0; gi < n; gi++) {
        const options = [{ id: "keep", weight: 20 + Math.floor(rng() * 30), profit: 5000 }, { id: "evict", weight: 0, profit: 0 }];
        groups.push(mkGroup("g" + gi, options));
      }
      assertEq(groups, cap);
    }
  });
});
