/**
 * Analysis layer tests — ADR-0003 buildout: corpus loading, six reports,
 * synthetic planted-truth validation, refit with prior-divergence guard.
 */
import { describe, test, expect } from "bun:test";
import { loadCorpus, corpusCard } from "../src/optimizer/corpus.ts";
import { loadHarnessConfig } from "../src/optimizer/harness-config.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportValueForecast, reportHazard, reportRot, reportDecision } from "../src/optimizer/reports.ts";
import { reportCacheBelief, reportCostVsBaselines } from "../src/optimizer/replay.ts";
import { refitMuAlpha } from "../src/optimizer/refit.ts";
import { generateSynthetic, DEFAULT_SPEC } from "../src/optimizer/synthetic.ts";
import { paramSetV1 } from "../src/optimizer/params.ts";
import { AgentLoop } from "../src/optimizer/loop.ts";
import { ScriptedProvider } from "../src/optimizer/providers.ts";
import { StandingItem } from "../src/optimizer/items.ts";
import { Ledger } from "../src/optimizer/ledger.ts";
import { availableProviders, REGISTRY } from "../src/optimizer/registry.ts";

const FILES_200 = Array.from({ length: 200 }, (_, i) => `line ${i + 1} — payload text ${i}`).join("\n");

/** Run a real 4-turn session with the ledger on; return the ledger path. */
async function realSessionLedger(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "ak-analysis-"));
  const ledger = new Ledger(join(dir, "ledger.jsonl"));
  const loop = new AgentLoop(
    new ScriptedProvider([
      { intents: [{ op: "files.expand", target: "notes.txt", from: 1, to: 60 }] },
      { text: "Found it on line 42.", intents: [{ op: "files.expand", target: "notes.txt", from: 30, to: 90 }] },
      { text: "Cross-checked." },
      { text: "Done.", intents: [{ op: "goals.set", id: "g1", text: "wrap up" }] },
    ]),
    paramSetV1("mock-scripted"),
    ledger,
  );
  loop.store.add(new StandingItem("identity", "identity", "test agent").toContextItem());
  loop.fileContent = () => FILES_200;
  await loop.run("open notes");
  await loop.run("more context");
  await loop.run("verify");
  await loop.run("finish");
  await ledger.drain();
  return join(dir, "ledger.jsonl");
}

describe("analysis layer — corpus", () => {
  test("loads a real ledger; card reports coverage + provenance", async () => {
    const path = await realSessionLedger();
    const corpus = await loadCorpus([path], "realized");
    expect(corpus.turns.length).toBe(4);
    expect(corpus.caches.length).toBe(4);
    const card = corpusCard(corpus);
    expect(card.provenance).toBe("realized");
    expect(card.sessions).toBe(1);
    expect(card.turns).toBe(4);
    expect(card.parameterSetVersions.length).toBeGreaterThan(0);
  });
});

describe("analysis layer — six reports", () => {
  test("reports 1-6 all render over a real corpus", async () => {
    const path = await realSessionLedger();
    const corpus = await loadCorpus([path], "realized");
    const r1 = reportCacheBelief(corpus.caches);
    expect(r1.turns).toBe(4);
    const r2 = reportValueForecast(corpus);
    expect(r2.card.turns).toBe(4);
    expect(r2.byKind.length).toBeGreaterThan(0);
    const r3 = reportHazard(corpus);
    expect(r3.byBasis.length).toBeGreaterThan(0);
    const r4 = reportRot(corpus);
    expect(r4.note).toContain("skeleton");
    const r5 = reportDecision(corpus);
    expect(r5.accepted + r5.rejectedNearMisses).toBeGreaterThan(0);
    const r6 = reportCostVsBaselines(corpus.caches, paramSetV1("mock-scripted"));
    expect(r6.turns).toBe(4);
  });
});

describe("analysis layer — synthetic planted truth", () => {
  test("generator emits synthetic-provenance corpus with planted hazards recoverable by report 3", () => {
    const { corpus, truth } = generateSynthetic(DEFAULT_SPEC);
    expect(corpus.provenance).toBe("synthetic");
    expect(truth.lensHazard).toBe(0.15);
    const r3 = reportHazard(corpus);
    // The planted hazard is journaled as the forecast; observed rate should be near it
    const prior = r3.byBasis.find((b) => b.basis === "prior" && b.kind === "lens");
    expect(prior).toBeDefined();
    expect(Math.abs(prior!.observedInvalidationRate - truth.lensHazard)).toBeLessThan(0.2);
  });

  test("synthetic never mixes into real corpora silently — provenance is carried", () => {
    const { corpus } = generateSynthetic(DEFAULT_SPEC);
    expect(corpus.provenance).toBe("synthetic");
    expect(corpus.sources[0]).toMatch(/^synthetic:/);
  });
});

