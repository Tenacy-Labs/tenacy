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
import { evidenceValueFactor } from "./evidence.ts";
import { ZONE_ORDER } from "./types.ts";
import type { ParamSet } from "./params.ts";
import { capHorizons, effectiveHysteresis } from "./horizon.ts";
import { suffixMassAfter } from "./suffix.ts";
import { sharedBillSurcharge } from "./suffix.ts";
import { blockDigest } from "./cache-model.ts";
import { estTokens } from "./renderer.ts";

export interface Incumbent {
  /** Previous render's per-item state; empty map on first render. */
  rendered: Map<string, { position: number; zone: Zone; digest: string; representation: string; optionId: string }>;
  totalTokens: number;
  /** Block count of the previous render — suffix pricing needs it (0004 §5). */
  blockCount: number;
  /** ADR-0006 §5: EWMA of net durable standing-mass drift (tokens/turn).
   *  Maintained by the loop; absent → T* = ∞ → fixed-cap fallback. */
  standingMassDrift?: number | undefined;
  /** ADR-0006 §4 (phase 3): per-block token mass, 1-based position index.
   *  Absent → proportional-share fallback (bit-identical legacy behavior). */
  blockMass?: readonly number[] | undefined;
  /** ADR-0006 §4: write turn per block (1-based position) — TTL-expiry
   *  windows collapse suffix terms to zero (free restructures). */
  blockWriteTurns?: readonly number[] | undefined;
}

export interface SolverResult {
  placements: Placement[];
  itemLedgers: ItemLedger[];
  totalTokens: number;
  /** ADR-0006 §4: turn-level shared-bill credit (≤ 0) — the overcount when
   *  multiple restructures were each billed their full suffix. Journaled,
   *  not a selection input. */
  sharedBillCredit: number;
}

/** Positional rot weight — lost-in-the-middle shape (head/tail best). */
const ZONE_ROT_WEIGHT: Record<Zone, number> = {
  identity: 0.5, foundational: 0.8, stable: 1.0, evolving: 1.2, volatile: 0.7,
};

/** Utility-per-thousand-suffix-tokens scale for the hazard premium (so the
 *  premium lands in the same units as item value, ~O(1) at 1k suffix). */
const PremiumScale = 1000;

/** Kinds always held — the risk-free anchor (0002b §1). */
const ALWAYS_HELD = new Set(["identity", "goal"]);

/**
 * Future-utility stream (multi-period pass, 2026-08-22): the discounted
 * re-reference value of holding an object in state s over the next H turns.
 *   FV = Σ_{k=1..H} γ^k · (q(s)·μ0·α/(1+Δt+k) − ρ·tokens)
 * α from the item's own profile doubles as the recurrence shape: heavy-tail
 * kinds (small α — notice/error) have long re-reference streams; fast-decay
 * kinds (α≈1) have short ones. q(s) is the realization fraction per state.
 */
function futureValue(mu0: number, alpha: number, deltaT: number, tokens: number, q: number, ps: ParamSet, hValue: number = ps.fv.horizon): number {
  // Each future turn realizes the THEN-current value of the content in its
  // held state (q scales for lossiness/handle-ness), minus that turn's seat
  // rent. The k=0 seat is charged separately (the `seat` term) — never here.
  // ADR-0006 §5: the stream is capped at hValue = min(fv.horizon, T*) —
  // value cannot be collected past the window's expected turnover.
  let fv = 0;
  const H = Math.min(ps.fv.horizon, Math.max(1, Math.floor(hValue)));
  for (let k = 1; k <= H; k++) {
    fv += Math.pow(ps.fv.gamma, k) * (q * mu0 * Math.pow(1 + deltaT + k, -alpha) - ps.reservationPrice * tokens);
  }
  return fv;
}

