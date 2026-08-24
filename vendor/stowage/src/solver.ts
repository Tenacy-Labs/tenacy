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
import { effectiveDeltaT } from "./churn.ts";
import { suffixMassAfter } from "./suffix.ts";
import { sharedBillSurcharge } from "./suffix.ts";
import { blockDigest } from "./cache-model.ts";
import { solve as solveMckp } from "@connectotron/knapsack";
import { normalizeSequenceOrder, planSequenceMoves } from "./sequence-position.ts";

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
  /** Optional per-block wall-clock write stamps (milliseconds). Stamps may
   *  be individually absent — partial wall evidence (review MAJOR-4): a
   *  missing stamp must fall back to turn TTL for that block, never
   *  globally suppress the turn axis. */
  blockWriteWallTimeMs?: readonly (number | undefined)[] | undefined;
  /** Wall time of the cache snapshot when per-block stamps are unavailable. */
  cacheSnapshotWallTimeMs?: number | undefined;
  /** Prior accepted move by item, used for reversal/thrash diagnostics. */
  previousMoves?: ReadonlyMap<string, { fromPosition: number; toPosition: number }> | undefined;
}

export interface SolverResult {
  placements: Placement[];
  itemLedgers: ItemLedger[];
  totalTokens: number;
  /** ADR-0006 §4: turn-level shared-bill credit (≤ 0) — the overcount when
   *  multiple restructures were each billed their full suffix. Journaled,
   *  not a selection input. */
  sharedBillCredit: number;
  /** Selection executes once; exact MCKP is called at most once for exact over-budget relief. */
  selectionPasses: number;
  movePasses: number;
  capped: boolean;
  acceptedMoves: number;
  reversals: number;
  moveThrash: boolean;
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
export function futureValue(mu0: number, alpha: number, deltaT: number, tokens: number, q: number, ps: ParamSet, hValue: number = ps.fv.horizon): number {
  // Each future turn realizes the THEN-current value of the held content
  // minus that turn's seat rent. The k=0 seat is charged separately (the
  // `seat` term) — never here. ADR-0006 §5: the stream is capped at
  // hValue = min(fv.horizon, T*) — value cannot be collected past the
  // window's expected turnover.
  let fv = 0;
  // Review A-M2 fix (2026-08-22): a non-positive hValue (T*=0: the window
  // is already over budget) collects NO lookahead — the previous
  // Math.max(1, …) floor granted every item a full turn of FV exactly
  // when lookahead is definitionally worthless. Tests may pin H = 0.
  const H = Math.min(ps.fv.horizon, Math.max(0, Math.floor(hValue)));
  for (let k = 1; k <= H; k++) {
    fv += Math.pow(ps.fv.gamma, k) * (q * mu0 * Math.pow(1 + deltaT + k, -alpha) - ps.reservationPrice * tokens);
  }
  return fv;
}

export function solve(items: Map<string, ContextItem>, incumbent: Incumbent, ps: ParamSet, turn: number, wallTimeMs?: number): SolverResult {
  const itemLedgers: ItemLedger[] = [];
  const chosen: { item: ContextItem; option: RenderOption; utility: number }[] = [];
  // Incumbent order (by position) — the prefix the provider already holds in KV.
  const incumbentOrder = Array.from(incumbent.rendered).sort((a, b) => a[1].position - b[1].position).map(([id]) => id);
  // ADR-0006 §5: T* turnover caps — computed once per solve.
  const caps = capHorizons(ps, ps.budgetLambda, incumbent.totalTokens, incumbent.standingMassDrift);

  // ── 1. Value forecasts and option selection per item ──────────────────────
  for (const item of items.values()) {
    const profile = ps.profiles[item.kind]!;
    const rawDeltaT = Math.max(0, turn - item.lastTouchTurn);
    // ADR-0006 §2.3: content renewal refreshes the decay clock — a churning
    // item's bytes are fresh, so its FV must not decay as if stale. Credit
    // churn-renewed turns; hazardPremium keeps pricing change risk at k=0.
    const deltaT = effectiveDeltaT(item, rawDeltaT);

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
      // Review A-minor-7: valueMass items run a createdTurn-based value
      // clock — the floor must compare against the SAME clock, not the
      // lastTouch-based deltaT.
      const floorClockT = item.valueMass !== undefined && item.valueMass > 0
        ? Math.max(0, turn - item.createdTurn)
        : deltaT;
      if (floorClockT <= profile.floorTurns) value = Math.max(value, profile.floorValue);
    }
    // A-M5 owner ruling (2026-08-23): state-based error stickiness. An
    // UNRESOLVED error keeps its floor at ANY age — time was a proxy for
    // "dealt with"; the real variable is the lifecycle state. Resolution
    // (resolvedTurn set) lifts the floor; the item then glides out at
    // profile alpha (episodic-speed) so settled lessons fall off.
    if (profile.floorWhileUnresolved !== undefined && item.resolvedTurn === undefined) {
      value = Math.max(value, profile.floorWhileUnresolved);
    }
    if (item.valueBump !== undefined && turn <= item.valueBump.untilTurn) {
      value += item.valueBump.amount;
    }

    const rawHazard = item.hazardOverride ?? ps.hazardPriors[item.kind] ?? 0.05;
    const hazard = Number.isFinite(rawHazard)
      // Review A-minor-9 + C2 fix: clamp overrides to [0, 1] AND reject
      // non-finite values — Math.min/Math.max do not sanitize NaN, so a
      // fuzz-passed NaN previously flowed into hazardPremium → utility →
      // the knapsack validator, throwing out of solve(). Overrides are
      // producer hints, not trust boundaries.
      ? Math.min(1, Math.max(0, rawHazard))
      : ps.hazardPriors[item.kind] ?? 0.05;
    const hazardBasis: "prior" | "observed" = item.hazardOverride !== undefined && Number.isFinite(item.hazardOverride) ? "observed" : "prior";

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
      // Review A-M2: merge mass already includes each member's decayed μ₀
      // (intents.ts merge factory bakes 3.0·(1+age)⁻¹ per member into the
      // mass), so multiplying by profile.mu0 again double-counts it. The
      // valueMass stream is the mass alone.
      const fv = futureValue(item.valueMass !== undefined && item.valueMass > 0
        ? mass
        : mass * profile.mu0, profile.alpha, fvDeltaT, o.tokens, q, ps, caps.hValue);
      const cacheCost = transactionCost(item, o, prev === null ? undefined : prev, incumbent, ps, turn, wallTimeMs);
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
      // Review A-M4: a NEW item (prev === undefined) lands at its zone's
      // entry position — fresh volatile notices append at the tail and strand
      // ≈nothing — so the hazard premium must not charge the full incumbent
      // window. Charge the honest minimum: the item's own tokens.
      const suffixTokensH = prev == null
        ? o.tokens
        : incumbent.blockMass !== undefined && incumbent.blockMass.length > 0
          // Review A-minor-8: exact per-block mass when the incumbent carries
          // it (§4 objective) — the proportional share is only the fallback
          // for legacy incumbents without blockMass.
          ? suffixMassAfter(incumbent, prev.position)
          : Math.max(0, incumbent.totalTokens - prev.position * Math.max(1, incumbent.totalTokens / Math.max(1, incumbent.blockCount)));
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
    // Survey II.4 #4: code-unit comparison — localeCompare collation varies
    // by locale/ICU build; ADR-0003 treats re-solve instability as a signal,
    // and collation drift would masquerade as exactly that.
    scored.sort((a, b) => b.utility - a.utility || (a.o.id < b.o.id ? -1 : a.o.id > b.o.id ? 1 : 0));
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
          itemLedgers.push(ledgerFor(turn, item, profile, deltaT, hazard, evBasis, hazardBasis, value, incumbentOption, "keep", true, -(hystMargin - (best.utility - incumbentOption.utility)), incumbentOption.o.id));
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
      margin = best.utility - effectiveHysteresis(ps, item);
      if (margin < 0 && !ALWAYS_HELD.has(item.kind) && best.o.zeroValue !== true) {
        itemLedgers.push(rejectedLedger(turn, item, best, margin));
        continue;
      }
    }

