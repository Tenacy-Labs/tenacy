/**
 * Split-lens fragment crash regression (fresh-context review 2026-08-22).
 *
 * Defect: materializeFragments() minted fresh LensFragmentItems each turn
 * but store.add() threw "duplicate item id" on the second call. The loop
 * must refresh fragments in place (upsert), not re-insert.
 */
import { describe, test } from "bun:test";
import { AgentLoop } from "../src/optimizer/loop.ts";
import { MockProvider } from "../src/optimizer/providers.ts";
import { paramSetV1 } from "../src/optimizer/params.ts";
import { StandingItem } from "../src/optimizer/items.ts";

describe("split-lens fragment upsert (review 2026-08-22)", () => {
  test("second materializeFragments() must not throw duplicate id", () => {
    const loop = new AgentLoop(new MockProvider(), paramSetV1("m"));
    loop.fileContent = () => Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    loop.store.add(new StandingItem("identity", "identity", "t").toContextItem());
    const lens = loop.fileLens("f.txt");
    lens.expand(1, 30);
    lens.baseBlockTurn = 1;
    lens.renderMode = "split";
    // First materialization inserts fragment items; second must refresh
    // them in place (upsert), not throw "duplicate item id".
    loop.materializeFragments();
    loop.materializeFragments();
    const fragIds = [...loop.store.snapshot().keys()].filter((id) => id.startsWith("lens:f.txt#"));
    if (fragIds.length !== 1) throw new Error(`expected exactly 1 fragment item, got ${fragIds.length}: ${fragIds.join(",")}`);
  });
});
