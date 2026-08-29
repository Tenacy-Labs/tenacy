/** Re-export shim — surface owned by @tenacy-labs/stowage (git dep v0.1.0). ADR: stowage/docs/adr/0002. Upstream doctrine: consume the package-root barrel; module paths are internal. */
export {
  capHorizons,
  effectiveHysteresis,
  turnoverStar,
} from "@tenacy-labs/stowage";
export type { HorizonCaps } from "@tenacy-labs/stowage";
