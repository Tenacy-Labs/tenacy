/**
 * Renderer v1 — pure, deterministic, golden-testable (ADR-0002 §2).
 *
 * Zone layout: identity → foundational → stable → evolving → volatile.
 * The solver decides placement; the renderer only serializes: given
 * placements, produce blocks. Given the option surface, the solver
 * chooses per item; here we serialize deterministically with marked
 * deltas and change-notices per the sequence-legibility contract
 * (ADR-0002d §6).
 */
import type { Block, ContextItem, Placement, RenderResult } from "./types.ts";
import type { ParamSet } from "./params.ts";
import { blockDigest } from "./cache-model.ts";
import type { Zone } from "./types.ts";
import { ZONE_ORDER } from "./types.ts";

export const ZONE_LABEL: Record<Zone, string> = {
  identity: "## IDENTITY (cache-pinned)",
  foundational: "## FOUNDATIONAL",
  stable: "## STABLE CONTEXT",
  evolving: "## WORKING",
  volatile: "## TRANSIENT",
};

/** Token accounting: chars/4 approximation, consistent everywhere. */
export function estTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Render placements → blocks → text. Deterministic: same placements, same bytes.
 * Zones appear in canonical order; items within a zone keep solver order.
 */
export function render(placements: Placement[], items: Map<string, ContextItem>, ps: ParamSet): RenderResult {
  const zoneHistograms = emptyHistograms();
  const parts: string[] = [];
  const blocks: Block[] = [];
  let position = 0;

  for (const zone of ZONE_ORDER) {
    const zonePlacements = placements.filter((p) => p.zone === zone);
    if (zonePlacements.length === 0) continue;
    parts.push(ZONE_LABEL[zone]);
    position += 1;
    for (const p of zonePlacements) {
      const it = items.get(p.id);
      if (!it) continue;
      // The chosen option IS the representation — render its bytes (0004 §5).
      const option = it.options().find((o) => o.id === p.optionId);
      const text = option !== undefined ? option.text : it.serialize();
      const tokens = estTokens(text);
      const digest = blockDigest(text);
      blocks.push({ digest, tokens, text, itemId: p.id, zone });
      parts.push(text);
      position += 1;
      const h = zoneHistograms[zone]!;
      h[it.kind] = (h[it.kind] ?? 0) + 1;
    }
  }

  return {
    text: parts.join("\n\n") + "\n",
    blocks,
    placements: placements.map((p) => ({ ...p })),
    zoneHistograms,
  };
}

function emptyHistograms(): Record<Zone, Record<string, number>> {
  const h = {} as Record<Zone, Record<string, number>>;
  for (const z of ZONE_ORDER) h[z] = {};
  return h;
}
