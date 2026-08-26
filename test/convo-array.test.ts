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

  test("chain round-trips save/restore with stable ids (review M1 fix)", async () => {
    const ps = paramSetV1("convo-array-test-save");
    ps.budgetLambda = 100_000;
    const agent = new AgentLoop(new MockProvider(), ps, null, {});
    await agent.run("Warm-up question.");                         // t1
    agent.steer({ op: "files.expand", target: "notes.txt", from: 1, to: 5 });
    agent.fileContent = () => "alpha\nbeta\ngamma\n";
    await agent.run("Check the notes.");                          // t2: steered, mints turn-2-tool-0

    const dir = mkdtempSync(join(import.meta.dir, "tmp-convo-"));
    const path = join(dir, "session.json");
    try {
      saveSession(agent, path, "mock");
      const agent2 = new AgentLoop(new MockProvider(), paramSetV1("convo-array-test-2"), null, {});
      restoreSession(agent2, path);
      const t2 = agent2.convo.find((t) => t.turn === 2);
      expect(t2?.prompt).toBe("Check the notes.");
      expect(t2?.chain.length).toBe(1);
      expect(t2?.chain[0]?.id).toBe("turn-2-tool-0");
      expect(t2?.chain[0]?.op).toBe("files.expand");
      expect(t2?.chain[0]?.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unparseable chain rows fail conservative, not silently-ok (review M2 fix)", async () => {
    const ps = paramSetV1("convo-array-test-raw");
    ps.budgetLambda = 100_000;
    const agent = new AgentLoop(new MockProvider(), ps, null, {});
    // Forge a tool-result turn row whose verbatim does NOT match the mint
    // format — simulates corruption or foreign session data.
    agent.addRestoredTurn("turn-1-tool-0", "tool-result", "something unparseable", undefined, "VERBATIM");
    const c = agent.convo[0]?.chain[0];
    expect(c?.ok).toBe(false);
    expect(c?.result).toContain("something unparseable");
  });
});