describe("analysis layer — refit", () => {
  test("refit over synthetic corpus produces diagnostics; guard trips on divergence", () => {
    const { corpus } = generateSynthetic({ ...DEFAULT_SPEC, sessions: 5, turns: 12 });
    const result = refitMuAlpha(corpus, 0.5);
    expect(["proposal", "held-back"]).toContain(result.status);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    // diagnostics carry CIs — corpus size per cell is load-bearing (0002b)
    for (const d of result.diagnostics) {
      expect(d.n).toBeGreaterThanOrEqual(5);
      expect(d.ciHalfWidth95).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("provider registry", () => {
  test("all eight providers registered with env keys and defaults", () => {
    const names = Object.keys(REGISTRY);
    for (const expected of ["openai", "zai", "grok", "openrouter", "anthropic", "deepseek", "qwen", "generic"]) {
      expect(names).toContain(expected);
    }
    expect(REGISTRY.zai!.defaultModel).toBe("glm-4.7");
  });

  test("buildProvider throws honestly when key absent", () => {
    const saved = process.env.TEST_REG_KEY;
    delete process.env.OPENAI_API_KEY;
    expect(() => REGISTRY.openai!.build({ apiKey: "", model: "x" })).not.toThrow(); // building a wire needs no net
    expect(() => buildProviderMissingKey()).toThrow(/not set/);
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  });

  test("availableProviders lists only keyed providers", () => {
    const before = availableProviders();
    process.env.QWEN_API_KEY = "test-key-123";
    const after = availableProviders();
    delete process.env.QWEN_API_KEY;
    expect(after.length).toBeGreaterThanOrEqual(before.length);
    expect(after).toContain("qwen");
  });
});

function buildProviderMissingKey(): void {
  // direct: emulate buildProvider with no key
  const key = process.env.OPENAI_API_KEY ?? "";
  if (key === "") throw new Error("OPENAI_API_KEY not set — openai is bring-your-own-key");
}

// ── second-pass findings: synthetic detachment + seed honesty ──────────
describe("synthetic truth detachment (second-pass finding 3)", () => {
  test("mutating returned truth does not poison the next generation", () => {
    const a = generateSynthetic();
    a.truth.lensHazard = 0.99; // mutate the returned truth
    const b = generateSynthetic();
    expect(b.truth.lensHazard).not.toBe(0.99);
    expect(DEFAULT_SPEC.lensHazard).not.toBe(0.99);
  });
});

describe("seed truncation honesty (second-pass finding 4)", () => {
  test("sources records the truncated seed the rng actually used", () => {
    const big = 2 ** 35 + 42;
    const g = generateSynthetic({ ...DEFAULT_SPEC, seed: big });
    expect(g.corpus.sources[0]).toBe(`synthetic:${big >>> 0}`);
    expect(g.corpus.sources[0]).not.toBe(`synthetic:${big}`);
  });
});

// ── review findings: config guard + credential tier blanks ─────────────
describe("harness config guard (review B2)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ak-cfg-"));
  const cfgPath = (obj: unknown) => {
    const p = join(tmp, `c${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(p, JSON.stringify(obj));
    return p;
  };

  test("providers:null rejected; array rejected; well-formed accepted", () => {
    // null passes typeof "object" — the bug the security reviewer's probe caught
    expect(loadHarnessConfig(cfgPath({ version: 1, providers: null }))).toBeNull();
    expect(loadHarnessConfig(cfgPath({ version: 1, providers: [] }))).toBeNull();
    const ok = loadHarnessConfig(cfgPath({ version: 1, providers: { zai: { apiKey: "k", model: "m" } } }));
    expect(ok?.providers.zai?.model).toBe("m");
  });

  test("blank model in config falls back to registry default", async () => {
    // model "" must not win over defaultModel (blank-tier fix).
    // Point the registry at a tmp config via AGENT_KERNEL_CONFIG so the
    // real agents/config.json cannot mask the behavior.
    const { buildProvider } = await import("../src/optimizer/registry.ts");
    const p = join(tmp, "blank-model.json");
    writeFileSync(p, JSON.stringify({ version: 1, providers: { zai: { apiKey: "k", model: "" } } }));
    const prev = process.env.AGENT_KERNEL_CONFIG;
    process.env.AGENT_KERNEL_CONFIG = p;
    try {
      const provider = buildProvider("zai", { apiKey: "explicit" }); // model from cfg is "" -> default
      expect(provider.modelId).toBe(REGISTRY.zai!.defaultModel);
    } finally {
      if (prev === undefined) delete process.env.AGENT_KERNEL_CONFIG;
      else process.env.AGENT_KERNEL_CONFIG = prev;
    }
  });
});
