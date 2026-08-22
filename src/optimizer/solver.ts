/**
 * Solver — multi-horizon mean-variance placement with the option surface
 * (ADR-0002b §6 v1/v2 hybrid, ADR-0004 §5–6).
 *
 * Per item: value from the kind's profile (power-law decay, exemptions,
 * floors, bumps); per option: transaction cost (additive vs rewrite),
 * fidelity penalties for lossy representations, rot share. The option
 * space carries the policy; the solver carries the tradeoff. Zone
 * ordering with hysteresis margins — deterministic, bounded, journaled.
 */
import type { ContextItem, ItemLedger, Placement, RenderOption, Zone } from "./types.ts";
import { ZONE_ORDER } from "./types.ts";
import type { ParamSet } from "./params.ts";
import { blockDigest } from "./cache-model.ts";
import { estTokens } from "./renderer.ts";

export interface Incumbent {
  /** Previous render's per-item state; empty map on first render. */
  rendered: Map<string, { position: number; zone: Zone; digest: string; representation: string; optionId: string }>;
  totalTokens: number;
}

export interface SolverResult {
  placements: Placement[];
  itemLedgers: ItemLedger[];
  totalTokens: number;
}

/** Positional rot weight — lost-in-the-middle shape (head/tail best). */
const ZONE_ROT_WEIGHT: Record<Zone, number> = {
  identity: 0.5, foundational: 0.8, stable: 1.0, evolving: 1.2, volatile: 0.7,
};

/** Kinds always held — the risk-free anchor (0002b §1). */
const ALWAYS_HELD = new Set(["identity", "goal"]);

