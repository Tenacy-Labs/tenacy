/** Re-export shim — surface owned by @tenacy-labs/stowage (git dep v0.1.0). ADR: stowage/docs/adr/0002. Upstream doctrine: consume the package-root barrel; module paths are internal. */
export {
  blockDigest,
  CacheModel,
  DIVERGENCE_THRESHOLDS,
  billingQuanta,
  breakpointPrice,
} from "@tenacy-labs/stowage";
export type { UsageReport } from "@tenacy-labs/stowage";
