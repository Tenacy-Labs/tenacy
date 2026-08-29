/** Re-export shim — surface owned by @tenacy-labs/stowage (git dep v0.1.0). ADR: stowage/docs/adr/0002. Upstream doctrine: consume the package-root barrel; module paths are internal. */
export { ZONE_ORDER } from "@tenacy-labs/stowage";
export type {
  ItemKind,
  Zone,
  LensState,
  ConvoRep,
  RenderOption,
  SequencePosition,
  ContextItem,
  Placement,
  Block,
  RenderResult,
  ItemLedger,
  TurnLedger,
  CacheLedger,
  DivergenceClass,
  ItemSource,
} from "@tenacy-labs/stowage";
