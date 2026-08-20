// Crash-recovery test that runs recovery in a GENUINELY fresh process (lesson from the
// build: in-process recovery tests can false-pass when session globals persist).
// Spawned by test/kernel.test.ts via Bun.spawnSync; exit code = failure count.
import { Kernel } from "../src/kernel.ts";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agent-kernel-fresh-"));
const sideFile = join(dir, "sideeffect.txt");
rmSync(sideFile, { force: true });

// Host injects the op, agent cell fires a real append.
(globalThis as any).appendLine = (s: string) => {
  const { appendFileSync } = require("node:fs");
  appendFileSync(sideFile, s + "\n");
};

const k = new Kernel(join(dir, "journal.jsonl"), join(dir, "snapshot.json"));
k.eval("var n = 1");
k.eval("var data = [10, 20, 30]");
k.eval("appendLine('side-effect-once')"); // fires ONCE, ever
k.eval("var total = data.reduce((a,b)=>a+b,0)");
k.eval("var big = Array.from({length: 20000}, (_, i) => ({ id: i, v: i * 1.5, tag: 'x' + (i % 7) }))");

const before = readFileSync(sideFile, "utf8").trim().split("\n");
if (before.length !== 1) { console.error("setup failed: side effect did not fire exactly once"); process.exit(1); }

// ---- Crash. Nothing survives except files. ----
const rec = Kernel.recover(join(dir, "journal.jsonl"), join(dir, "snapshot.json"));

const after = readFileSync(sideFile, "utf8").trim().split("\n");
let fails = 0;
const checks: [string, boolean, string][] = [
  ["recovery replays zero cells", rec.replayed === 0, String(rec.replayed)],
  ["n restored", rec.k.ns.n === 1, String(rec.k.ns.n)],
  ["data restored", JSON.stringify(rec.k.ns.data) === "[10,20,30]", JSON.stringify(rec.k.ns.data)],
  ["total restored", rec.k.ns.total === 60, String(rec.k.ns.total)],
  ["big restored (20000 records)", Array.isArray(rec.k.ns.big) && rec.k.ns.big.length === 20000 && rec.k.ns.big[19999].v === 29998.5, `len ${rec.k.ns.big?.length}`],
  ["side effect exactly-once across crash+recovery", after.length === 1 && after[0] === "side-effect-once", after.join(";")],
  ["journal intact as audit record (5 cells)", rec.k.cells.length === 5, String(rec.k.cells.length)],
];
for (const [name, pass, detail] of checks) {
  console.log(`  ${pass ? "PASS" : "FAIL"} | ${name} (${detail})`);
  if (!pass) fails++;
}
process.exit(fails);
