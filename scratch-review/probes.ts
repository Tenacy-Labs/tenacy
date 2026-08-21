/**
 * Review verification probes — temporary, not committed.
 * Each probe prints PASS/FAIL-style evidence for a candidate finding.
 */
import { AgentLoop } from "../src/optimizer/loop.ts";
import { ScriptedProvider, MockProvider } from "../src/optimizer/providers.ts";
import { paramSetV1 } from "../src/optimizer/params.ts";
import { StandingItem } from "../src/optimizer/items.ts";
import { solve } from "../src/optimizer/solver.ts";
import { render } from "../src/optimizer/renderer.ts";
import { ContextStore } from "../src/optimizer/store.ts";
import { makeTurnItem } from "../src/optimizer/loop.ts";
import { refitMuAlpha } from "../src/optimizer/refit.ts";
import { loadCorpus } from "../src/optimizer/corpus.ts";
import { FileLensItem } from "../src/optimizer/items.ts";
import { parseIntentsFromText } from "../src/optimizer/live.ts";

const ps = paramSetV1("mock-1");

// ── Probe 1: two failing same-op intents in ONE turn → duplicate err id → run() throws?
console.log("── probe 1: duplicate failing intents same turn ──");
{
  const agent = new AgentLoop(new MockProvider(), ps, null);
  agent.store.add(new StandingItem("identity", "identity", "x").toContextItem());
  // model proposes two failing ctx.search intents (bad regex) in one reply
  const scripted = new ScriptedProvider([
    { text: "trying two bad searches", intents: [
      { op: "ctx.search", pattern: "(bad" },
      { op: "ctx.search", pattern: "[worse" },
    ] },
  ]);
  const a2 = new AgentLoop(scripted, ps, null);
  a2.store.add(new StandingItem("identity", "identity", "x").toContextItem());
  try {
    const out = await a2.run("go");
    console.log("run() completed; toolResults:", JSON.stringify(out.toolResults, null, 0).slice(0, 300));
    console.log("RESULT: no crash");
  } catch (e) {
    console.log("RESULT: run() THREW:", String(e));
  }
}

// ── Probe 2: Placement.digest (serialize) vs Block digest (option.text) mismatch
console.log("── probe 2: placement digest vs rendered block digest ──");
{
  const store = new ContextStore();
  // TurnItem with a summary attached → summary option chosen has different text than serialize()
  const t = makeTurnItem("turn-1-user", "user", "hello world", 1);
  t.summary = "hi";
  store.add(t);
  const r = solve(store.snapshot(), { rendered: new Map(), totalTokens: 0 }, ps, 2);
  const rr = render(r.placements, store.snapshot(), ps);
  for (const p of r.placements) {
    const blk = rr.blocks.find((b) => b.itemId === p.id);
    console.log(`item=${p.id} option=${p.optionId} placementDigest=${p.digest} blockDigest=${blk?.digest} match=${p.digest === blk?.digest}`);
  }
}

// ── Probe 3: transactionCost suffix — position independence
console.log("── probe 3: rewrite cost ignores position ──");
{
  // two identical lenses at different positions; compute via solve on crafted incumbent
  // Direct: read the code path — suffix = totalTokens - prev.position*0 = totalTokens
  const incumbent = { rendered: new Map(), totalTokens: 50_000 };
  const item = makeTurnItem("t", "user", "x", 1);
  // emulate transactionCost through solve is indirect; assert the arithmetic instead
  const pos = 1; const pos2 = 100;
  const s1 = Math.max(0, incumbent.totalTokens - pos * 0);
  const s2 = Math.max(0, incumbent.totalTokens - pos2 * 0);
  console.log(`suffix(pos=1)=${s1} suffix(pos=100)=${s2} identical=${s1 === s2} (position term dead: *0)`);
}

