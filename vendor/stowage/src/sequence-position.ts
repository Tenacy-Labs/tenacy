/** Deterministic phase-3 sequence-position placement (ADR-0001). */
import { ZONE_ORDER } from "./types.ts";
import type { ContextItem, ItemLedger, RenderOption, SequencePosition, Zone } from "./types.ts";

export const MAX_MOVE_PASSES = 5;

export interface PriorMove {
  fromPosition: number;
  toPosition: number;
}

export interface PositionEntry {
  item: ContextItem;
  option: RenderOption;
  utility: number;
}

export interface MoveDiagnostics {
  movePasses: number;
  capped: boolean;
  acceptedMoves: number;
  reversals: number;
  moveThrash: boolean;
}

function sequenceOf(entry: PositionEntry): SequencePosition | undefined {
  return entry.option.sequence ?? entry.item.sequence;
}

/**
 * Prefix-mass preprocessing is O(n). A candidate move crosses the blocks
 * strictly between its old slot and target branch point, queried in O(1).
 * `target` is a boundary in the original array, in [0, masses.length].
 */
export function interveningMoveMass(
  masses: readonly number[],
  from: number,
  target: number,
): number {
  if (from < 0 || from >= masses.length || target < 0 || target > masses.length) return 0;
  const prefix = new Array<number>(masses.length + 1).fill(0);
  for (let i = 0; i < masses.length; i++) prefix[i + 1] = prefix[i]! + masses[i]!;
  return interveningFromPrefix(prefix, from, target);
}

function interveningFromPrefix(prefix: readonly number[], from: number, target: number): number {
  if (target > from) return prefix[target]! - prefix[from + 1]!;
  if (target < from) return prefix[from]! - prefix[target]!;
  return 0;
}

/**
 * Establish legal representative ordering before priced moves:
 * - non-sequence blocks retain canonical order;
 * - each lineage is in ordinal/id order (explicit precedence);
 * - unfused deltas occupy their zone-tail/radix branch point.
 */
export function normalizeSequenceOrder(
  entries: PositionEntry[],
  zoneOf: (entry: PositionEntry) => Zone,
): void {
  // zoneOf pass: each entry's zone computed at most twice (reassembly + repair)
  // (review MAJOR-1 — the previous repair probed zones Θ(n·d) times).
  const zones: Zone[] = new Array(entries.length);
  for (let i = 0; i < entries.length; i++) zones[i] = zoneOf(entries[i]!);

  const deltas = entries.filter((entry) => {
    const sequence = sequenceOf(entry);
    return sequence?.role === "delta" && sequence.placement !== "fuse";
  });
  if (deltas.length > 0) {
    // Reassemble by buckets instead of per-delta splice scans: one
    // stable partition keeps every non-delta in canonical order while
    // each tail-delta lands at its zone's tail. O(n) after one sort of
    // the deltas only.
    const buckets = new Map<Zone, PositionEntry[]>();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const isDelta = sequenceOf(entry)?.role === "delta" && sequenceOf(entry)?.placement !== "fuse";
      if (!isDelta) continue;
      const zone = zones[i]!;
      const bucket = buckets.get(zone) ?? [];
      bucket.push(entry);
      buckets.set(zone, bucket);
    }
    // Canonical zone-order rebuild (review MAJOR-1 + MAJOR-3): one O(n)
    // reassembly. Kept (non-tail-delta) entries preserve stage-2 relative
    // order in contiguous zone runs; each zone's tail-delta bucket appends
    // AFTER that zone's last kept entry (the zone tail), and buckets for
    // zones with no kept entry flush at their ZONE_ORDER position. The
    // result is globally non-decreasing in ZONE_ORDER; zoneOf is probed
    // at most twice per entry.
    const result: PositionEntry[] = [];
    const isTailDelta = (e: PositionEntry): boolean =>
      sequenceOf(e)?.role === "delta" && sequenceOf(e)?.placement !== "fuse";
    let i = 0;
    while (i < entries.length) {
      if (isTailDelta(entries[i]!)) { i += 1; continue; }
      const zone = zones[i]!;
      const zoneIdx = ZONE_ORDER.indexOf(zone);
      const run: PositionEntry[] = [];
      while (i < entries.length) {
        if (isTailDelta(entries[i]!)) { i += 1; continue; }
        if (zones[i] !== zone) break;
        run.push(entries[i]!);
        i += 1;
      }
      for (const z of ZONE_ORDER) {
        if (ZONE_ORDER.indexOf(z) >= zoneIdx) break;
        const b = buckets.get(z);
        if (b !== undefined && b.length > 0) { result.push(...b); buckets.set(z, []); }
      }
      result.push(...run);
      const b = buckets.get(zone);
      if (b !== undefined && b.length > 0) { result.push(...b); buckets.set(zone, []); }
    }
    for (const z of ZONE_ORDER) {
      const b = buckets.get(z);
      if (b !== undefined && b.length > 0) result.push(...b);
    }
    entries.length = 0;
    entries.push(...result);
  }

  // Stable topological repair (review MAJOR-3, zone-local): sequence members
  // keep their occupied slots, while values placed in those slots are sorted
  // by per-parent precedence — WITHIN a single zone. Slot keys are
  // (parentId, zone): a foundational delta can never be written into an
  // evolving slot, so global zone order survives the repair.
  const zonesAfter: Zone[] = new Array(entries.length);
  for (let i = 0; i < entries.length; i++) zonesAfter[i] = zoneOf(entries[i]!);
  const byParent = new Map<string, { slots: number[]; values: PositionEntry[] }>();
  for (let i = 0; i < entries.length; i++) {
    const sequence = sequenceOf(entries[i]!);
    if (sequence === undefined) continue;
    const key = sequence.parentId + "\u0000" + zonesAfter[i]!;
    const family = byParent.get(key) ?? { slots: [], values: [] };
    family.slots.push(i);
    family.values.push(entries[i]!);
    byParent.set(key, family);
  }
  for (const family of byParent.values()) {
    const ordered = precedenceOrder(family.values);
    for (let i = 0; i < family.slots.length; i++) entries[family.slots[i]!] = ordered[i]!;
  }
}