    itemLedgers.push(ledgerFor(turn, item, profile, deltaT, hazard, evBasis, hazardBasis, value, best, decision, accepted, margin, best.o.id));
    chosen.push({ item, option: best.o, utility: best.utility });
  }

  // ── 1b. Coupling pass: split fragments <-> aggregated parent (0005 coupled costs)
  // If the parent chose an aggregated option (full/consolidated/base+delta),
  // its fragments are forced to range-drop (bytes live in the parent block;
  // never double-charged). If the parent chose split, its own bytes shrink
  // to the header only — fragments carry the content.
  const parentsChosen = new Map(chosen.map((c) => [c.item.id, c.option.id]));
  // Family rescue (2026-08-22, exposed by honest compact pricing): the
  // parent's SOLO argmax can pick a byte-carrying aggregated option while a
  // live fragment carries more family utility than the whole parent block —
  // and then budget relief evicts the parent, stranding high-value content
  // the argmax never compared (parent 443t evicted; bumped fragment 230t
  // sat range-dropped). The coupling pass owns the family arrangement: when
  // the parent carries bytes and its live fragments exist, rescore the
  // family as header+fragments-carry and flip when strictly better on
  // summed utility. Relief then trims the true worst per family.
  for (const parentEntry of [...chosen]) {
    const parentChoice = parentEntry.option.id;
    if (parentChoice === "split" || parentChoice === "compact" || parentChoice === "purge") continue;
    const parentId = parentEntry.item.id;
    const allOpts = parentEntry.item.options();
    const headerOpt = allOpts.find((o) => o.id === "split") ?? allOpts.find((o) => o.id === "compact");
    const carriedOpt = allOpts.find((o) => o.id === parentChoice);
    if (headerOpt === undefined || carriedOpt === undefined) continue;
    const frags = chosen.filter((e) => (e.item as unknown as { upstreams?: readonly string[] }).upstreams?.[0] === parentId && e.option.id === "range-full");
    if (frags.length === 0) continue;
    // Family utility as-is: parent carries bytes, fragments range-drop (the
    // state §1b will enforce below). Under the flip: parent renders the
    // zero-value header, fragments render their own bytes.
    const asIsScore = parentEntry.utility;                       // fragments contribute 0 (range-drop)
    const flipScore = frags.reduce((s, f) => s + f.utility, 0);  // header contributes ~0 (zeroValue)
    if (flipScore > asIsScore) {
      parentEntry.option = headerOpt;
      parentsChosen.set(parentId, headerOpt.id);
      // Review A-M8 fix (2026-08-22): the flip mutates the parent's render
      // from a byte-carrying option to the ~10t header WITHOUT journaling
      // — the ledger kept optionChosen "full" (300t, §1 utility) while the
      // placement was "split" (10t), and relief priced the parent at its
      // pre-flip utility. Journal the flip as a move row keyed to the
      // header option; the placement-stage write-back (A-M7) and any
      // downstream join on optionChosen now sees the true render.
      itemLedgers.push({
        turn, id: parentId,
        forecast: { mu0: ps.profiles[parentEntry.item.kind]?.mu0 ?? 1, alpha: ps.profiles[parentEntry.item.kind]?.alpha ?? 1, deltaT: turn - parentEntry.item.lastTouchTurn, hazard: ps.hazardPriors[parentEntry.item.kind] ?? 0.05, basis: "prior", hazardBasis: "prior", expectedValue: 0 },
        utility: { benefit: 0, cacheCost: 0, rotShare: 0, total: 0 },
        decision: "move", accepted: true, marginVsHysteresis: flipScore - asIsScore, optionChosen: headerOpt.id,
        coupledReason: "family-flip-header",
      });
      parentEntry.utility = 0; // header is zeroValue; relief must price the truth
    }
  }
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
  // within-zone: incumbent items keep their relative order (stable, prefix-
  // preserving); new items append after them, density-ranked among themselves.
  // Review A-minor-10 (amended after profiling): hoist the position Map ABOVE
  // the sort — constructing it inside the comparator allocated one Map per
  // comparison (59% of suite CPU in the 2026-08-22 profile, a regression the
  // original indexOf never had). Missing ids keep the −1 sentinel semantics.
  const incumbentPos = new Map(incumbentOrder.map((id, i) => [id, i] as const));
  chosen.sort((a, b) => {
    const za = ZONE_ORDER.indexOf(zoneOfDyn(a, incumbent.rendered.get(a.item.id))), zb = ZONE_ORDER.indexOf(zoneOfDyn(b, incumbent.rendered.get(b.item.id)));
    if (za !== zb) return za - zb;
    const pa = incumbentPos.get(a.item.id) ?? -1;
    const pb = incumbentPos.get(b.item.id) ?? -1;
    if (pa >= 0 && pb >= 0) return pa - pb;
    if (pa >= 0 && pb < 0) return -1;   // incumbent stays before new arrivals
    if (pa < 0 && pb >= 0) return 1;
    const da = density(a), db = density(b);
    if (da !== db) return db - da;
    // Survey II.4 #4: code-unit comparison — localeCompare varies by
    // locale/ICU build; a determinism hazard in a decision path.
    return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
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
  if (ps.reliefMode === "exact-mckp" && totalTokens > ps.budgetLambda) {
    exactMckpRelief(chosen, itemLedgers, incumbent, ps, turn, caps);
    totalTokens = chosen.reduce((s, c) => s + c.option.tokens, 0);
  }
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

  // ── 3b. Sequence-position normalization and priced moves ─────────────────
  // Metadata-free items retain the canonical legacy order. Sequence families
  // gain explicit precedence and zone-tail/radix branch points; requested
  // fuse moves spend accumulated migration credit against intervening mass.
  normalizeSequenceOrder(chosen, (entry) => zoneOfDyn(entry, incumbent.rendered.get(entry.item.id)));
  const moveDiagnostics = planSequenceMoves(chosen, itemLedgers, turn, incumbent.previousMoves);

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
    // Review A-M9 fix (2026-08-22): discount each restructure's suffix
    // mass by its TTL-expired tail. The per-item transactionCost already
    // collapses the suffix term when every block after the position is
    // TTL-expired (free restructure), but the credit was computed from
    // the UNDISCOUNTED suffix masses — fabricating a credit in cold
    // windows where nobody paid the suffix bill in the first place.
    let mass = suffixMassAfter(incumbent, prev.position);
    {
      // Review A-M9 fix (2026-08-22): discount each restructure's suffix
      // mass by its TTL-expired tail. The per-item transactionCost already
      // collapses the suffix term when every block after the position is
      // TTL-expired (free restructure), but the credit was computed from
      // the UNDISCOUNTED suffix masses — fabricating a credit in cold
      // windows where nobody paid the suffix bill in the first place.
      const bm = incumbent.blockMass;
      if (bm !== undefined) {
        const snapshotWallExpired = ps.cache.ttlMs !== undefined && wallTimeMs !== undefined
          && incumbent.cacheSnapshotWallTimeMs !== undefined
          && wallTimeMs - incumbent.cacheSnapshotWallTimeMs > ps.cache.ttlMs;
        if (snapshotWallExpired) {
          mass = 0;
        } else {
          for (let i = prev.position; i < bm.length; i++) {
            const wallWrite = incumbent.blockWriteWallTimeMs?.[i];
            const hasBlockWall = ps.cache.ttlMs !== undefined && wallTimeMs !== undefined && wallWrite !== undefined;
            const wallExpired = hasBlockWall && wallTimeMs - wallWrite > ps.cache.ttlMs!;
            const turnWrite = incumbent.blockWriteTurns?.[i];
            // Follow-up #4 (2026-08-24): per-block evidence, harmonized with
            // the MAJOR-4 transactionCost semantics. A fresh snapshot no
            // longer suppresses turn expiry for blocks without wall stamps —
            // a snapshot only acts when EXPIRED (whole-cache cold), same as
            // transactionCost. The old !hasSnapshotWall guard fabricated
            // shared-bill credit in cold windows.
            const turnExpired = !hasBlockWall && turnWrite !== undefined
              && turn - turnWrite > ps.cache.ttlTurns;
            if (wallExpired || turnExpired) mass -= bm[i]!;
          }
          mass = Math.max(0, mass);
        }
      }
    }
    return { position: prev.position, mass };
  });
  const sharedBillCredit = sharedBillSurcharge(ps, restructures);
  const placements: Placement[] = [];
  let position = 0;
  const suffixTokens = totalTokens; // for rot share attribution
  // Survey II.4 #1: Map keyed at push time — find() inside the placement
  // loop was O(n²) per solve (~10⁴ comparisons at 100 items).
  // Review A-M7 fix (2026-08-22): keep the Map but make it the FIRST row
  // per id — the solver pushes the accepted keep row before the rejected
  // challenger; last-row-wins handed the write-back the rejected row,
  // whose optionChosen never matched, so hysteresis-held items silently
  // kept the §1 size-only rot estimate (70× off the placement-stage
  // rotShare). First-accepted-row restores the pre-refactor semantics.
  const ledgerById = new Map<string, ItemLedger>();
  for (const l of itemLedgers) {
    if (l.decision === "drop") continue;
    if (!ledgerById.has(l.id)) ledgerById.set(l.id, l);
  }
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
    const led = ledgerById.get(c.item.id);
    if (led !== undefined && led.decision !== "drop" && led.optionChosen === c.option.id) led.utility.rotShare = rotShare;
    c.item.lastRender = { position, digest };
  }

  return {
    placements, itemLedgers, totalTokens, sharedBillCredit,
    selectionPasses: 1,
    ...moveDiagnostics,
  };
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

