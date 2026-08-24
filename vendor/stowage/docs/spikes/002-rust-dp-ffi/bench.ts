// SPIKE 002 harness: Rust dp-soa via Bun FFI — differential + head-to-head.
import { dlopen, suffix } from "bun:ffi";
import { solveDpSoa } from "../../../openclaw-robby/stowage/vendor/knapsack/src/dp-soa.ts";

const lib = dlopen("target/release/libdp_soa.dylib", {
  solve_dp_soa: {
    args: ["ptr", "ptr", "ptr", "int", "int", "ptr", "ptr"],
    returns: "int",
    nonblocking: false,
  },
  solve_dp_unbounded: {
    args: ["ptr", "ptr", "ptr", "int", "int", "ptr", "ptr"],
    returns: "int",
    nonblocking: false,
  },
});

// Deterministic problem generator (xorshift32 — same stream TS-side and Rust-side)
function xorshift32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
}

function buildProblem(nGroups: number, capacity: number, seed: number, maxOpts: number, wMaxFrac: number, tieP: number) {
  const rnd = xorshift32(seed);
  const groups: { id: string; options: { id: string; weight: number; profit: number }[] }[] = [];
  const flatW: number[] = [], flatP: number[] = [], groupStart: number[] = [0];
  for (let g = 0; g < nGroups; g++) {
    const nOpts = 2 + (rnd() % maxOpts);
    const opts: { id: string; weight: number; profit: number }[] = [];
    for (let o = 0; o < nOpts; o++) {
      const w = 1 + (rnd() % Math.max(2, Math.floor(capacity * wMaxFrac)));
      const p = tieP > 0 && (rnd() % 100) < tieP ? 1000 : 1 + (rnd() % 5000);
      opts.push({ id: "o" + o, weight: w, profit: p });
    }
    opts.sort((a, b) => a.weight - b.weight);
    groups.push({ id: "g" + g, options: opts });
    for (const o of opts) { flatW.push(o.weight); flatP.push(o.profit); }
    groupStart.push(flatW.length);
  }
  return { groups, flatW, flatP, groupStart };
}

function rustSolveUnbounded(flatW: number[], flatP: number[], groupStart: number[], capacity: number) {
  const n = groupStart.length - 1;
  const W = Int32Array.from(flatW); const P = Int32Array.from(flatP); const G = Int32Array.from(groupStart);
  const out = new Int32Array(3); const choices = new Int32Array(n);
  const rc = lib.symbols.solve_dp_unbounded(W, P, G, n, capacity, out, choices);
  if (rc === -2) return { rc, value: -1, weight: -1, cells: 0, choices: [] as number[] };
  return { rc, value: out[0], weight: out[1], cells: out[2], choices: Array.from(choices) };
}

function rustSolve(flatW: number[], flatP: number[], groupStart: number[], capacity: number) {
  const n = groupStart.length - 1;
  const W = Int32Array.from(flatW);
  const P = Int32Array.from(flatP);
  const G = Int32Array.from(groupStart);
  const out = new Int32Array(3);
  const choices = new Int32Array(n);
  const rc = lib.symbols.solve_dp_soa(W, P, G, n, capacity, out, choices);
  if (rc === -2) return { rc, value: -1, weight: -1, cells: 0, choices: [] as number[] };
  return { rc, value: out[0], weight: out[1], cells: out[2], choices: Array.from(choices) };
}

// Differential: 400 randomized problems, mixed shapes
let mismatches = 0;
const tA = performance.now();
for (let i = 0; i < 400; i++) {
  const nG = 5 + (i % 60);
  const cap = 200 + (i * 37) % 3000;
  const { groups, flatW, flatP, groupStart } = buildProblem(nG, cap, 1234 + i, 5, 0.08, i % 3 === 0 ? 15 : 0);
  const tsRes = solveDpSoa(groups as never, cap);
  const rsRes = rustSolve(flatW, flatP, groupStart, cap);
  const tsArr = tsRes.value < 0 ? [] : tsRes.choiceIndex;
  const rsArr = rsRes.value < 0 ? [] : rsRes.choices;
  if (tsRes.value !== rsRes.value || tsRes.weight !== rsRes.weight ||
      JSON.stringify(tsArr) !== JSON.stringify(rsArr)) {
    mismatches++;
    if (mismatches <= 3) console.log("MISMATCH seed", 1234 + i, "ts", tsRes.value, tsRes.weight, "rust", rsRes.value, rsRes.weight);
  }
}
const diffMs = performance.now() - tA;
console.log("differential: 400 problems,", mismatches, "mismatches,", diffMs.toFixed(0) + "ms");

// Head-to-head: 30k capacity (both kernels fit under the 50MiB budget)
const { groups, flatW, flatP, groupStart } = buildProblem(300, 30_000, 42, 5, 0.003, 0);
let t0 = performance.now();
const tsRes = solveDpSoa(groups as never, 30_000);
const tsMs = performance.now() - t0;
t0 = performance.now();
const rsRes = rustSolve(flatW, flatP, groupStart, 30_000);
const rsMs = performance.now() - t0;
console.log("30k head-to-head: TS", tsMs.toFixed(1) + "ms (" + tsRes.cellsVisited + " cells)  Rust", rsMs.toFixed(1) + "ms (" + rsRes.cells + " cells)");
console.log("agree:", tsRes.value === rsRes.value, tsRes.weight === rsRes.weight, JSON.stringify(tsRes.choiceIndex) === JSON.stringify(rsRes.choices));
console.log("values:", tsRes.value, rsRes.value, "weights:", tsRes.weight, rsRes.weight);

