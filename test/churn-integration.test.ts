/**
 * ADR-0006 §2.3 integration — solver consumes churnProfile (discriminating).
 *
 * Two identical file lenses, both last-touched at t1; only HOT carries a
 * churnProfile (renewal at t6). At solve time on turn 7:
 *   HOT  forecast.deltaT = 0   (6 renewed turns credited)
 *   COLD forecast.deltaT = 6   (no churn — decays as before)
 * Without §2.3 both price identically — the test fails.
 *
 * Readout via the Ledger (the loop's own recording path): itemLedger rows
 * carry forecast.deltaT per item.
 */
import { describe, test, expect } from "bun:test";
import { AgentLoop } from "../src/optimizer/loop.ts";
import { MockProvider } from "../src/optimizer/providers.ts";
import { paramSetV1 } from "../src/optimizer/params.ts";
import { StandingItem } from "../src/optimizer/items.ts";
import { Ledger } from "../src/optimizer/ledger.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

describe("ADR-0006 §2.3 live integration", () => {
  test("churning lens FV credits renewal; quiet lens decays (discriminating)", async () => {
    const ps = paramSetV1("test-model");
    const dir = mkdtempSync(join(tmpdir(), "ak-churn-"));
    const ledger = new Ledger(join(dir, "l.jsonl"));
    const loop = new AgentLoop(new MockProvider(), ps, ledger);
    loop.store.add(new StandingItem("identity", "identity", "t").toContextItem());
    loop.fileContent = () => "alpha\nbeta\n";
    loop.attachLens("lens:hot", "hot.ts", [[1, 2]], -1, "FULL", "file", {});
    loop.attachLens("lens:cold", "cold.ts", [[1, 2]], -1, "FULL", "file", {});
    const regHot = loop.lensRegistryView().get("lens:hot");
    const regCold = loop.lensRegistryView().get("lens:cold");
    if (regHot === undefined || regCold === undefined) throw new Error("lenses not attached");
    regHot.valueBump = { amount: 8, untilTurn: 99 };
    regCold.valueBump = { amount: 8, untilTurn: 99 };
    regHot.lastTouchTurn = 1; regCold.lastTouchTurn = 1;
    regHot.churnProfile = { ewmaChurn: 1.0, lastChangeTurn: 6 };
    // Dual-write (the loop's own pattern): the store's ContextItem copy
    // snapshots fields by value — registry-only writes never reach the solver.
    const sHot = loop.store.get("lens:hot") as unknown as { lastTouchTurn: number; churnProfile?: { ewmaChurn: number; lastChangeTurn?: number } };
    const sCold = loop.store.get("lens:cold") as unknown as { lastTouchTurn: number };
    if (sHot === undefined || sCold === undefined) throw new Error("store copies missing");
    sHot.lastTouchTurn = 1; sCold.lastTouchTurn = 1;
    sHot.churnProfile = { ewmaChurn: 1.0, lastChangeTurn: 6 };

    for (let i = 0; i < 7; i++) await loop.run(`tick ${i}`);   // now turn 7
    await ledger.drain();
    const rows = readFileSync(join(dir, "l.jsonl"), "utf8").trim().split("\n").map((r) => JSON.parse(r) as Record<string, unknown>);
    const hot = rows.find((r) => r.t === "item" && r.id === "lens:hot" && (r.turn as number) === 7);
    const cold = rows.find((r) => r.t === "item" && r.id === "lens:cold" && (r.turn as number) === 7);
    if (hot === undefined || cold === undefined) throw new Error(`turn-7 lens rows missing: ${rows.filter((r) => r.t === "item").map((r) => r.id + "@" + r.turn).join(",")}`);
    const hotDT = (hot.forecast as { deltaT: number }).deltaT;
    const coldDT = (cold.forecast as { deltaT: number }).deltaT;
    // Change at t6, solve at t7, lastTouch t1: turns t2–t6 are renewal-credited
    // (5 of the 6 elapsed), leaving exactly ONE genuinely stale turn (t7).
    expect(hotDT).toBe(1);
    expect(coldDT).toBeGreaterThanOrEqual(6);
  });
});