/**
 * Exact MCKP budget relief (knapsack-swap Stage 2, flag `reliefMode:
 * "exact-mckp"`). Formulates relief as a pure MCKP and solves it exactly
 * through @connectotron/knapsack:
 *
 *   groups   = droppable items (ALWAYS_HELD exempt)
 *   options  = keep (weight: current tokens, profit: utility)
 *              tombstone (weight: handle tokens, profit: 0) when a strictly
 *              smaller zeroValue option exists
 *              evict (weight 0, profit 0)
 *   capacity = Λ (budget); held-prefix items are constants — their tokens
 *              are subtracted from capacity, not modeled as groups.
 *
 * Integer discipline: the library requires non-negative integer
 * weights/profits. Utilities are floats in [0, ~50]; SCALE=1000 preserves
 * three decimals — ordering-stable for every observed utility magnitude.
 * Profits are floored at 0 (negative-utility items contribute nothing;
 * the keep-option dominates at identical weight).
 *
 * Cache-strand damage (the density path's prefix pricing) enters as a
 * profit adjustment on keep? NO — on the *evict/tombstone* options: an
 * item whose eviction re-bills the suffix loses its keep-profit only,
 * but the STRAND COST is charged to the relief alternatives, making the
 * solver see the true cost of freeing front bytes. Charged as
 * profit_keep = utility − strandCost? No — that would bias against
 * keeping low-damage items. The strand cost is a real cost of RELIEF,
 * so: profit_evict = −strandCost clamped to 0 for the integer domain
 * (the library rejects negatives). Clamp-to-0 keeps ordering faithful:
 * among eviction candidates the least-damaging still sorts first.
 */