// Budget-edge head-to-head: 150k capacity, 300 groups (bp table 45MB, under 50MiB)
const edge = buildProblem(300, 150_000, 77, 5, 0.0006, 0);
let t1 = performance.now();
const eTs = solveDpSoa(edge.groups as never, 150_000);
const eTsMs = performance.now() - t1;
t1 = performance.now();
const eRs = rustSolve(edge.flatW, edge.flatP, edge.groupStart, 150_000);
const eRsMs = performance.now() - t1;
console.log("150k budget-edge: TS", eTsMs.toFixed(0) + "ms  Rust", eRsMs.toFixed(0) + "ms  ratio", (eTsMs / eRsMs).toFixed(2) + "x");
console.log("edge agree:", eTs.value === eRs.value, eTs.weight === eRs.weight);

// Guard: the over-budget refusal path (200k capacity, 300 groups)
const big = buildProblem(300, 200_000, 43, 5, 0.003, 0);
const rc = rustSolve(big.flatW, big.flatP, big.groupStart, 200_000);
console.log("over-budget guard: rc =", rc.rc, "(expect -1)");

// THE HEADLINE REGIME: capacity where TS must fall back to divide-and-conquer
// (measured 1.68s at 200k) but Rust runs the straight back-pointer DP.
const huge = buildProblem(300, 200_000, 99, 5, 0.00045, 0);
let t3 = performance.now();
const hRs = rustSolveUnbounded(huge.flatW, huge.flatP, huge.groupStart, 200_000);
const hRsMs = performance.now() - t3;
console.log("200k unbounded Rust:", hRs.rc, "value", hRs.value, "weight", hRs.weight, hRsMs.toFixed(0) + "ms");

// THE ORIGINAL WALL: tie-heavy geometry (near-identical utilities) — full
// windowing, worst-case scan. TS measured 1.68s @200k and 42s @1M (D&C).
const tie200 = buildProblem(300, 200_000, 7, 2, 0.0004, 100);
t3 = performance.now();
const tie200r = rustSolveUnbounded(tie200.flatW, tie200.flatP, tie200.groupStart, 200_000);
const tie200rMs = performance.now() - t3;
t3 = performance.now();
const tie200t = solveDp(tie200.groups as never, 200_000);
const tie200tMs = performance.now() - t3;
console.log("TIE-HEAVY 200k: Rust bp", tie200rMs.toFixed(0) + "ms  TS D&C", tie200tMs.toFixed(0) + "ms  ratio", (tie200tMs / tie200rMs).toFixed(1) + "x");
console.log("tie200 agree:", tie200r.value === tie200t.value, tie200r.weight === tie200t.weight);

const tie1m = buildProblem(300, 1_000_000, 8, 2, 0.0004, 100);
t3 = performance.now();
const tie1mr = rustSolveUnbounded(tie1m.flatW, tie1m.flatP, tie1m.groupStart, 1_000_000);
const tie1mrMs = performance.now() - t3;
console.log("TIE-HEAVY 1M (narrow-window generator — NOT the 42s geometry): Rust bp", (tie1mrMs / 1000).toFixed(1) + "s  value", tie1mr.value, "weight", tie1mr.weight);
// TS reference at 200k uses divide-and-conquer solveDp — time it for honesty
import { solveDp } from "../../../openclaw-robby/stowage/vendor/knapsack/src/dp.ts";
let t2 = performance.now();
const hTs = solveDp(huge.groups as never, 200_000);
const hTsMs = performance.now() - t2;
console.log("200k TS divide-and-conquer:", hTsMs.toFixed(0) + "ms value", hTs.value, "weight", hTs.weight);

// THE TRUE WALL (reviewer shape): thousands of groups so the window fills
// the capacity — the 7.6-12.9B cell regime. 5k groups x 200k, weights ~40-80
// so the window fills after ~3k groups. Rust bp table = 5k x 200k = 1GB
// (measurable on this machine; production design = Rust Hirschberg D&C).
const wall = buildProblem(5_000, 200_000, 555, 2, 0.0004, 100);
let t4 = performance.now();
const wallR = rustSolveUnbounded(wall.flatW, wall.flatP, wall.groupStart, 200_000);
const wallRMs = performance.now() - t4;
console.log("WALL 5k x 200k Rust bp (1GB table):", wallR.rc, "value", wallR.value, (wallRMs / 1000).toFixed(1) + "s");
t4 = performance.now();
const wallT = solveDp(wall.groups as never, 200_000);
const wallTMs = performance.now() - t4;
console.log("WALL 5k x 200k TS D&C:", (wallTMs / 1000).toFixed(1) + "s  ratio", (wallTMs / wallRMs).toFixed(1) + "x");
console.log("wall agree:", wallR.value === wallT.value, wallR.weight === wallT.weight);