/** Deterministic ITERATIVE topological order over each member's optional
 *  edge (review MINOR-3): identical output to the recursive DFS — walk the
 *  predecessor chain to its root, emit root-first — but with an explicit
 *  stack, so a 200k-member lineage cannot blow the call stack. Cycles are
 *  tolerated with the same ordinal/id fallback as before. */
function precedenceOrder(values: PositionEntry[]): PositionEntry[] {
  const sorted = [...values].sort(sequenceCompare);
  const byId = new Map(sorted.map((entry) => [entry.item.id, entry] as const));
  const emitted = new Set<string>();
  const ordered: PositionEntry[] = [];
  for (const start of sorted) {
    if (emitted.has(start.item.id)) continue;
    // Walk up the predecessor chain collecting the family spine.
    const spine: PositionEntry[] = [];
    const seen = new Set<string>();
    let cur: PositionEntry | undefined = start;
    while (cur !== undefined && !emitted.has(cur.item.id) && !seen.has(cur.item.id)) {
      seen.add(cur.item.id);
      spine.push(cur);
      const pid: string | undefined = sequenceOf(cur)?.predecessorId;
      cur = pid === undefined ? undefined : byId.get(pid);
    }
    // Emit root-first: deepest ancestor, then down the chain.
    for (let i = spine.length - 1; i >= 0; i--) {
      const entry = spine[i]!;
      if (emitted.has(entry.item.id)) continue;
      emitted.add(entry.item.id);
      ordered.push(entry);
   }
  }
  return ordered;
}

function sequenceCompare(a: PositionEntry, b: PositionEntry): number {
  const sa = sequenceOf(a)!;
  const sb = sequenceOf(b)!;
  if (sa.parentId !== sb.parentId) return sa.parentId < sb.parentId ? -1 : 1;
  if (sa.ordinal !== sb.ordinal) return sa.ordinal - sb.ordinal;
  return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
}

interface Candidate {
  entry: PositionEntry;
  from: number;
  target: number;
  bill: number;
  credit: number;
  accepted: boolean;
  reversal: boolean;
}

/**
 * Greedy file-migration planner. Each pass preprocesses prefix/suffix mass in
 * O(n), evaluates every lineage's fuse branch in O(1), and accepts at most one
 * deterministic best move. No random search and no additional selection call.
 */
export function planSequenceMoves(
  entries: PositionEntry[],
  itemLedgers: ItemLedger[],
  turn: number,
  previousMoves: ReadonlyMap<string, PriorMove> | undefined,
): MoveDiagnostics {
  let acceptedMoves = 0;
  let reversals = 0;
  let movePasses = 0;
  let capped = false;
  const rejectedLogged = new Set<string>();

  for (let pass = 0; pass < MAX_MOVE_PASSES; pass++) {
    movePasses += 1;
    const prefix = new Array<number>(entries.length + 1).fill(0);
    const suffix = new Array<number>(entries.length + 1).fill(0);
    for (let i = 0; i < entries.length; i++) prefix[i + 1] = prefix[i]! + entries[i]!.option.tokens;
    for (let i = entries.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1]! + entries[i]!.option.tokens;
    void suffix; // both axes are preprocessed once; candidates use prefix differences.

    // Follow-up #5 (2026-08-24): single scan implementation shared by the
    // pass loop and the post-cap probe — the duplicated candidate logic
    // could drift and silently diverge capped from what a further pass
    // would actually accept.
    const candidates = scanFuseCandidates(entries, prefix, previousMoves);

    candidates.sort((a, b) => {
      if (a.accepted !== b.accepted) return a.accepted ? -1 : 1;
      const surplusA = a.credit - a.bill;
      const surplusB = b.credit - b.bill;
      if (surplusA !== surplusB) return surplusB - surplusA;
      return a.entry.item.id < b.entry.item.id ? -1 : a.entry.item.id > b.entry.item.id ? 1 : 0;
    });
    const accepted = candidates.find((candidate) => candidate.accepted);

    for (const candidate of candidates) {
      if (candidate.accepted || rejectedLogged.has(candidate.entry.item.id)) continue;
      rejectedLogged.add(candidate.entry.item.id);
      itemLedgers.push(moveLedger(turn, candidate, false));
    }
    if (accepted === undefined) break;

    const [moved] = entries.splice(accepted.from, 1);
    const insertion = accepted.target > accepted.from ? accepted.target - 1 : accepted.target;
    entries.splice(insertion, 0, moved!);
    acceptedMoves += 1;
    if (accepted.reversal) reversals += 1;
    itemLedgers.push(moveLedger(turn, accepted, true));

    if (pass === MAX_MOVE_PASSES - 1) {
      // Review MAJOR-2 (2026-08-24): re-probe AFTER the final accepted
      // move. The move itself can unlock another candidate — each block
      // leaving the intervening window shrinks the next candidate's bill —
      // so pre-move candidate counts false-negatived the cap signal.
      capped = hasAcceptableMove(entries);
    }
  }

  return { movePasses, capped, acceptedMoves, reversals, moveThrash: reversals > 0 };
}

