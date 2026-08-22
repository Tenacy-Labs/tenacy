/**
 * Critical-fix regression pins (fresh-context review 2026-08-22).
 *
 * C1: hits > observedTurns made evidenceVariance negative → NaN hysteresis.
 * C2: NaN hazardOverride passed the min/max clamp → NaN utilities →
 *     solve() threw via the knapsack validator.
 * C3: watcher fed lifetime event TOTAL as ewmaChurn (per-turn rate) →
 *     renewalCredit saturated → churned lenses priced fully fresh forever.
 */
import { describe, test } from "bun:test";
import { evidenceVariance } from "../src/optimizer/evidence.ts";
import { effectiveDeltaT } from "../src/optimizer/churn.ts";
import { TurnBoundaryWatcher } from "../src/optimizer/live-views.ts";
import { solve } from "../src/optimizer/solver.ts";
import { paramSetV1 } from "../src/optimizer/params.ts";
import { ContextStore } from "../src/optimizer/store.ts";
import { StandingItem } from "../src/optimizer/items.ts";

describe("review criticals 2026-08-22", () => {
  test("C1: hits > observedTurns never yields negative variance / NaN hysteresis", () => {
    // 25 access events on 15 observed turns — the search-heavy pattern.
    const hits = Array.from({ length: 25 }, (_, i) => (i % 15) + 1);
    const item = {
      refEvidence: { hits, accessClass: "searchHit" },
      createdTurn: 1,
      lastTouchTurn: 15,
    } as never;
    const v = evidenceVariance(item, 0.08, 20);
    if (v === null) throw new Error("expected variance, got null");
    if (!(v > 0)) throw new Error(`variance not positive: ${v}`);
    if (!Number.isFinite(Math.sqrt(v))) throw new Error("sqrt(variance) not finite");
  });

  test("C3: churnOf is a per-turn EWMA, not the lifetime total", () => {
    const w = new TurnBoundaryWatcher();
    // 41 turns of exactly 1 event/turn: EWMA → 1.0; lifetime total 41.
    for (let t = 1; t <= 41; t++) {
      w.push({ lensId: "lens:x", path: "x.ts", kind: "change" });
      w.drain(t);
    }
    const rate = w.churnOf("lens:x");
    if (rate > 1.5) throw new Error(`churnOf leaked the lifetime total: ${rate}`);
    if (w.shouldDemote("lens:x") !== true) throw new Error("lifetime demotion (41 events) should hold");
    // and the semantics fix: ewmaChurn=1 with deltaT=8 must NOT fully credit
    const eff = effectiveDeltaT({ lastTouchTurn: 10 } as never, 8, 12);
    if (eff < 7) throw new Error(`renewalCredit over-credited: effectiveDeltaT=${eff}`);
  });

  test("C2: NaN hazardOverride never reaches the knapsack validator", () => {
    const store = new ContextStore();
    const it = new StandingItem("identity", "identity", "t").toContextItem();
    it.hazardOverride = Number.NaN;
    store.add(it);
    const ps = { ...paramSetV1("m"), budgetLambda: 30 } as never;
    const res = solve(store.snapshot(), { rendered: new Map(), totalTokens: 0, blockCount: 0 }, ps, 5);
    if (res.placements.length === 0) throw new Error("no placements — solve silently dropped everything");
    for (const l of res.itemLedgers) {
      if (!Number.isFinite(l.utility.total)) throw new Error(`non-finite utility journaled: ${l.id}=${l.utility.total}`);
    }
  });
});
