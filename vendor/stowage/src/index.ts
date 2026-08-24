/**
 * @connectotron/stowage — the context-layout solver.
 *
 * Barrel over the ported solver surface (ex-agent-kernel optimizer core).
 * Consumers import from the package root; module paths are internal.
 *
 * The kernel owns WHAT (option surface, items, ledger journaling); stowage
 * owns HOW (the solve: selection × placement × timing tradeoffs).
 */
export { solve, futureValue } from "./solver.ts";
export type { Incumbent, SolverResult } from "./solver.ts";
export { suffixMassAfter, sharedBillSurcharge } from "./suffix.ts";
export type { IncumbentMass } from "./suffix.ts";
export { capHorizons, effectiveHysteresis, turnoverStar } from "./horizon.ts";
export type { HorizonCaps } from "./horizon.ts";
export { renewalCredit, effectiveDeltaT } from "./churn.ts";
export {
  lambdaPosterior,
  evidenceValueFactor,
  evidenceVariance,
} from "./evidence.ts";
export type { AccessClass, RefEvidence } from "./evidence.ts";
export { blockDigest, CacheModel, DIVERGENCE_THRESHOLDS } from "./cache-model.ts";
export type { UsageReport } from "./cache-model.ts";
export { paramSetV1, PROFILES_V1, HAZARD_PRIORS_V1 } from "./params.ts";
export type { ParamSet, ValueProfile, CacheModelParams, Horizon } from "./params.ts";
export {
  ZONE_ORDER,
  type ItemKind,
  type Zone,
  type LensState,
  type ConvoRep,
  type RenderOption,
  type ContextItem,
  type Placement,
  type Block,
  type RenderResult,
  type ItemLedger,
  type TurnLedger,
  type CacheLedger,
  type DivergenceClass,
  type ItemSource,
} from "./types.ts";