/**
 * Post-cap probe (review MAJOR-2): does any fuse candidate remain
 * acceptable in the CURRENT layout? Pure — no ledger writes, no mutation.
 * Runs once, only after the fifth accepted move.
 */
function hasAcceptableMove(entries: PositionEntry[]): boolean {
  const prefix = new Array<number>(entries.length + 1).fill(0);
  for (let i = 0; i < entries.length; i++) prefix[i + 1] = prefix[i]! + entries[i]!.option.tokens;
  return scanFuseCandidates(entries, prefix, undefined).some((c) => c.accepted);
}

function scanFuseCandidates(
  entries: PositionEntry[],
  prefix: number[],
  previousMoves: ReadonlyMap<string, PriorMove> | undefined,
): Candidate[] {
  // normalizeSequenceOrder guarantees per-parent precedence, so one linear
  // scan resolves every member's immediate predecessor; candidate evaluation
  // is then a pair of Map lookups plus an O(1) prefix query.
  // (Comment restored in the #5 dedup — it lived in the removed pass-loop copy.)
  const indexById = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) indexById.set(entries[i]!.item.id, i);
  const predecessorById = new Map<string, number>();
  const lastByParent = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    const sequence = sequenceOf(entries[i]!);
    if (sequence === undefined) continue;
    const explicitIndex = sequence.predecessorId === undefined ? undefined : indexById.get(sequence.predecessorId);
    const explicit = explicitIndex !== undefined
      && sequenceOf(entries[explicitIndex]!)?.parentId === sequence.parentId
      ? explicitIndex
      : undefined;
    const predecessor = explicit ?? lastByParent.get(sequence.parentId);
    if (predecessor !== undefined) predecessorById.set(entries[i]!.item.id, predecessor);
    lastByParent.set(sequence.parentId, i);
  }
  const candidates: Candidate[] = [];
  for (let from = 0; from < entries.length; from++) {
    const entry = entries[from]!;
    const sequence = sequenceOf(entry);
    if (sequence?.role !== "delta" || sequence.placement !== "fuse") continue;
    const predecessor = predecessorById.get(entry.item.id);
    if (predecessor === undefined) continue;
    const target = predecessor + 1;
    if (target === from || target === from + 1) continue;
    const bill = interveningFromPrefix(prefix, from, target);
    const credit = Math.max(0, sequence.migrationCreditTokens ?? 0);
    const prior = previousMoves?.get(entry.item.id);
    const proposed = { fromPosition: from + 1, toPosition: target + 1 };
    const reversal = prior !== undefined
      && prior.fromPosition === proposed.toPosition
      && prior.toPosition === proposed.fromPosition;
    candidates.push({ entry, from, target, bill, credit, accepted: credit >= bill, reversal });
  }
  return candidates;
}

function moveLedger(turn: number, candidate: Candidate, accepted: boolean): ItemLedger {
  const regret = candidate.bill - candidate.credit;
  return {
    turn,
    id: candidate.entry.item.id,
    forecast: { mu0: 0, alpha: 0, deltaT: 0, hazard: 0, basis: "prior", expectedValue: candidate.entry.utility },
    utility: { benefit: candidate.entry.utility, cacheCost: 0, rotShare: 0, total: candidate.entry.utility },
    decision: "move",
    accepted,
    marginVsHysteresis: -regret,
    optionChosen: candidate.entry.option.id,
    positionRegret: {
      fromPosition: candidate.from + 1,
      toPosition: candidate.target + 1,
      suffixBillTokens: candidate.bill,
      migrationCreditTokens: candidate.credit,
      regretTokens: regret,
      accepted,
      reversal: candidate.reversal,
      reason: accepted ? "credit-covered" : "insufficient-credit",
    },
    moveThrash: accepted && candidate.reversal,
  };
}
