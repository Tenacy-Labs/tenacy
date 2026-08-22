/**
 * Synthetic workload generator — ADR-0003 §5.
 *
 * Planted ground truth validates the estimators: sessions with known
 * re-reference distributions, hazards, and cache behavior. If refit
 * cannot recover known parameters, the pipeline is broken, not the world.
 * Synthetic sessions write ledgers marked provenance:"synthetic" — a
 * separate partition, never silently merged with real traffic (§7).
 */
import type { ItemLedger, TurnLedger, CacheLedger } from "./types.ts";
import type { Corpus } from "./corpus.ts";

/** Deterministic PRNG (mulberry32) — same seed, same session. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PlantedSpec {
  /** Sessions to generate. */
  sessions: number;
  /** Turns per session. */
  turns: number;
  /** Planted re-reference probability for episodic items per turn (value decay ground truth). */
  reReferenceRate: number;
  /** Planted invalidation hazard for lens items. */
  lensHazard: number;
  /** Planted cache hit share (0..1). */
  cacheHitShare: number;
  seed?: number;
}

export const DEFAULT_SPEC: PlantedSpec = {
  sessions: 3,
  turns: 10,
  reReferenceRate: 0.3,
  lensHazard: 0.15,
  cacheHitShare: 0.6,
  seed: 42,
};

/**
 * Generate a synthetic corpus with planted ground truth. Items are
 * journaled exactly like real ones (ItemLedger records); realized cache
 * hits are planted, not simulated — the estimators must recover the
 * planted parameters from the records alone.
 */
export function generateSynthetic(spec: PlantedSpec = DEFAULT_SPEC): { corpus: Corpus; truth: PlantedSpec } {
  const r = rng(spec.seed ?? 42);
  const turns: TurnLedger[] = [];
  const items: ItemLedger[] = [];
  const caches: CacheLedger[] = [];

  for (let s = 0; s < spec.sessions; s++) {
    for (let t = 1; t <= spec.turns; t++) {
      const turnNo = s * spec.turns + t;
      // episodic items: re-referenced per planted rate → forecast grounds truth
      const nEpi = 2;
      for (let k = 0; k < nEpi; k++) {
        const reRef = r() < spec.reReferenceRate;
        const deltaT = Math.max(1, Math.floor(r() * 5));
        const mu0 = 0.5 + r() * 0.5;
        const alpha = 0.5;
        items.push({
          turn: turnNo,
          id: `syn-${s}-turn-${turnNo}-epi${k}`,
          forecast: {
            mu0, alpha, deltaT,
            hazard: 0.05,
            basis: "prior",
            expectedValue: mu0 * Math.pow(1 + deltaT, -alpha),
          },
          utility: { benefit: mu0, cacheCost: 0.1, rotShare: 0.05, total: mu0 - 0.15 },
          decision: reRef ? "keep" : "drop",
          accepted: reRef,
          marginVsHysteresis: reRef ? 0.1 : -0.1,
        });
      }
      // lens items: planted hazard ground truth
      if (t % 3 === 1) {
        const invalidated = r() < spec.lensHazard;
        items.push({
          turn: turnNo,
          id: `syn-${s}-lens-${turnNo}`,
          forecast: { mu0: 0.8, alpha: 0.3, deltaT: t, hazard: spec.lensHazard, basis: "prior", expectedValue: 0.8 * Math.pow(1 + t, -0.3) },
          utility: { benefit: 0.8, cacheCost: 0.2, rotShare: 0.05, total: 0.55 },
          decision: invalidated ? "drop" : "keep",
          accepted: !invalidated,
          marginVsHysteresis: invalidated ? -0.05 : 0.2,
        });
      }
      // turn + cache records: planted hit share
      turns.push({
        turn: turnNo,
        layout: [],
        cacheBelief: { blockDigestChain: [], checkpoints: [], ttlTurns: 5, providerGranularity: 1024 },
        budgetLambda: 8000,
        parameterSetVersion: "v1-synthetic",
        modelId: "synthetic-model",
        zoneHistograms: { identity: {}, foundational: {}, stable: {}, evolving: {}, volatile: {} },
      });
      const expectedHit = 3000;
      const realizedHit = Math.round(expectedHit * (spec.cacheHitShare + (r() - 0.5) * 0.1));
      caches.push({
        turn: turnNo,
        expected: { hitTokens: expectedHit, price: 0.000003 },
        realized: { hitTokens: realizedHit, price: 0.000003 },
        divergence: "none",
        rawProviderReport: { planted: true },
      });
    }
  }
  return {
    corpus: {
      turns, items, caches,
      signals: [],
      provenance: "synthetic",
      // Record the seed actually used by rng() — the truncated value, so
      // the source line is reproducible for any seed input (finding 4).
      sources: [`synthetic:${(spec.seed ?? 42) >>> 0}`],
      parameterSetVersions: ["v1-synthetic"],
      modelIds: ["synthetic-model"],
    },
    // Detach: the caller must be able to mutate the returned truth without
    // poisoning DEFAULT_SPEC for every other importer (finding 3).
    truth: structuredClone(spec),
  };
}
