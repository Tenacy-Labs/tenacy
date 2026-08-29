/** Re-export shim — surface owned by @tenacy-labs/stowage (git dep v0.1.0). ADR: stowage/docs/adr/0002. Upstream doctrine: consume the package-root barrel; module paths are internal. */
export {
  paramSetV1,
  PROFILES_V1,
  HAZARD_PRIORS_V1,
} from "@tenacy-labs/stowage";
export type {
  ParamSet,
  ValueProfile,
  CacheModelParams,
  Horizon,
} from "@tenacy-labs/stowage";
