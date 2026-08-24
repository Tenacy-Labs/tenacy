// SPIKE 003 harness: scalar vs loop-interchange vs NEON inner loop.
// Differential vs the TS SoA kernel (oracle) + head-to-head timings.
import { dlopen } from "bun:ffi";
import { solveDpSoa } from "/Users/kipp/openclaw-robby/stowage/vendor/knapsack/src/dp-soa.ts";

const lib = dlopen("target/release/libdp_soa.dylib", {
  solve_dp_soa:      { args: ["ptr","ptr","ptr","int","int","ptr","ptr"], returns: "int" },
  solve_dp_ic:       { args: ["ptr","ptr","ptr","int","int","ptr","ptr"], returns: "int" },
  solve_dp_simd:     { args: ["ptr","ptr","ptr","int","int","ptr","ptr"], returns: "int" },
});

function xorshift32(seed: number) {
  let s = seed >>> 0;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s; };
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

function callRust(fn: any, flatW: number[], flatP: number[], groupStart: number[], capacity: number) {
  const n = groupStart.length - 1;
  const W = Int32Array.from(flatW); const P = Int32Array.from(flatP); const G = Int32Array.from(groupStart);
  const out = new Int32Array(3); const choices = new Int32Array(n);
  const rc = fn(W, P, G, n, capacity, out, choices);
  if (rc !== 0) return { rc, value: -1, weight: -1, choices: [] as number[] };
  return { rc, value: out[0], weight: out[1], choices: Array.from(choices) };
}

// ---- differential: 400 problems, all three variants vs TS oracle ----
let misA = 0, misB = 0, misC = 0;
for (let i = 0; i < 400; i++) {
  const nG = 5 + (i % 60);
  const cap = 200 + (i * 37) % 3000;
  const { groups, flatW, flatP, groupStart } = buildProblem(nG, cap, 1234 + i, 5, 0.08, i % 3 === 0 ? 15 : 0);
  const ts = solveDpSoa(groups as never, cap);
  const A = callRust(lib.symbols.solve_dp_soa, flatW, flatP, groupStart, cap);
  const B = callRust(lib.symbols.solve_dp_ic, flatW, flatP, groupStart, cap);
  const C = callRust(lib.symbols.solve_dp_simd, flatW, flatP, groupStart, cap);
  const tsArr = ts.value < 0 ? [] : ts.choiceIndex;
  for (const [r, tag] of [[A,"A"],[B,"B"],[C,"C"]] as const) {
    const ok = ts.value === r.value && ts.weight === r.weight &&
      JSON.stringify(tsArr) === JSON.stringify(r.choices);
    if (!ok) {
      if (tag === "A") misA++;
      if (tag === "B") misB++;
      if (tag === "C") misC++;
      if (misA + misB + misC <= 3) console.log("MISMATCH", tag, "seed", 1234 + i, "ts", ts.value, ts.weight, "rust", r.value, r.weight);
    }
  }
}
console.log("differential (400 problems): A", misA, "B", misB, "C", misC, "mismatches");

// ---- head-to-head ----
function bench(tag: string, fn: any, flatW: number[], flatP: number[], groupStart: number[], cap: number) {
  fn(flatW, flatP, groupStart, cap); // warm
  const t0 = performance.now();
  const r = fn(flatW, flatP, groupStart, cap);
  const ms = performance.now() - t0;
  console.log(tag, ms.toFixed(1) + "ms", "rc", r.rc, "value", r.value);
  return r;
}
const shapes = [
  { tag: "30k typical",      nG: 300,  cap: 30_000,  seed: 42,  wF: 0.003, tie: 0 },
  { tag: "200k tie-heavy",   nG: 300,  cap: 200_000, seed: 7,   wF: 0.0004, tie: 100 },
  { tag: "wall 5k x 200k",   nG: 5_000, cap: 200_000, seed: 555, wF: 0.0004, tie: 100 },
];
for (const s of shapes) {
  const { flatW, flatP, groupStart } = buildProblem(s.nG, s.cap, s.seed, 5, s.wF, s.tie);
  console.log("---", s.tag, "---");
  const rA = bench("  A scalar", (fw: number[], fp: number[], gs: number[], c: number) => callRust(lib.symbols.solve_dp_soa, fw, fp, gs, c), flatW, flatP, groupStart, s.cap);
  const rB = bench("  B interchange", (fw: number[], fp: number[], gs: number[], c: number) => callRust(lib.symbols.solve_dp_ic, fw, fp, gs, c), flatW, flatP, groupStart, s.cap);
  const rC = bench("  C neon", (fw: number[], fp: number[], gs: number[], c: number) => callRust(lib.symbols.solve_dp_simd, fw, fp, gs, c), flatW, flatP, groupStart, s.cap);
  console.log("  agree A/B/C:", rA.value === rB.value && rB.value === rC.value, rA.weight === rB.weight && rB.weight === rC.weight);
}
