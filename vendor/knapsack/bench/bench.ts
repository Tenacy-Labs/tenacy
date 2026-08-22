/**
 * Benchmark: agent-kernel-shaped instances (tens of groups × few options,
 * integer token weights) and stress shapes beyond it.
 *
 * Run: bun run bench/bench.ts
 */
import { solve } from "../src/index.ts";

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

interface Shape {
  name: string;
  groups: number;
  options: number;
  maxWeight: number;
  capacityFactor: number; // fraction of the way from min-sum to max-sum
  iterations: number;
}

const SHAPES: Shape[] = [
  { name: "agent-kernel small (20g × 3o, w≤400)", groups: 20, options: 3, maxWeight: 400, capacityFactor: 0.5, iterations: 2000 },
  { name: "agent-kernel full (60g × 5o, w≤600)", groups: 60, options: 5, maxWeight: 600, capacityFactor: 0.6, iterations: 500 },
  { name: "agent-kernel stress (120g × 6o, w≤800)", groups: 120, options: 6, maxWeight: 800, capacityFactor: 0.5, iterations: 200 },
  { name: "wide capacity (40g × 4o, cap 8k)", groups: 40, options: 4, maxWeight: 2000, capacityFactor: 0.55, iterations: 300 },
  { name: "LP-friendly (30g × 3o, roomy)", groups: 30, options: 3, maxWeight: 100, capacityFactor: 0.95, iterations: 1000 },
];

function buildProblem(shape: Shape, r: () => number) {
  const groups = Array.from({ length: shape.groups }, (_, gi) => {
    const opts = Array.from({ length: shape.options }, (_, oi) => ({
      id: `o${oi}`,
      weight: 1 + Math.floor(r() * shape.maxWeight),
      profit: 1 + Math.floor(r() * 1000),
    }));
    return { id: `g${gi}`, options: opts };
  });
  const minW = groups.reduce((s, g) => s + Math.min(...g.options.map((o) => o.weight)), 0);
  const maxW = groups.reduce((s, g) => s + Math.max(...g.options.map((o) => o.weight)), 0);
  const capacity = Math.round(minW + shape.capacityFactor * (maxW - minW));
  return { groups, capacity };
}

console.log("shape | iters | total ms | per-solve µs (median of batch means)");
console.log("---|---|---|---");
for (const shape of SHAPES) {
  // Warmup.
  const w = rng(1);
  for (let i = 0; i < 20; i++) solve(buildProblem(shape, w));

  const batchMeans: number[] = [];
  const Batches = 5;
  const perBatch = shape.iterations / Batches;
  let dpRuns = 0;
  let totalCells = 0;
  for (let b = 0; b < Batches; b++) {
    const r = rng(100 + b);
    const problems = Array.from({ length: perBatch }, () => buildProblem(shape, r));
    const t0 = performance.now();
    for (const p of problems) {
      const res = solve(p);
      if (res.stats?.dpRequired) {
        dpRuns++;
        totalCells += res.stats.dpCellsVisited;
      }
    }
    batchMeans.push((performance.now() - t0) / perBatch);
  }
  batchMeans.sort((a, b) => a - b);
  const median = batchMeans[Math.floor(batchMeans.length / 2)]!;
  const dpPct = Math.round((100 * dpRuns) / shape.iterations);
  console.log(
    `${shape.name} | ${shape.iterations} | ${(median * shape.iterations).toFixed(0)} | ${Math.round(median * 1000)}µs (DP ${dpPct}%, ${dpRuns ? Math.round(totalCells / dpRuns) : 0} cells avg)`,
  );
}
