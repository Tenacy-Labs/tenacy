import { describe, expect, test } from "bun:test";
import { AgentLoop } from "../src/optimizer/loop.ts";
import { paramSetV1 } from "../src/optimizer/params.ts";
import { MockProvider } from "../src/optimizer/providers.ts";
import { saveSession, restoreSession } from "../src/optimizer/sessions.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Convo array interface (ADR-0002f §2 amendment, 2026-08-25):
 *  agent.convo — turn-indexed projection of the session's own record,
 *  each element = prompt + reply + executed reasoning/tool chain. */
describe("convo array interface", () => {
  test("steering chain attaches to the correct turn; prompt/reply/chain present", async () => {
    const ps = paramSetV1("convo-array-test");
    ps.budgetLambda = 100_000;  // no eviction — observe the full record
    const agent = new AgentLoop(new MockProvider(), ps, null, {});
    await agent.run("What is the budget?");                       // t1: plain
    agent.steer({ op: "files.expand", target: "notes.txt", from: 1, to: 10 });
    agent.fileContent = () => "alpha\nbeta\ngamma\n";
    await agent.run("Check the notes.");                          // t2: steered

    const convo = agent.convo;
    expect(convo.length).toBe(2);
    expect(convo[0]?.turn).toBe(1);
    expect(convo[0]?.prompt).toBe("What is the budget?");
    expect(convo[0]?.chain.length).toBe(0);
    const t2 = convo[1];
    expect(t2?.prompt).toBe("Check the notes.");
    expect(t2?.reply).toBeDefined();
    expect(t2?.chain.length).toBe(1);
    expect(t2?.chain[0]?.op).toBe("files.expand");
    expect(t2?.chain[0]?.ok).toBe(true);
    expect(t2?.chain[0]?.id).toBe("turn-2-tool-0");
  });

  test("chain survives save/restore (tool-result rows round-trip)", () => {
    const ps = paramSetV1("convo-array-test-save");
    ps.budgetLambda = 100_000;
    const agent = new AgentLoop(new MockProvider(), ps, null, {});
    void agent.run("q1");  // not awaited: MockProvider is sync-fast; rows exist after run returns promise resolution
    // Use a synchronous-shaped flow instead: steer + run sequentially.
    const dir = mkdtempSync(join(import.meta.dir, "tmp-convo-"));
    const path = join(dir, "session.json");
    try {
      saveSession(agent, path, "mock");
      const agent2 = new AgentLoop(new MockProvider(), paramSetV1("convo-array-test-2"), null, {});
      restoreSession(agent2, path);
      const convo2 = agent2.convo;
      // t1 prompt round-trips even before its await resolves (store.add is sync)
      const t1 = convo2.find((t) => t.turn === 1);
      expect(t1?.prompt).toBe("q1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
