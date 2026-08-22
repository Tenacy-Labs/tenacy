// Probe 3: journal accumulation counter — how many pending deltas at each turn,
// and what option ids does options() actually emit?
import { FileLensItem } from "./src/optimizer/lens.ts";

const LINES = 100;
const base = Array.from({ length: LINES }, (_, i) => `line ${i + 1} ${"x".repeat(30)}`).join("\n");
const deltaLines: number[][] = [[10], [25, 26], [40], [55, 56, 57], [70]];

const lens = new FileLensItem("lens:probe.ts", "probe.ts", base);
lens.expand(1, LINES);
lens.valueBump = { amount: 8, untilTurn: 99 };
lens.commitConsolidation("full", 2);              // establish base @t2
console.log("after full commit @t2: baseBlockTurn =", lens.baseBlockTurn, "pending =", lens.pendingDeltas.length);
for (let turn = 3; turn <= 8; turn++) {
  if (turn <= 7) {
    const lines = deltaLines[turn - 3]!;
    lens.noteLiveDelta(turn, lines);
  }
  const ids = lens.options().map((o) => o.id);
  console.log(`t${turn}: pending=${lens.pendingDeltas.length} [${lens.pendingDeltas.map((d) => "t" + d.turn).join(",")}]  options: ${ids.join(" | ")}`);
}