export function solve(items: Map<string, ContextItem>, incumbent: Incumbent, ps: ParamSet, turn: number): SolverResult {
  const itemLedgers: ItemLedger[] = [];
  const chosen: { item: ContextItem; option: RenderOption; utility: number }[] = [];

  // ── 1. Value forecasts and option selection per item ──────────────────────
  for (const item of items.values()) {
    const profile = ps.profiles[item.kind]!;
    const deltaT = Math.max(0, turn - item.lastTouchTurn);

    // v_i = μ₀·(1+Δt)^−α, with profile exemptions/floors/bumps (0002b §2, 0002f §3, 0004 §2)
    let value = profile.decayExempt === true
      ? profile.mu0
      : profile.mu0 * Math.pow(1 + deltaT, -profile.alpha);
    if (profile.floorTurns !== undefined && profile.floorValue !== undefined && deltaT <= profile.floorTurns) {
      value = Math.max(value, profile.floorValue);
    }
    if (item.valueBump !== undefined && turn <= item.valueBump.untilTurn) {
      value += item.valueBump.amount;
    }

    const hazard = item.hazardOverride ?? ps.hazardPriors[item.kind] ?? 0.05;
    const hazardBasis: "prior" | "observed" = item.hazardOverride !== undefined ? "observed" : "prior";

    const prev = incumbent.rendered.get(item.id) ?? null;
    const options = item.options();
    if (options.length === 0) continue; // item presents no options this turn (e.g. purged lens)

    // Score every option (0002e §2: rejected options are logged data)
    const scored = options.map((o) => {
      const cacheCost = transactionCost(item, o, prev === null ? undefined : prev, incumbent, ps);
      const fidelity = fidelityPenalty(o, ps);
      const rotEstimate = ps.lambda * ps.rotCurve.sizeCoef * (incumbent.totalTokens + o.tokens) * 0.01;
      // No-content options (zeroValue) render nothing — their value is zero,
      // not the item's vᵢ: utility cannot flow from bytes not rendered.
      const optValue = o.zeroValue === true ? 0 : value;
      const utility = optValue - cacheCost - fidelity - rotEstimate;
      return { o, cacheCost, fidelity, rotEstimate, utility, optValue };
    });
    scored.sort((a, b) => b.utility - a.utility || a.o.id.localeCompare(b.o.id));
    let best = scored[0]!;

    // Hysteresis: keep the incumbent option unless the challenger clears the margin (0002b §6)
    let decision: ItemLedger["decision"] = "keep";
    let accepted = true;
    let margin = 0;
    if (prev !== null) {
      const incumbentOption = scored.find((s) => s.o.id === prev.optionId);
      if (incumbentOption !== undefined && incumbentOption !== best) {
        margin = best.utility - incumbentOption.utility - ps.hysteresisMargin;
        if (margin < 0) {
          // Challenger fails hysteresis: keep incumbent; log near-miss
          itemLedgers.push(ledgerFor(turn, item, profile, deltaT, hazard, hazardBasis, value, incumbentOption, "keep", true, -(ps.hysteresisMargin - (best.utility - incumbentOption.utility)), incumbentOption.o.id));
          chosen.push({ item, option: incumbentOption.o, utility: incumbentOption.utility });
          // rejected challenger is data
          itemLedgers.push(rejectedLedger(turn, item, best, incumbentOption.utility + ps.hysteresisMargin - best.utility));
          continue;
        }
        decision = "move";
      }
    } else {
      // New or re-entering item must clear the re-entry margin
      margin = best.utility - ps.hysteresisMargin;
      if (margin < 0 && !ALWAYS_HELD.has(item.kind)) {
        itemLedgers.push(rejectedLedger(turn, item, best, margin));
        continue;
      }
    }

    itemLedgers.push(ledgerFor(turn, item, profile, deltaT, hazard, hazardBasis, value, best, decision, accepted, margin, best.o.id));
    chosen.push({ item, option: best.o, utility: best.utility });
  }

  // ── 1b. Coupling pass: split fragments <-> aggregated parent (0005 coupled costs)
  // If the parent chose an aggregated option (full/consolidated/base+delta),
  // its fragments are forced to range-drop (bytes live in the parent block;
  // never double-charged). If the parent chose split, its own bytes shrink
  // to the header only — fragments carry the content.
  const parentsChosen = new Map(chosen.map((c) => [c.item.id, c.option.id]));
  for (const c of [...chosen]) {
    const parent = (c.item as unknown as { upstreams?: readonly string[] }).upstreams?.[0];
    if (parent === undefined) continue;
    const parentChoice = parentsChosen.get(parent);
    if (parentChoice !== undefined && parentChoice !== "split" && parentChoice !== "compact" && parentChoice !== "purge") {
      // parent carries bytes: fragment renders empty (range-drop)
      if (c.option.id !== "range-drop") {
        const dropOpt = c.item.options().find((o) => o.id === "range-drop");
        if (dropOpt !== undefined) {
          itemLedgers.push({
            turn, id: c.item.id,
            forecast: { mu0: ps.profiles[c.item.kind]?.mu0 ?? 1, alpha: ps.profiles[c.item.kind]?.alpha ?? 1, deltaT: turn - c.item.lastTouchTurn, hazard: ps.hazardPriors[c.item.kind] ?? 0.05, basis: "prior", expectedValue: 0 },
            utility: { benefit: 0, cacheCost: 0, rotShare: 0, total: 0 },
            decision: "move", accepted: true, marginVsHysteresis:0, optionChosen: "range-drop",
            coupledReason: "parent-carries-bytes",
          });
          c.option = dropOpt;
        }
      }
    }
  }

  // ── 2. Zone layout: canonical order; within zone by value density then hazard ──
  chosen.sort((a, b) => {
    const za = ZONE_ORDER.indexOf(zoneOf(a)), zb = ZONE_ORDER.indexOf(zoneOf(b));
    if (za !== zb) return za - zb;
    const da = density(a), db = density(b);
    if (da !== db) return db - da;
    return a.item.id.localeCompare(b.item.id);
  });

  // ── 3. Budget: drop lowest-utility droppable items until within Λ ─────────
  let totalTokens = chosen.reduce((s, c) => s + c.option.tokens, 0);
  while (totalTokens > ps.budgetLambda) {
    const idx = worstDensityDroppable(chosen);
    if (idx < 0) break; // only always-held remain
    const c = chosen[idx]!;
    // Prefer downgrade-to-tombstone over eviction: a ~10t zeroValue option
    // keeps the item's handle in the window (re-expand path) instead of
    // vanishing entirely. Only evict when no tombstone remains.
    const tomb = c.option.zeroValue === true ? undefined : c.item.options().find((o) => o.zeroValue === true && o.tokens < c.option.tokens);
    if (tomb !== undefined) {
      totalTokens += tomb.tokens - c.option.tokens;
      itemLedgers.push({
        turn, id: c.item.id,
        forecast: { mu0: ps.profiles[c.item.kind]?.mu0 ?? 1, alpha: ps.profiles[c.item.kind]?.alpha ?? 1, deltaT: turn - c.item.lastTouchTurn, hazard: ps.hazardPriors[c.item.kind] ?? 0.05, basis: "prior", expectedValue: 0 },
        utility: { benefit: 0, cacheCost: 0, rotShare: 0, total: 0 },
        decision: "purge", accepted: true, marginVsHysteresis: ps.budgetLambda - totalTokens, optionChosen: tomb.id,
        coupledReason: "budget-tombstone",
      });
      c.option = tomb;
      continue;
    }
    const [cut] = chosen.splice(idx, 1);
    totalTokens -= cut!.option.tokens;
    itemLedgers.push({
      turn, id: cut!.item.id,
      forecast: { mu0: ps.profiles[cut!.item.kind]!.mu0, alpha: ps.profiles[cut!.item.kind]!.alpha, deltaT: turn - cut!.item.lastTouchTurn, hazard: ps.hazardPriors[cut!.item.kind] ?? 0.05, basis: "prior", expectedValue: cut!.utility },
      utility: { benefit: cut!.utility, cacheCost: 0, rotShare: 0, total: cut!.utility },
      decision: "drop", accepted: true, marginVsHysteresis: ps.budgetLambda - totalTokens,
    });
  }

  // ── 4. Positions, digests, rot shares from the final layout ────────────────
  const placements: Placement[] = [];
  let position = 0;
  const suffixTokens = totalTokens; // for rot share attribution
  for (const c of chosen) {
    position += 1;
    // Digest the bytes actually rendered — the chosen option's text — not
    // serialize(). Non-serialize options (purge/compact/summary) render
    // different bytes than the store serialization; digests must track
    // what hit the wire (second-pass review finding 1).
    const text = c.option.text;
    const digest = blockDigest(text);
    const zone = zoneOf(c);
    const rotShare = ps.lambda * (ps.rotCurve.sizeCoef * suffixTokens * 0.01
      + ps.rotCurve.midPenalty * ZONE_ROT_WEIGHT[zone] * c.option.tokens * 0.01);
    placements.push({
      id: c.item.id, zone, position, tokens: c.option.tokens,
      representation: c.option.representation, optionId: c.option.id, digest,
    });
    const led = itemLedgers.find((l) => l.id === c.item.id && l.decision !== "drop" && l.optionChosen === c.option.id);
    if (led) led.utility.rotShare = rotShare;
    c.item.lastRender = { position, digest };
  }

  return { placements, itemLedgers, totalTokens };
}

