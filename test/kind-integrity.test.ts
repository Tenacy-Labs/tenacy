/**
 * Kind regression pins (fresh-context review 2026-08-22, B-1).
 *
 * Defect: StandingItem.toContextItem() hardcoded kind:"episodic" after the
 * PR #14 velocity removal — identity/directive items became evictable α=1
 * episodic content, corrupted session rowType, and flipped solver priors.
 * These tests pin every item family's ContextItem.kind.
 */
import { describe, test } from "bun:test";
import { StandingItem, GoalItem, NoticeItem, TurnItem } from "../src/optimizer/items.ts";
import { makeTurnItem } from "../src/optimizer/loop.ts";

describe("item kind integrity (review B-1)", () => {
  test("StandingItem snapshots carry their true kind", () => {
    const idn = new StandingItem("identity", "identity", "You are the agent.").toContextItem();
    if (idn.kind !== "identity") throw new Error(`identity kind: ${idn.kind}`);
    const dir = new StandingItem("guardrails", "directive", "Be brief.").toContextItem();
    if (dir.kind !== "directive") throw new Error(`directive kind: ${dir.kind}`);
    // full surface: no dropped fields (the repair ate lines once)
    if (typeof idn.serialize !== "function" || idn.tokens <= 0) throw new Error("surface fields missing");
    if (idn.options().length === 0) throw new Error("options missing");
  });

  test("TurnItem, GoalItem, NoticeItem, Lens kinds are exact", () => {
    const t = makeTurnItem("turn-1-user", "user", "hi", 1);
    if (t.kind !== "episodic") throw new Error(`turn kind: ${t.kind}`);
    const g = new GoalItem("g1", "finish review").toContextItem();
    if (g.kind !== "goal") throw new Error(`goal kind: ${g.kind}`);
    const n = new NoticeItem("n:1", "notice", "body", false, [], 0.9).toContextItem();
    if (n.kind !== "notice") throw new Error(`notice kind: ${n.kind}`);
    const e = new NoticeItem("n:2", "error", "boom", false, [], 0.9).toContextItem();
    if (e.kind !== "error") throw new Error(`error kind: ${e.kind}`);
  });
});