function exactMckpRelief(
  chosen: { item: ContextItem; option: RenderOption; utility: number }[],
  itemLedgers: ItemLedger[],
  incumbent: Incumbent,
  ps: ParamSet,
  turn: number,
  caps: ReturnType<typeof capHorizons>,
): void {
  const SCALE = 1000;
  // Held prefix (ALWAYS_HELD): constant load, never a decision group.
  const heldTokens = chosen.reduce((s, c) => ALWAYS_HELD.has(c.item.kind) ? s + c.option.tokens : s, 0);
  const droppable = chosen.filter((c) => !ALWAYS_HELD.has(c.item.kind));
  if (droppable.length === 0) return;
  const capacity = Math.max(0, ps.budgetLambda - heldTokens);

  // Strand cost per item (utility units): same model as the density path.
  const strandCost = new Map<string, number>();
  for (const c of droppable) {
    const pos = incumbent.rendered.get(c.item.id)?.position ?? 0;
    const blocksAfter = Math.max(0, incumbent.blockCount - pos);
    const strandTokens = incumbent.totalTokens * (blocksAfter / Math.max(1, incumbent.blockCount));
    strandCost.set(c.item.id, (strandTokens / PremiumScale) * (ps.cache.pricePer1kUncached - ps.cache.pricePer1kCached));
  }

  const groups = droppable.map((c) => {
    // Review A-M1 fix (2026-08-22): the strand cost is the real cost of
    // RELIEF — evicting this item forces the suffix's re-bill. The old
    // code computed it and discarded it (`void strand`): exact-MCKP was
    // strand-blind and evicted the FRONT item whose eviction re-bills
    // 300t of prefix while the density path correctly protected it.
    // Domain-honest charge: keep-profit = utility + strandCost. The
    // strand is what the window LOSES if the item goes, so retention
    // value rises with it; the solver now prefers evicting the item
    // whose loss (utility + strand) is smallest — the honest victim,
    // matching the density path's prefix pricing.
    const strand = strandCost.get(c.item.id) ?? 0;
    const keepW = c.option.tokens;
    const keepP = Math.max(0, Math.round((c.utility + strand) * SCALE));
    // Tombstone profit is NOT zero: the handle carries the item's future
    // re-reference stream at qHandle (the same economics phase-1 gives
    // zeroValue options — see solver §1 "its future stream is handle
    // optionality (qHandle)"). Priced at 0 the solver correctly prefers
    // FREE evict (0 tokens, 0 profit) over a 10-token tombstone — killing
    // the recovery path the density loop preserved by construction.
    const profile = ps.profiles[c.item.kind];
    // Review A-m3 fix (2026-08-23): §1 prices value off the churn-credit
    // clock (effectiveDeltaT) — relief's tombFV used the raw wall clock.
    // A purged item is definitionally churn-renewed: its content is fresh,
    // so its handle's future re-reference stream must price off the same
    // effective age §1 used, or relief and §1 disagree on the same item in
    // the same turn.
    const deltaT = effectiveDeltaT(c.item, Math.max(0, turn - c.item.lastTouchTurn));
    // Review A-M10 fix (2026-08-22): price the tombstone's FV at THIS
    // solve's capped horizon — the default-horizon call overpriced
    // tombstones ~0.4 utility in over-budget windows (T*≈0), biasing
    // relief toward tombstoning exactly when the window is fullest.
    const tombFV = profile !== undefined
      ? futureValue(profile.mu0, profile.alpha, deltaT, 0, ps.fv.qHandle, ps, caps.hValue)
      : 0;
    const opts: { id: string; weight: number; profit: number }[] = [
      { id: "keep", weight: keepW, profit: keepP },
      { id: "evict", weight: 0, profit: 0 },
    ];
    const tomb = c.option.zeroValue === true ? undefined : c.item.options().find((o) => o.zeroValue === true && o.tokens < c.option.tokens);
    if (tomb !== undefined) {
      opts.push({ id: "tombstone:" + tomb.id, weight: tomb.tokens, profit: Math.max(0, Math.round(tombFV * SCALE)) });
    }
    return { id: c.item.id, options: opts };
  });

  // Bounded relief (2026-08-24, perf item 1): below the vendor's 50 MiB DP
  // budget this is byte-identical to exact (the bounded branch never
  // engages). Above it — genuinely over-budget full windows, measured
  // 7.6-15.2B DP cells / 37-42s in divide-and-conquer mode — the vendor
  // returns the certified integral greedy incumbent with honest
  // [greedyLower, lpUpper] bounds (status "bounded"), never "optimal".
  const res = solveMckp({ groups, capacity }, { reliefMode: "bounded" });
  if ((res.status !== "optimal" && res.status !== "bounded") || res.choices === null) {
    return; // density loop is the fallback below
  }
  const reliefBounded = res.status === "bounded";
  const reliefGap = reliefBounded && res.bounds !== null ? res.bounds.lpUpper - res.bounds.greedyLower : 0;

  const choiceById = new Map(res.choices.map((ch) => [ch.groupId, ch.optionId] as const));
  for (let i = chosen.length - 1; i >= 0; i--) {
    const c = chosen[i]!;
    const pick = choiceById.get(c.item.id);
    if (pick === undefined || pick === "keep") continue;
    if (pick.startsWith("tombstone:")) {
      const tomb = c.item.options().find((o) => o.id === pick.slice("tombstone:".length));
      if (tomb === undefined) continue;
      itemLedgers.push({
        turn, id: c.item.id,
        forecast: { mu0: ps.profiles[c.item.kind]?.mu0 ?? 1, alpha: ps.profiles[c.item.kind]?.alpha ?? 1, deltaT: turn - c.item.lastTouchTurn, hazard: ps.hazardPriors[c.item.kind] ?? 0.05, basis: "prior", expectedValue: 0 },
        utility: { benefit: 0, cacheCost: 0, rotShare: 0, total: 0 },
        decision: "purge", accepted: true, marginVsHysteresis: ps.budgetLambda, optionChosen: tomb.id,
        coupledReason: "budget-tombstone-exact",
      });
      c.option = tomb;
    } else {
      // Strand (review A-M1): journal the realized suffix re-bill on the
      // drop row — the relief decision priced it via keep-profit, so the
      // ledger should carry the same number.
      const strand = strandCost.get(c.item.id) ?? 0;
      chosen.splice(i, 1);
      itemLedgers.push({
        turn, id: c.item.id,
        forecast: { mu0: ps.profiles[c.item.kind]?.mu0 ?? 1, alpha: ps.profiles[c.item.kind]?.alpha ?? 1, deltaT: turn - c.item.lastTouchTurn, hazard: ps.hazardPriors[c.item.kind] ?? 0.05, basis: "prior", expectedValue: c.utility },
        utility: { benefit: c.utility, cacheCost: strand, rotShare: 0, total: c.utility },
        decision: "drop", accepted: true, marginVsHysteresis: ps.budgetLambda,
      });
    }
  }
}