export function solve(items: Map<string, ContextItem>, incumbent: Incumbent, ps: ParamSet, turn: number): SolverResult {
  const itemLedgers: ItemLedger[] = [];
  const chosen: { item: ContextItem; option: RenderOption; utility: number }[] = [];
  // Incumbent order (by position) — the prefix the provider already holds in KV.
  const incumbentOrder = Array.from(incumbent.rendered).sort((a, b) => a[1].position - b[1].position).map(([id]) => id);
  // ADR-0006 §5: T* turnover caps — computed once per solve.
  const caps = capHorizons(ps, ps.budgetLambda, incumbent.totalTokens, incumbent.standingMassDrift);

  // ── 1. Value forecasts and option selection per item ──────────────────────
  for (const item of items.values()) {
    const profile = ps.profiles[item.kind]!;
    const deltaT = Math.max(0, turn - item.lastTouchTurn);

    // v_i = μ₀·(1+Δt)^−α, with profile exemptions/floors/bumps (0002b §2, 0002f §3, 0004 §2)
    // valueMass (multi-period 2026-08-22): a merge group carries its members'
    // summed value with a FRESH clock — the transform re-presents aged
    // content, so the group decays from creation, not from the oldest member.
    const mass = item.valueMass !== undefined && item.valueMass > 0 ? item.valueMass : 1;
    let value = profile.decayExempt === true
      ? profile.mu0
      : profile.mu0 * Math.pow(1 + deltaT, -profile.alpha);
    if (item.valueMass !== undefined && item.valueMass > 0) {
      const groupDeltaT = Math.max(0, turn - item.createdTurn);
      value = item.valueMass * Math.pow(1 + groupDeltaT, -profile.alpha);
    }
    if (profile.floorTurns !== undefined && profile.floorValue !== undefined && deltaT <= profile.floorTurns) {
      value = Math.max(value, profile.floorValue);
    }
    if (item.valueBump !== undefined && turn <= item.valueBump.untilTurn) {
      value += item.valueBump.amount;
    }

    const hazard = item.hazardOverride ?? ps.hazardPriors[item.kind] ?? 0.05;
    const hazardBasis: "prior" | "observed" = item.hazardOverride !== undefined ? "observed" : "prior";

    // ADR-0006 §2.1: evidence-priced value. λᵢ posterior (shrinkage toward
    // the kind prior) rescales the value forecast; absent evidence → factor
    // exactly 1 — bit-identical behavior for evidence-less items.
    const evFactor = evidenceValueFactor(item, ps.hazardPriors[item.kind] ?? 0.05, turn);
    if (evFactor !== 1) value *= evFactor;
    const evBasis: "prior" | "observed" = item.refEvidence !== undefined ? "observed" : "prior";

    const prev = incumbent.rendered.get(item.id) ?? null;
    const options = item.options();
    if (options.length === 0) continue; // item presents no options this turn (e.g. purged lens)

    // Score every option (0002e §2: rejected options are logged data)
    // Multi-period benefit (2026-08-22): benefit is the discounted
    // re-reference STREAM FV, not the k=0 scalar — the solver now sees
    // transform amortization, handle optionality, and delayed re-reference
    // value. q(state) picks the realization fraction per option class.
    const scored = options.map((o) => {
      // Two-class recoverability (ADR-0006 §3): a MERGED/CONSOLIDATED render
      // whose bytes are recoverable (verbatim journal underneath) is NOT
      // priced lossy — its re-reference realizes full value via re-expansion.
      const recoverable = item.recoverability === "verbatim-preserving" || item.recoverability === "rereadable";
      const q = o.zeroValue === true
        ? ps.fv.qHandle
        : o.representation === "SUMMARY" || o.representation === "MERGED"
          ? (recoverable ? ps.fv.qRendered : ps.fv.qLossy)
          : ps.fv.qRendered;
      const fvDeltaT = item.valueMass !== undefined && item.valueMass > 0
        ? Math.max(0, turn - item.createdTurn) : deltaT;
      const fv = futureValue(mass * profile.mu0, profile.alpha, fvDeltaT, o.tokens, q, ps, caps.hValue);
      const cacheCost = transactionCost(item, o, prev === null ? undefined : prev, incumbent, ps, turn);
      // ADR-0006 §3 (fidelity half): the summary-confidence prior prices
      // information LOSS; a recoverable consolidation loses none — the
      // re-expansion writeback is priced where it occurs (transactionCost).
      const fidelity = fidelityPenalty(o, ps, item);
      const rotEstimate = ps.lambda * ps.rotCurve.sizeCoef * (incumbent.totalTokens + o.tokens) * 0.01;
      // Expected-invalidation risk premium (emergence pass 2026-08-22):
      // hazard is the per-turn change probability this item will rewrite.
      // Hosting it mid-render means each rewrite re-bills the suffix after
      // it — hazard × suffix tokens × spread is the honest expectation.
      const hz = o.zeroValue === true ? 0 : hazard;
      const suffixTokensH = Math.max(0, incumbent.totalTokens - (prev?.position ?? 0) * Math.max(1, incumbent.totalTokens / Math.max(1, incumbent.blockCount)));
      const hazardPremium = hz * (suffixTokensH / PremiumScale) * (ps.cache.pricePer1kUncached - ps.cache.pricePer1kCached);
      // No-content options (zeroValue) render nothing — their value is zero,
      // not the item's vᵢ: utility cannot flow from bytes not rendered.
      // Multi-period: utility = present value + future stream − costs.
      // optValue remains the k=0 scalar for ledger comparability; the FV
      // stream adds the over-horizon term. zeroValue renders nothing: no
      // present value; its future stream is handle optionality (qHandle).
      const optValue = o.zeroValue === true ? 0 : value;
      // Reservation price (emergence pass 2026-08-22): the shadow price of a
      // rendered byte in a bounded window. Without it utility >= 0 whenever
      // value > 0, so decayed items squat seats forever and evicted items
      // resurrect the very next turn (measured: relief in/out flapping,
      // turn-14/15 dropping and re-entering mid-zone). With rho, an item
      // must EARN its seat: v_i > rho * tokens + costs, else the window is
      // better spent on fresher content. This is the knapsack dual price.
      const seat = o.zeroValue === true ? 0 : ps.reservationPrice * o.tokens;
      const utility = optValue + fv - cacheCost - fidelity - rotEstimate - hazardPremium - seat;
      return { o, cacheCost, fidelity, rotEstimate, hazardPremium, seat, fv, utility, optValue };
    });
    scored.sort((a, b) => b.utility - a.utility || a.o.id.localeCompare(b.o.id));
    let best = scored[0]!;

    // Hysteresis: keep the incumbent option unless the challenger clears the margin (0002b §6)
    // ADR-0006 §2.4: the margin scales with posterior uncertainty — evidence
    // thickens, margin tightens; thin evidence holds the incumbent.
    const hystMargin = effectiveHysteresis(ps, item);
    let decision: ItemLedger["decision"] = "keep";
    let accepted = true;
    let margin = 0;
    if (prev !== null) {
      const incumbentOption = scored.find((s) => s.o.id === prev.optionId);
      if (incumbentOption !== undefined && incumbentOption !== best) {
        margin = best.utility - incumbentOption.utility - hystMargin;
        if (margin < 0) {
          // Challenger fails hysteresis: keep incumbent; log near-miss
          itemLedgers.push(ledgerFor(turn, item, profile, deltaT, hazard, evBasis, value, incumbentOption, "keep", true, -(hystMargin - (best.utility - incumbentOption.utility)), incumbentOption.o.id));
          chosen.push({ item, option: incumbentOption.o, utility: incumbentOption.utility });
          // rejected challenger is data
          itemLedgers.push(rejectedLedger(turn, item, best, incumbentOption.utility + hystMargin - best.utility));
          continue;
        }
        decision = "move";
      }
    } else {
      // New or re-entering item must clear the re-entry margin. EXCEPT a
      // tombstone/handle best (zeroValue): a ~10t handle that keeps the
      // item's re-expand path in the window is not representation churn —
      // hysteresis does not apply to it (emergence pass 2026-08-22: the
      // reservation price otherwise rejects oversized fresh lenses before
      // relief can tombstone them, dropping the handle entirely).
      margin = best.utility - ps.hysteresisMargin;
      if (margin < 0 && !ALWAYS_HELD.has(item.kind) && best.o.zeroValue !== true) {
        itemLedgers.push(rejectedLedger(turn, item, best, margin));
        continue;
      }
    }

    itemLedgers.push(ledgerFor(turn, item, profile, deltaT, hazard, evBasis, value, best, decision, accepted, margin, best.o.id));
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
    if (parentChoice === "purge" || parentChoice === undefined) {
      // group dropped/purged: members fall back to verbatim — content never
      // vanishes with the group's tombstone (multi-period pass 2026-08-22)
      if (c.option.id === "in-merge") {
        const verb = c.item.options().find((o) => o.id === "verbatim");
        if (verb !== undefined) {
          itemLedgers.push({
            turn, id: c.item.id,
            forecast: { mu0: ps.profiles[c.item.kind]?.mu0 ?? 1, alpha: ps.profiles[c.item.kind]?.alpha ?? 1, deltaT: turn - c.item.lastTouchTurn, hazard: ps.hazardPriors[c.item.kind] ?? 0.05, basis: "prior", expectedValue: 0 },
            utility: { benefit: 0, cacheCost: 0, rotShare: 0, total: 0 },
            decision: "move", accepted: true, marginVsHysteresis: 0, optionChosen: "verbatim",
            coupledReason: "group-purged-verbatim-fallback",
          });
          c.option = verb;
        }
      }
    }
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
  // Prefix discipline (Daniel, 2026-08-22): cache cost is sequence-dependent —
  // reordering two blocks re-prices every block after them. The layout must
  // preserve the incumbent order wherever it still applies; only genuinely
  // new items take density slots. Old rule (density-then-id) reordered the
  // evolving zone every turn as values decayed (turn-10 before turn-2), a
  // 100% cache miss the objective never saw.
  chosen.sort((a, b) => {
    const za = ZONE_ORDER.indexOf(zoneOfDyn(a, incumbent.rendered.get(a.item.id))), zb = ZONE_ORDER.indexOf(zoneOfDyn(b, incumbent.rendered.get(b.item.id)));
    if (za !== zb) return za - zb;
    // within-zone: incumbent items keep their relative order (stable, prefix-
    // preserving); new items append after them, density-ranked among themselves.
    const pa = incumbentOrder.indexOf(a.item.id);
    const pb = incumbentOrder.indexOf(b.item.id);
    if (pa >= 0 && pb >= 0) return pa - pb;
    if (pa >= 0 && pb < 0) return -1;   // incumbent stays before new arrivals
    if (pa < 0 && pb >= 0) return 1;
    const da = density(a), db = density(b);
    if (da !== db) return db - da;
    return a.item.id.localeCompare(b.item.id);
  });

  // ── 3. Budget: drop lowest-utility droppable items until within Λ ─────────
  // Emergence pass (2026-08-22): the drop CHOICE must price prefix damage.
  // Old rule (pure density) always cut the oldest turns — which sit at the
  // FRONT of the evolving zone — destroying cache for every block after
  // them each relief turn (measured: prefix 1,663t → 435t alternate turns).
  // Dropping from the tail re-bills only the tail. The relief victim is
  // now the item minimizing value-per-(tokens + prefix damage): density
  // with the cache suffix it would strand priced in.
  let totalTokens = chosen.reduce((s, c) => s + c.option.tokens, 0);
  while (totalTokens > ps.budgetLambda) {
    const idx = worstDensityDroppable(chosen, incumbent, ps);
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
  // ADR-0006 §4 shared-bill accounting: the per-item suffix terms each
  // charged the full re-bill after their own position; the provider bills
  // ONE break (leftmost changed block). The overcount is credited back at
  // the turn level — journaled, not a selection input (ADR-0005 §4:
  // pricing modifies values, never structure).
  const restructures = [...chosen].filter((c) => {
    const prev = incumbent.rendered.get(c.item.id);
    return prev !== undefined && prev.digest !== blockDigest(c.option.text);
  }).map((c) => {
    const prev = incumbent.rendered.get(c.item.id)!;
    return { position: prev.position, mass: suffixMassAfter(incumbent, prev.position) };
  });
  const sharedBillCredit = sharedBillSurcharge(ps, restructures);
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
    const zone = zoneOfDyn(c, incumbent.rendered.get(c.item.id));
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

  return { placements, itemLedgers, totalTokens, sharedBillCredit };
}

function zoneOf(c: { item: ContextItem; option: RenderOption }): Zone {
  return c.option.zones[0] ?? "evolving";
}

/**
 * Cache-continuity zoning (Daniel, 2026-08-22): the declared zone is a claim;
 * the prefix decides. A block that rewrites this turn (digest differs from
 * incumbent, or fresh content) poisons every block after it — so a mutating
 * "stable" item is demoted to the volatile TAIL, where its churn re-bills
 * only the tail. Stable placement is earned by byte-identity (keep-branch);
 * a stable item that stabilizes promotes back with one suffix re-bill and
 * locks thereafter. Foundational/evolving/volatile declarations pass through.
 */
function zoneOfDyn(c: { item: ContextItem; option: RenderOption }, prev: { digest: string; zone: Zone } | undefined): Zone {
  const declared = c.option.zones[0] ?? "evolving";
  if (declared !== "stable") return declared;
  if (prev === undefined) return "volatile";                              // unproven: park at tail
  if (prev.digest === blockDigest(c.option.text)) return "stable";        // keep: earned
  return "volatile";                                                      // mutating: tail
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
 *
 * Emergence pass (2026-08-22): the density denominator now includes the
 * cache suffix the drop strands — evicting a front block re-bills every
 * byte after it, so the honest cost of a drop is tokens + stranded suffix.
 * Cache-continuity-aware relief drops from the TAIL emergently.
 */
function worstDensityDroppable(chosen: { item: ContextItem; option: RenderOption; utility: number }[], incumbent: Incumbent, ps: ParamSet): number {
  let worstIdx = -1, bestRelief = -Infinity;
  for (let i = 0; i < chosen.length; i++) {
    const c = chosen[i]!;
    if (ALWAYS_HELD.has(c.item.kind)) continue;
    // Cache damage of the drop: tokens after the item's incumbent position
    // re-bill at the spread. A front drop strands the whole render's cache;
    // a tail drop strands nothing. Priced in utility units.
    const pos = incumbent.rendered.get(c.item.id)?.position ?? 0;
    const blocksAfter = Math.max(0, incumbent.blockCount - pos);
    const strandTokens = incumbent.totalTokens * (blocksAfter / Math.max(1, incumbent.blockCount));
    const damageUtil = (strandTokens / PremiumScale) * (ps.cache.pricePer1kUncached - ps.cache.pricePer1kCached);
    // Relief score: window freed per unit of total loss (value + cache
    // damage). The argmax drops from the TAIL emergently — a front drop's
    // damage dwarfs the bytes it frees.
    const relief = c.option.tokens / Math.max(0.05, c.utility + damageUtil);
    if (relief > bestRelief) { bestRelief = relief; worstIdx = i; }
  }
  return worstIdx;
}

/** Transaction cost: additive append is cheap; a rewrite re-prices the suffix (0004 §5–6). */
interface PrevRender { position: number; zone: Zone; digest: string; representation: string; optionId: string }
function transactionCost(item: ContextItem, o: RenderOption, prev: PrevRender | undefined, incumbent: Incumbent, ps: ParamSet, turn?: number): number {
  const cache = ps.cache;
  if (prev !== undefined && prev.digest === blockDigest(o.text)) {
    // KEEP (Daniel, 2026-08-22): bytes identical to the incumbent render —
    // zero cache transaction. The prefix holds bit-for-bit; the provider
    // serves it from KV. Previously every unchanged item was billed as a
    // full rewrite, so the objective preferred churn over keep.
    return 0;
  }
  if (o.purelyAdditive) {
    // append at tail: pay the (cheap) cache-write price for the new bytes
    return (o.tokens / 1000) * cache.pricePer1kCached;
  }
  if (prev === undefined) {
    // fresh non-additive entry: its own uncached write
    return (o.tokens / 1000) * cache.pricePer1kUncached;
  }
  // rewrite in place: own tokens at full uncached price + the suffix after
  // the item's old block position re-billed at the spread. prev.position is
  // the 1-based block index in the incumbent render. ADR-0006 §4 (phase 3):
  // exact per-block mass replaces the proportional share; a suffix whose
  // blocks are already TTL-expired (cold) collapses to zero.
  const own = (o.tokens / 1000) * cache.pricePer1kUncached;
  const expired = incumbent.blockWriteTurns !== undefined
    && incumbent.blockWriteTurns.length > 0
    && turn !== undefined
    && incumbent.blockWriteTurns.slice(prev.position).every((wt) => wt !== undefined && turn - wt > cache.ttlTurns);
  if (expired) return own;   // free restructure: the suffix is already cold
  const tokensAfter = suffixMassAfter(incumbent, prev.position);
  const suffixCost = (tokensAfter / 1000) * (cache.pricePer1kUncached - cache.pricePer1kCached);
  return own + suffixCost;
}

/** A6: lossy representations carry a standing fidelity penalty until regret data relaxes it. */
function fidelityPenalty(o: RenderOption, ps: ParamSet, item?: ContextItem): number {
  if (o.representation === "SUMMARY" || o.representation === "MERGED") {
    const recoverable = item?.recoverability === "verbatim-preserving" || item?.recoverability === "rereadable";
    if (recoverable) return 0;
    return ps.summaryConfidencePrior * (1 + o.tokens / 2000);
  }
  return 0;
}

function ledgerFor(
  turn: number, item: ContextItem, profile: { mu0: number; alpha: number },
  deltaT: number, hazard: number, basis: "prior" | "observed", value: number,
  s: { o: RenderOption; cacheCost: number; fidelity: number; rotEstimate: number; utility: number; fv?: number },
  decision: ItemLedger["decision"], accepted: boolean, margin: number, optionId: string,
): ItemLedger {
  return {
    turn, id: item.id,
    forecast: { mu0: profile.mu0, alpha: profile.alpha, deltaT, hazard, basis, expectedValue: value, futureValue: s.fv ?? 0 },
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