// ── Probe 4: refit guard on REAL ledger data (mu0 priors 2–10 vs fitted clamp ≤1)
console.log("── probe 4: refit prior-divergence guard on real-shaped data ──");
{
  // simulate real ledger items with real mu0 priors (episodic mu0=3, alpha=1)
  const items = [];
  for (let i = 0; i < 50; i++) {
    const deltaT = i % 5;
    items.push({
      turn: i, id: `turn-${i}`, 
      forecast: { mu0: 3, alpha: 1, deltaT, hazard: 0, basis: "prior" as const, expectedValue: 3 * Math.pow(1 + deltaT, -1) },
      utility: { benefit: 3, cacheCost: 0, rotShare: 0, total: 3 },
      decision: "keep" as const, accepted: true, marginVsHysteresis: 1,
    });
  }
  const corpus = { turns: [], items: items as never, caches: [], provenance: "realized" as const, sources: [], parameterSetVersions: [], modelIds: ["mock-1"] };
  const res = refitMuAlpha(corpus as never, 0.5);
  console.log("status:", res.status, "| reason:", res.reason ?? "-");
  for (const d of res.diagnostics) console.log(`  kind=${d.kind} n=${d.n} fittedMu0=${d.fittedMu0.toFixed(3)} fittedAlpha=${d.fittedAlpha.toFixed(3)} (prior mu0=3 alpha=1)`);
  for (const d of res.divergenceFromPrior) console.log(`  kind=${d.kind} mu0Delta=${d.mu0Delta.toFixed(3)} alphaDelta=${d.alphaDelta.toFixed(3)} overGuard=${d.overGuard}`);
}

// ── Probe 5: BASE+DELTA option surface unreachable in live loop (baseBlockTurn never set)
console.log("── probe 5: lens base+delta options in live loop ──");
{
  const agent = new AgentLoop(new MockProvider(), ps, null);
  agent.fileContent = () => Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
  agent.steer({ op: "files.expand", target: "f.txt", from: 1, to: 50 });
  await agent.run("open");
  const after = await agent.run("again");
  const lensPlacement = after.placements.find((p) => p.id === "lens:f.txt");
  console.log("lens optionId after 2 renders:", lensPlacement?.optionId, "(base+delta requires baseBlockTurn>=0, which nothing sets)");
  const lensItem = agent.store.get("lens:f.txt") as unknown as { baseBlockTurn: number };
  console.log("baseBlockTurn still:", lensItem?.baseBlockTurn);
}

// ── Probe 6: hysteresis-rejected challenger ledger margin sign (types.ts says negative for rejected)
console.log("── probe 6: rejected-challenger margin sign ──");
{
  const store = new ContextStore();
  const lens = new FileLensItem("lens:d.txt", "d.txt", "x".repeat(600));
  lens.expand(1, 8);
  lens.baseBlockTurn = 1;
  store.add(lens.toContextItem());
  const first = solve(store.snapshot(), { rendered: new Map(), totalTokens: 0 }, ps, 1);
  // mutate content so full != incumbent but utilities shift → challenger edges out
  const lens2 = new FileLensItem("lens:d.txt", "d.txt", "y".repeat(600) + "extra tail content changing density");
  lens2.expand(1, 8);
  lens2.baseBlockTurn = 1;
  const store2 = new ContextStore();
  store2.add(lens2.toContextItem());
  const inc = {
    rendered: new Map(first.placements.map((p) => [p.id, {
      position: p.position, zone: p.zone, digest: p.digest,
      representation: p.representation, optionId: p.optionId,
    }] as const)),
    totalTokens: first.totalTokens,
  };
  const second = solve(store2.snapshot(), inc, ps, 2);
  const rejected = second.itemLedgers.filter((l) => l.accepted === false);
  for (const rj of rejected) console.log(`  rejected id=${rj.id} decision=${rj.decision} marginVsHysteresis=${rj.marginVsHysteresis.toFixed(3)} (doc: "negative for rejected near-misses")`);
  if (rejected.length === 0) console.log("  (no rejected ledgers this probe)");
}

// ── Probe 7: NaN / zero-token option robustness in relief
console.log("── probe 7: relief with zero-token and NaN ──");
{
  const store = new ContextStore();
  const zero = makeTurnItem("z", "user", "", 1); // zero-ish tokens
  store.add(zero);
  const tight = { ...ps, budgetLambda: 0 };
  const r = solve(store.snapshot(), { rendered: new Map(), totalTokens: 0 }, tight, 1);
  console.log("zero-token item under budget 0: totalTokens=", r.totalTokens, "dropped:", r.itemLedgers.filter((l) => l.decision === "drop").map((l) => l.id));
}

// ── Probe 8: intent parsing — malformed shapes flow through unvalidated
console.log("── probe 8: unvalidated intent shapes ──");
{
  const parsed = parseIntentsFromText('Answer here.\n```intents\n{"op": "files.expand", "target": 123, "from": "x", "to": null}\n{"op": "goals.set"}\n```');
  console.log("parsed intents:", JSON.stringify(parsed.intents));
}

process.exit(0);
