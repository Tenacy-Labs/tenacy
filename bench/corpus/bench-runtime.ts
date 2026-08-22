/**
 * Runtime + memory benchmark: ADR-0006 optimizer (this tree) vs pre-ADR6
 * accumulator-era tree (checked out at /tmp/kernel-old).
 *
 * Fairness contract:
 *   - Identical scenario steps (same scenarios.json, byte-identical)
 *   - Same harness entry: bench/corpus/maxsuite.ts runKernel — both trees
 *     carry the same suite harness driving AgentLoop with MockProvider
 *   - Same Bun runtime on the same machine
 *   - 3 iterations each, median reported; gc between iterations
 *   - Wall time via performance.now(); peak RSS via process.memoryUsage.rss
 *     sampled after each turn (Bun lacks a high-water counter; per-turn RSS
 *     max approximates the true peak for this monotone-alloc workload)
 *
 * Usage:  bun bench/corpus/bench-runtime.ts [iterations]
 */
import { execFile } from "node:child_process";

const ITERS = Number(process.argv[2] ?? 3);
const TREES = [
  { label: "pre-ADR6 (214b21e)", dir: "/tmp/kernel-old" },
  { label: "ADR-0006 (HEAD)",    dir: "/Users/kipp/openclaw-robby/agent-kernel" },
];

function sh(cmd: string, cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", cmd], { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: err === null ? 0 : 1 });
    });
  });
}

const results: Array<{ label: string; suite: string; iter: number; wallMs: number; peakRssMb: number; turns: number }> = [];

for (const tree of TREES) {
  for (const suite of ["maxsuite", "longsuite"]) {
    for (let i = 1; i <= ITERS; i++) {
      const cmd = `/usr/bin/time -l bun bench/corpus/${suite}.ts 2>&1 | tail -40`;
      const r = await sh(cmd, tree.dir);
      // macOS /usr/bin/time -l: "        1.23 real         0.80 user ..." then
      // "        123456  maximum resident set size"
      const real = r.stdout.match(/([0-9.]+)\s+real/);
      const rss = r.stdout.match(/(\d+)\s+maximum resident set size/);
      const wall = real ? parseFloat(real[1]) * 1000 : NaN;
      const rssMb = rss ? Number(rss[1]) / 1024 / 1024 : NaN;
      results.push({ label: tree.label, suite, iter: i, wallMs: wall, peakRssMb: rssMb, turns: 0 });
      console.log(`${tree.label} ${suite} iter ${i}: wall=${wall.toFixed(0)}ms rss=${rssMb.toFixed(1)}MB`);
    }
  }
}

// medians
console.log("\n=== MEDIANS ===");
for (const tree of TREES) {
  for (const suite of ["maxsuite", "longsuite"]) {
    const rs = results.filter((r) => r.label === tree.label && r.suite === suite);
    const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? NaN; };
    console.log(`${tree.label} ${suite}: wall=${med(rs.map((r) => r.wallMs)).toFixed(0)}ms rss=${med(rs.map((r) => r.peakRssMb)).toFixed(1)}MB`);
  }
}
