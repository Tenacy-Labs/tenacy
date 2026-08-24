// SPIKE 001: int16 representation for the MCKP DP
// Question: can prev/cur value arrays (and weights/profits) be Int16Array
// without silent overflow, and if so, is the win material?
//
// Facts from the live call site (stowage src/solver.ts relief):
//   SCALE = 1000; keepP = round((utility + strand) * SCALE)
//   utilities ~ [0, 50]; weights = raw token counts; capacity ~ window budget
const INT16_MAX = 32767, UINT16_MAX = 65535, INT32_MAX = 2147483647;

// --- Probe 1: single-option profit range at the call site's scale ---
const pOne = Math.round(50 * 1000); // utility 50, SCALE 1000
console.log("single-option profit (utility 50):", pOne,
  "| int16 ok:", pOne <= INT16_MAX, "| uint16 ok:", pOne <= UINT16_MAX);

// --- Probe 2: accumulated DP value bound, realistic relief shape ---
const nItems = 10_000, utilMean = 10;
const accBound = Math.round(nItems * utilMean * 1000); // conservative mean 10
const accWorst = Math.round(nItems * 50 * 1000);       // all at utility 50
console.log("accumulated value bound (10k items, mean util 10):", accBound,
  "| int16:", accBound <= INT16_MAX, "| int32:", accBound <= INT32_MAX);
console.log("accumulated worst case (10k x util 50):", accWorst,
  "| int32:", accWorst <= INT32_MAX);

// --- Probe 3: weights and capacity ---
console.log("capacity 900k exceeds int16:", 900_000 > INT16_MAX,
  "| 200k-token lens option exceeds int16:", 200_000 > INT16_MAX);

// --- Probe 4: the only VALID int16 regime — small windows ---
// Run the actual DP recurrence both ways on a window where everything fits:
// capacity 30k, utilities capped < 30, weights < 30k. Measure time + memory.
function buildProblem(groups: number, cap: number, utilCap: number) {
  const g = [];
  for (let i = 0; i < groups; i++) {
    const w = 50 + ((i * 7919) % (cap / groups | 0));
    const u = 1 + ((i * 104729) % utilCap);
    g.push({
      id: "g" + i,
      options: [
        { id: "keep", weight: w, profit: Math.round(u * 1000 / 1000 * 33) },
        { id: "evict", weight: 0, profit: 0 },
      ],
    });
  }
  return { groups: g, capacity: cap };
}

// Measurement: same recurrence, Int32 vs Int16 storage, overflow detection.
function dpGeneric(T: Int32ArrayConstructor | Int16ArrayConstructor, weights: Int32Array, profits: Int32Array, starts: Int32Array, lens: Int32Array, cap: number) {
  const prev = new T(cap + 1) as Int32Array;
  const cur = new T(cap + 1) as Int32Array;
  const nGroups = lens.length;
  let overflow = 0;
  for (let g = 0; g < nGroups; g++) {
    const s = starts[g]!, l = lens[g]!;
    for (let w = 0; w <= cap; w++) cur[w] = prev[w]!;
    let maxW = 0;
    for (let k = 0; k < l; k++) maxW = Math.max(maxW, weights[s + k]!);
    for (let w = cap; w >= 0; w--) {
      let best = prev[w]!; let bo = 0;
      for (let k = 0; k < l; k++) {
        const ww = weights[s + k]!;
        if (ww > w) continue;
        const cand = (prev[w - ww]! + profits[s + k]!) | 0;
        const wrapped = T === Int16Array && (cand > INT16_MAX || cand < -INT16_MAX - 1);
        if (wrapped) overflow++;
        if (cand > best && !wrapped) { best = cand; bo = k + 1; }
      }
      cur[w] = best;
    }
    const tmp = prev;
    // swap prev/cur by copy (spike simplicity)
    (prev as Int32Array).set(cur);
    void tmp;
  }
  return { value: prev[cap]!, overflow };
}

const groups = 300, cap = 30_000, utilCap = 30;
const { groups: gg } = buildProblem(groups, cap, utilCap);
const weights: number[] = [], profits: number[] = [], starts: number[] = [], lens: number[] = [];
for (const g of gg) {
  starts.push(weights.length);
  for (const o of g.options) { weights.push(o.weight); profits.push(o.profit); }
  lens.push(g.options.length);
}
const W = new Int32Array(weights), P = new Int32Array(profits),
  S = new Int32Array(starts), L = new Int32Array(lens);

// Verify every profit fits int16 in this rigged-best-case regime
const maxP = Math.max(...profits);
console.log("\nvalid-regime probe (300 groups, cap 30k, profits <=" + maxP + "):");

let t0 = performance.now();
const r32 = dpGeneric(Int32Array, W, P, S, L, cap);
const ms32 = performance.now() - t0;
t0 = performance.now();
const r16 = dpGeneric(Int16Array, W, P, S, L, cap);
const ms16 = performance.now() - t0;
console.log("Int32:", ms32.toFixed(1) + "ms value=" + r32.value);
console.log("Int16:", ms16.toFixed(1) + "ms value=" + r16.value, "overflows=" + r16.overflow);
console.log("same value:", r32.value === r16.value);
console.log("memory: value arrays", ((cap + 1) * 4 * 2 / 1024).toFixed(0) + "KB int32 vs",
  ((cap + 1) * 2 * 2 / 1024).toFixed(0) + "KB int16");
