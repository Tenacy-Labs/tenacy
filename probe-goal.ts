
import { AgentLoop } from "./src/optimizer/loop.ts";
import { MockProvider } from "./src/optimizer/providers.ts";
import { paramSetV1 } from "./src/optimizer/params.ts";
const ps = paramSetV1("m"); ps.budgetLambda = 24000;
const rrs: any[] = [];
const agent = new AgentLoop(new MockProvider(), ps, null, { onRender: (rr: any) => { rrs.push(rr); }, onTurn: () => {} });
agent.steer({ op: "goals.set", id: "g1", text: "prove the loop" });
await agent.run("set a goal");
const r1 = rrs.at(-1)!;
const gp = r1.placements.find((p: any) => p.id === "g1");
console.log("goal placement:", gp ? `zone=${gp.zone} option=${gp.optionId} tokens=${gp.tokens}` : "NOT PLACED");
const gi = [...agent.store.snapshot().values()].find((i: any) => i.id === "g1");
for (const o of gi.options()) {
  console.log(`  option ${o.id}: tokens=${o.tokens} zones=${o.zones.join(",")}`);
}