function zoneOf(c: { item: ContextItem; option: RenderOption }): Zone {
  return c.option.zones[0] ?? "evolving";
}
function density(c: { item: ContextItem; option: RenderOption }): number {
  const p = c.item;
  return p.tokens > 0 ? p.tokens / Math.max(1, c.option.tokens) : 1;
}

/**
 * Budget relief (ADR-0005 §7): drop the droppable item with the worst
 * utility-per-token (density), not the lowest absolute utility. Equal
 * utility, 5 vs 500 tokens: the 500-token item frees 100x the capacity
 * for the same utility loss. ALWAYS_HELD kinds are exempt.
 */
function worstDensityDroppable(chosen: { item: ContextItem; option: RenderOption; utility: number }[]): number {
  let worstIdx = -1, worstD = Infinity;
  for (let i = 0; i < chosen.length; i++) {
    const c = chosen[i]!;
    if (ALWAYS_HELD.has(c.item.kind)) continue;
    const density = c.utility / Math.max(1, c.option.tokens);
    if (density < worstD) { worstD = density; worstIdx = i; }
  }
  return worstIdx;
}

/** Transaction cost: additive append is cheap; a rewrite re-prices the suffix (0004 §5–6). */
interface PrevRender { position: number; zone: Zone; digest: string; representation: string; optionId: string }
function transactionCost(item: ContextItem, o: RenderOption, prev: PrevRender | undefined, incumbent: Incumbent, ps: ParamSet): number {
  const cache = ps.cache;
  if (o.purelyAdditive) {
    // append at tail: pay the (cheap) cache-write price for the new bytes
    return (o.tokens / 1000) * cache.pricePer1kCached;
  }
  if (prev === undefined) {
    // fresh non-additive entry: its own uncached write
    return (o.tokens / 1000) * cache.pricePer1kUncached;
  }
  // rewrite of a rendered item: own tokens + everything after its old position re-billed at the spread
  const suffix = Math.max(0, incumbent.totalTokens - prev.position * 0); // position in blocks; suffix approximated by total
  const own = (o.tokens / 1000) * (cache.pricePer1kUncached - cache.pricePer1kCached);
  const suffixCost = (suffix / 1000) * (cache.pricePer1kUncached - cache.pricePer1kCached) * 0.5; // conservative half — not all suffix re-bills when zones hold
  return own + suffixCost;
}

/** A6: lossy representations carry a standing fidelity penalty until regret data relaxes it. */
function fidelityPenalty(o: RenderOption, ps: ParamSet): number {
  if (o.representation === "SUMMARY" || o.representation === "MERGED") {
    return ps.summaryConfidencePrior * (1 + o.tokens / 2000);
  }
  return 0;
}

function ledgerFor(
  turn: number, item: ContextItem, profile: { mu0: number; alpha: number },
  deltaT: number, hazard: number, basis: "prior" | "observed", value: number,
  s: { o: RenderOption; cacheCost: number; fidelity: number; rotEstimate: number; utility: number },
  decision: ItemLedger["decision"], accepted: boolean, margin: number, optionId: string,
): ItemLedger {
  return {
    turn, id: item.id,
    forecast: { mu0: profile.mu0, alpha: profile.alpha, deltaT, hazard, basis, expectedValue: value },
    utility: { benefit: value, cacheCost: s.cacheCost, rotShare: s.rotEstimate, total: s.utility },
    decision, accepted, marginVsHysteresis: margin, optionChosen: optionId,
  };
}

function rejectedLedger(turn: number, item: ContextItem, s: { o: RenderOption; utility: number }, margin: number): ItemLedger {
  return {
    turn, id: item.id,
    forecast: { mu0: 0, alpha: 0, deltaT: 0, hazard: 0, basis: "prior", expectedValue: s.utility },
    utility: { benefit: s.utility, cacheCost: 0, rotShare: 0, total: s.utility },
    decision: "drop", accepted: false, marginVsHysteresis: margin, optionChosen: s.o.id,
  };
}
