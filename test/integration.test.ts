import { describe, expect, test } from "bun:test";
import { AgentLoop } from "../src/optimizer/loop.ts";
import { paramSetV1 } from "../src/optimizer/params.ts";
import { MockProvider } from "../src/optimizer/providers.ts";
import type { RenderResult } from "../src/optimizer/types.ts";

/**
 * Integration coverage for the context optimizer's public execution path:
 * host steering -> item option surface -> multi-turn solver -> renderer ->
 * incumbent/cache model. The lower-level suites exercise each unit separately;
 * this file proves their cross-turn wiring as one system.
 */
describe("context optimizer multi-turn pipeline", () => {
  test("budget tombstone remains recoverable, promoted content re-enters, and stable bytes hit cache", async () => {
    const ps = paramSetV1("integration-model");
    ps.budgetLambda = 300;
    ps.reservationPrice = 0; // isolate hard-budget behavior from seat pricing

    const renders: RenderResult[] = [];
    const agent = new AgentLoop(new MockProvider(), ps, null, {
      onRender: (render) => renders.push(render),
    });
    const planted = "PLANTED-CONTEXT-FACT-7319";
    agent.fileContent = () => [
      `line 1: ${planted}`,
      ...Array.from({ length: 799 }, (_, i) => `line ${i + 2}: payload ${"x".repeat(24)}`),
    ].join("\n");

    agent.steer({ op: "files.expand", target: "large.log", from: 1, to: 800 });
    const constrained = await agent.run("Inspect the large log.");
    const lensId = "lens:large.log";

    expect(constrained.toolResults[0]).toMatchObject({ op: "files.expand", ok: true });
    expect(constrained.placements.find((p) => p.id === lensId)?.optionId).toBe("purge");
    expect(renders.at(-1)?.text).not.toContain(planted);
    expect(renders.at(-1)?.text).toContain("purged; re-expand on demand");

    ps.budgetLambda = 10_000;
    agent.steer({ op: "ctx.promote", id: lensId });
    const recovered = await agent.run("Recover the promoted source context.");

    expect(recovered.toolResults[0]).toMatchObject({ op: "ctx.promote", ok: true });
    expect(recovered.placements.find((p) => p.id === lensId)?.optionId).toBe("full");
    expect(renders.at(-1)?.text).toContain(planted);

    const promotedToStable = await agent.run("Use the same source again.");
    expect(promotedToStable.placements.find((p) => p.id === lensId)?.zone).toBe("stable");
    // Promotion moves the block from volatile tail to stable, intentionally
    // paying one suffix re-bill. The following identical layout is the hit.
    expect(promotedToStable.cacheExpectedHit).toBe(0);

    const stable = await agent.run("Continue with the unchanged source.");
    expect(stable.placements.find((p) => p.id === lensId)?.zone).toBe("stable");
    expect(stable.cacheExpectedHit).toBeGreaterThan(0);
  });
});