/** Transaction cost: additive append is cheap; a rewrite re-prices the suffix (0004 §5–6). */
interface PrevRender { position: number; zone: Zone; digest: string; representation: string; optionId: string }
function transactionCost(item: ContextItem, o: RenderOption, prev: PrevRender | undefined, incumbent: Incumbent, ps: ParamSet, turn?: number, wallTimeMs?: number): number {
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
  // Per-block freshness evidence (review MAJOR-4, 2026-08-24): decide
  // wall-vs-turn per suffix block, never globally. A block with a usable
  // wall stamp is judged by wall time; a block whose wall stamp is absent
  // falls back to its turn stamp. The suffix is cold (free restructure)
  // only when EVERY suffix block is expired under its own best evidence.
  // The prior global hasWallEvidence let one partial wall array suppress
  // the turn fallback for stamps it did not cover.
  // Follow-up #6 (2026-08-24): evidence arrays may run past the REAL block
  // count (malformed incumbent). Clamp the suffix scan to blockCount so
  // phantom stamps cannot warm — or chill — blocks that do not exist.
  const suffixCount = Math.min(
    Math.max(
      (incumbent.blockWriteWallTimeMs?.length ?? 0),
      (incumbent.blockWriteTurns?.length ?? 0),
      incumbent.blockMass?.length ?? 0,
    ),
    incumbent.blockCount,
  ) - prev.position;
  let expired = true;
  if (cache.ttlMs !== undefined && wallTimeMs !== undefined
      && incumbent.cacheSnapshotWallTimeMs !== undefined
      && wallTimeMs - incumbent.cacheSnapshotWallTimeMs > cache.ttlMs) {
    return own; // whole-cache snapshot older than TTL: everything is cold
  }
  if (suffixCount <= 0) expired = false;
  for (let i = prev.position; i < prev.position + suffixCount; i++) {
    const wallStamp = incumbent.blockWriteWallTimeMs?.[i];
    if (cache.ttlMs !== undefined && wallTimeMs !== undefined && wallStamp !== undefined) {
      if (wallTimeMs - wallStamp > cache.ttlMs!) { continue; }
      expired = false;
      break;
    }
    const turnStamp = incumbent.blockWriteTurns?.[i];
    if (turnStamp !== undefined && turn !== undefined) {
      if (turn - turnStamp > cache.ttlTurns) { continue; }
      expired = false;
      break;
    }
    // No usable evidence for this block: treat as warm (charge the suffix).
    expired = false;
    break;
  }
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
  deltaT: number, hazard: number, basis: "prior" | "observed", hazardBasis: "prior" | "observed", value: number,
  s: { o: RenderOption; cacheCost: number; fidelity: number; rotEstimate: number; utility: number; fv?: number },
  decision: ItemLedger["decision"], accepted: boolean, margin: number, optionId: string,
): ItemLedger {
  return {
    turn, id: item.id,
    // Review A-M6 fix (2026-08-22): hazard basis is journaled as its own
    // field. `basis` is the VALUE basis (evidence-priced?); previously an
    // observed hazardOverride with no refEvidence journaled basis "prior"
    // while forecast.hazard carried the observed value — reportHazard
    // bucketed observed data into prior buckets, contaminating the very
    // calibration it measures.
    forecast: { mu0: profile.mu0, alpha: profile.alpha, deltaT, hazard, basis, hazardBasis, expectedValue: value, futureValue: s.fv ?? 0 },
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
