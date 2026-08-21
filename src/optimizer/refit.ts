/**
 * Refit pipeline skeleton — ADR-0003 §4.
 *
 * Offline batch over the corpus → candidate parameter sets, with fit
 * diagnostics (residuals, corpus size per cell) and the prior-divergence
 * guard: priors hold until the corpus disagrees with confidence —
 * candidate sets that diverge too far from priors are flagged, not
 * adopted. Adoption is review-gated (0002e §3); refit proposes.
 */
import type { Corpus } from "./corpus.ts";
import type { ParamSet } from "./params.ts";
import { paramSetV1 } from "./params.ts";
import { kindFromId } from "./reports.ts";

export interface FitDiagnostic {
  kind: string;
  n: number;
  fittedMu0: number;
  fittedAlpha: number;
  residualMean: number;
  residualStd: number;
  ciHalfWidth95: number;
}

export interface RefitResult {
  status: "proposal" | "held-back";
  reason?: string | undefined;
  diagnostics: FitDiagnostic[];
  divergenceFromPrior: Array<{ kind: string; mu0Delta: number; alphaDelta: number; overGuard: boolean }>;
  candidate: ParamSet | null;
}

/** v1 estimator: method-of-moments fit of μ₀ and α from journaled forecasts/accepts. */
export function refitMuAlpha(corpus: Corpus, guard = 0.5): RefitResult {
  const diagnostics: FitDiagnostic[] = [];
  const divergences: RefitResult["divergenceFromPrior"] = [];
  const byKind = new Map<string, Array<{ deltaT: number; observed01: number; expected: number; mu0: number; alpha: number }>>();

  for (const it of corpus.items) {
    const kind = kindFromId(it.id);
    const list = byKind.get(kind) ?? [];
    list.push({
      deltaT: it.forecast.deltaT,
      observed01: it.accepted ? 1 : 0,
      expected: it.forecast.expectedValue,
      mu0: it.forecast.mu0,
      alpha: it.forecast.alpha,
    });
    byKind.set(kind, list);
  }

  const prior = paramSetV1(corpus.modelIds[0] ?? "default");

  for (const [kind, list] of byKind) {
    if (list.length < 5) continue; // corpus-size floor per cell (0002b parameter sparsity)
    // moment fit: regress observed accept on power-law decay of Δt
    // log(v) = log(μ₀) − α·log(1+Δt)
    const pts = list.map((x) => ({ y: Math.log(Math.max(1e-6, x.observed01)), t: Math.log(1 + x.deltaT) }));
    const n = pts.length;
    const st = pts.reduce((s, p) => s + p.t, 0);
    const sy = pts.reduce((s, p) => s + p.y, 0);
    const stt = pts.reduce((s, p) => s + p.t * p.t, 0);
    const sty = pts.reduce((s, p) => s + p.t * p.y, 0);
    const denom = n * stt - st * st;
    if (Math.abs(denom) < 1e-9) continue;
    const slope = (n * sty - st * sy) / denom;
    const intercept = (sy - slope * st) / n;
    const fittedAlpha = Math.max(0.05, -slope);
    const fittedMu0 = Math.min(1, Math.max(0.05, Math.exp(intercept)));
    // residuals against the fit
    const residuals = list.map((x) => x.observed01 - fittedMu0 * Math.pow(1 + x.deltaT, -fittedAlpha));
    const rMean = residuals.reduce((s, x) => s + x, 0) / n;
    const rStd = Math.sqrt(residuals.reduce((s, x) => s + (x - rMean) ** 2, 0) / n);
    diagnostics.push({
      kind,
      n,
      fittedMu0,
      fittedAlpha,
      residualMean: rMean,
      residualStd: rStd,
      ciHalfWidth95: 1.96 * rStd / Math.sqrt(n),
    });
    const priMu0 = priorValue(prior, kind, "mu0");
    const priAlpha = priorValue(prior, kind, "alpha");
    divergences.push({
      kind,
      mu0Delta: fittedMu0 - priMu0,
      alphaDelta: fittedAlpha - priAlpha,
      overGuard: Math.abs(fittedAlpha - priAlpha) > guard || Math.abs(fittedMu0 - priMu0) > guard,
    });
  }

  const anyOver = divergences.some((d) => d.overGuard);
  return {
    status: anyOver ? "held-back" : "proposal",
    reason: anyOver ? "prior-divergence guard tripped — review before adoption (0002e §3)" : undefined,
    diagnostics: diagnostics,
    divergenceFromPrior: divergences,
    candidate: null,
  };
}

function priorValue(ps: ParamSet, kind: string, which: "mu0" | "alpha"): number {
  const entry = (ps.profiles as Record<string, { mu0: number; alpha: number } | undefined>)[kind];
  if (entry !== undefined) return which === "mu0" ? entry.mu0 : entry.alpha;
  return which === "mu0" ? 0.5 : 0.5;
}
