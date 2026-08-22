/**
 * INTEGRATION tests: delta consolidation lattice through the LIVE path.
 *
 * The unit tests in delta-lattice.test.ts hand-set the exact state the bugs
 * hid in (lens.baseBlockTurn = 1; commitConsolidation("base+(d1,d2)")) —
 * so they passed while live flow was broken. These tests instead drive the
 * real cycle every turn: noteLiveDelta → solve → pick → commitConsolidation
 * (with the SOLVER's id, never a handcrafted one) → next turn's surface.
 * Incumbent is threaded turn-to-turn exactly as the loop does.
 *
 * Scenarios (each names the shipped bug it would have caught):
 *  1. Lattice arms through live flow — first committed byte-carrying render
 *     establishes the base; a following delta produces lattice options.
 *     [would have caught: baseBlockTurn never set in live flow — the
 *      lattice NEVER armed; both A/B arms rendered 'full' ×8]
 *  2. 5-delta burst then stop — deltas publish (journal stays open through
 *     committed CHAIN picks), renders stabilize at quiescence.
 *     [would have caught: noteLiveDelta no-op with no base; chain commits
 *      consuming the journal would make publishing unreachable]
 *  3. Fusion consumes the journal at EVERY arity (1, 2, 3, 5) — forced-
 *     fusion surface through real solve; journal must clear and the base
 *     re-bank. Fusion bytes must equal the fresh substrate slice.
 *     [would have caught: literal-id matching skipped arity 1 and 3+,
 *      leaving a consumed journal pending forever]
 *  4. Burst economics — publish-through-burst is strictly cheaper than
 *     forced fusion each step, under the kernel's own realized cache cost.
 *     [would have caught: any of the above — with the lattice dead both
 *      policies cost identical fulls]
 */
import { describe, test } from "bun:test";
import { FileLensItem } from "../src/optimizer/lens.ts";
import { StandingItem } from "../src/optimizer/items.ts";
import { ContextStore } from "../src/optimizer/store.ts";
import { solve, type Incumbent } from "../src/optimizer/solver.ts";
import { paramSetV1 } from "../src/optimizer/params.ts";

const LINES = 100;
const CONTENT = Array.from({ length: LINES }, (_, i) => `line ${i + 1} ${"x".repeat(30)}`).join("\n");
const DELTA_EVENTS: number[][] = [[10], [25, 26], [40], [55, 56, 57], [70]];

function freshLens(id = "lens:int.ts"): FileLensItem {
  const lens = new FileLensItem(id, "int.ts", CONTENT);
  lens.expand(1, LINES);
  lens.valueBump = { amount: 8, untilTurn: 99 };   // honest value signal (ctx.promote)
  return lens;
}

type Inc = Incumbent & {
  rendered: Map<string, { position: number; zone: string; digest: string; representation: string; optionId: string }>;
  totalTokens: number; blockCount: number;
};
const EMPTY_INC: Inc = { rendered: new Map(), totalTokens: 0, blockCount: 0 } as never as Inc;

/** One live turn: swap the lens item into the snapshot, solve, return the pick. */
function turn(
  lens: FileLensItem, store: ContextStore, incumbent: Inc, turnNo: number,
  restrict?: (ids: string[]) => string[],
): { pick: { id: string; optionId: string; tokens: number; digest: string; position: number } | undefined; next: Inc } {
  const items = new Map(store.snapshot());
  const fresh = lens.toContextItem();
  let lensItem = fresh;
  if (restrict !== undefined) {
    const allowed = new Set(restrict(fresh.options().map((o) => o.id)));
    lensItem = { ...fresh, options: () => fresh.options().filter((o) => allowed.has(o.id)) } as never;
  }
  items.set(lens.id, lensItem);
  const res = solve(items, incumbent as never, paramSetV1("m") as never, turnNo);
  const place = res.placements.find((p) => p.id === lens.id);
  const next: Inc = {
    rendered: new Map(res.placements.map((p) => [p.id, { position: p.position, zone: p.zone, digest: p.digest, representation: p.representation, optionId: p.optionId }])),
    totalTokens: res.placements.reduce((s, p) => s + p.tokens, 0),
    blockCount: res.placements.length,
  } as never as Inc;
  if (place === undefined) return { pick: undefined, next };
  return { pick: { id: place.id, optionId: place.optionId, tokens: place.tokens, digest: place.digest, position: place.position }, next };
}

function newStore(): ContextStore {
  const store = new ContextStore();
  store.add(new StandingItem("identity", "identity", "id").toContextItem());
  return store;
}

/** Read the journal length without TS flow-narrowing (mutation happens inside
 *  lens methods, which narrowing cannot see — a literal check would poison
 *  later literal comparisons as "no overlap"). */
function journalLen(l: FileLensItem): number {
  return l.pendingDeltas.length;
}

describe("delta lattice — live-path integration", () => {
  test("1. lattice arms through live flow: committed full establishes the base, next delta yields lattice options", () => {
    const lens = freshLens();
    const store = newStore();
    let inc = EMPTY_INC;

    // Turn 2: no base yet — full is the only byte-carrying option. Commit the SOLVER's pick.
    const t2 = turn(lens, store, inc, 2);
    if (t2.pick === undefined) throw new Error("lens not placed at t2");
    if (t2.pick.optionId !== "full") throw new Error(`pre-base turn must pick full, got ${t2.pick.optionId}`);
    lens.commitConsolidation(t2.pick.optionId, 2);
    if (lens.baseBlockTurn !== 2) throw new Error(`base must be established by the committed full pick, got baseBlockTurn=${lens.baseBlockTurn}`);
    if (journalLen(lens) !== 0) throw new Error("journal must be empty after base establishment");
    inc = t2.next;

    // Turn 3: one live delta — the lattice MUST now present itself.
    lens.noteLiveDelta(3, DELTA_EVENTS[0]!);
    const before = lens.options().map((o) => o.id);
    if (!before.some((id) => id.startsWith("base+"))) throw new Error(`delta after established base must yield lattice options, got ${JSON.stringify(before)}`);
    const t3 = turn(lens, store, inc, 3);
    if (t3.pick === undefined) throw new Error("lens not placed at t3");
    if (!t3.pick.optionId.startsWith("base+")) throw new Error(`live pick after delta must be a base+ form, got ${t3.pick.optionId}`);
    lens.commitConsolidation(t3.pick.optionId, 3);
    if (lens.pendingDeltas.length !== 1) throw new Error(`chain pick must KEEP the journal open (publish policy), journal=${lens.pendingDeltas.length}`);
  });

  test("2. five-delta burst then stop: journal publishes through burst, renders stabilize at quiescence", () => {
    const lens = freshLens();
    const store = newStore();
    let inc = EMPTY_INC;

    const t2 = turn(lens, store, inc, 2);
    if (t2.pick === undefined) throw new Error("lens not placed at t2");
    lens.commitConsolidation(t2.pick.optionId, 2);
    inc = t2.next;

    // Burst turns 3..7: one delta event per turn. Every committed pick must
    // keep the journal open (publishing), growing by one per turn.
    let lastDigest = t2.pick.digest;
    for (let t = 3; t <= 7; t++) {
      lens.noteLiveDelta(t, DELTA_EVENTS[t - 3]!);
      const r = turn(lens, store, inc, t);
      if (r.pick === undefined) throw new Error(`lens not placed at t${t}`);
      if (!r.pick.optionId.startsWith("base+")) throw new Error(`burst turn t${t} must publish a base+ form, got ${r.pick.optionId}`);
      lens.commitConsolidation(r.pick.optionId, t);
      if (lens.pendingDeltas.length !== t - 2) throw new Error(`journal must grow through burst: expected ${t - 2} pending, got ${lens.pendingDeltas.length}`);
      lastDigest = r.pick.digest;
      inc = r.next;
    }

    // Quiet turns 8..9: no new deltas. The resting render must be STABLE —
    // no rewrite churn, no journal mutation.
    for (const t of [8, 9]) {
      const r = turn(lens, store, inc, t);
      if (r.pick === undefined) throw new Error(`lens not placed at t${t}`);
      lens.commitConsolidation(r.pick.optionId, t);
      if (lens.pendingDeltas.length !== 5) throw new Error(`quiescence must not mutate the journal, got ${lens.pendingDeltas.length}`);
      if (r.pick.digest !== lastDigest) throw new Error(`quiescent render must be byte-stable (digest changed at t${t})`);
      inc = r.next;
    }
  });

  test("3. fusion consumes the journal at every arity (1, 2, 3, 5) — the literal-id regression", () => {
    for (const k of [1, 2, 3, 5]) {
      const lens = freshLens();
      const store = newStore();
      let inc = EMPTY_INC;

      const t2 = turn(lens, store, inc, 2);
      if (t2.pick === undefined) throw new Error(`k=${k}: lens not placed at t2`);
      lens.commitConsolidation(t2.pick.optionId, 2);
      inc = t2.next;

      // k deltas over k turns
      for (let i = 0; i < k; i++) lens.noteLiveDelta(3 + i, DELTA_EVENTS[i % DELTA_EVENTS.length]!);

      // Fusion truth at k>=2: fused bytes equal the fresh substrate slice over the union.
      const fusionOpt = lens.options().find((o) => o.id.startsWith("base+("));
      if (fusionOpt === undefined) throw new Error(`k=${k}: fusion option missing`);
      const affected = Array.from(new Set(DELTA_EVENTS.slice(0, k).flat())).sort((a, b) => a - b);
      const slice = lens.sliceRangePublic(affected[0]!, affected[affected.length - 1]!);
      if (!fusionOpt.text.includes(slice)) throw new Error(`k=${k}: fusion body is not the fresh substrate slice`);

      // Force the fusion surface through a REAL solve (a consolidation-forcing
      // policy), commit the solver's pick, and demand the journal be consumed.
      const restrict = (ids: string[]) => ids.filter((id) => id.startsWith("base+("));
      const tk = turn(lens, store, inc, 2 + k, restrict);
      if (tk.pick === undefined) throw new Error(`k=${k}: lens not placed on forced-fusion turn`);
      if (!tk.pick.optionId.startsWith("base+(")) throw new Error(`k=${k}: forced-fusion surface must yield a fusion pick, got ${tk.pick.optionId}`);
      lens.commitConsolidation(tk.pick.optionId, 2 + k);
      if (lens.pendingDeltas.length !== 0) throw new Error(`k=${k}: fusion pick must CONSUME the journal, still pending ${lens.pendingDeltas.length}`);
      if (lens.baseBlockTurn !== 2 + k) throw new Error(`k=${k}: fusion must re-bank the base at commit turn, got ${lens.baseBlockTurn}`);
      // Post-ratchet surface: pre-lattice forms only — no lattice ids remain.
      const after = lens.options().map((o) => o.id);
      if (after.some((id) => id.startsWith("base+(") || /^\(base,/.test(id))) throw new Error(`k=${k}: ratchet must retire lattice states, got ${JSON.stringify(after)}`);
    }
  });

  test("4. burst economics: publish-through-burst is strictly cheaper than forced fusion each step", () => {
    const CU = paramSetV1("m").cache.pricePer1kUncached;
    const CC = paramSetV1("m").cache.pricePer1kCached;

    /** Realized cache cost of the lens block for one turn (kernel economics:
     *  keep = 0; chain append = cached write; rewrite = uncached + suffix reprice). */
    function realizedCost(
      pick: { optionId: string; tokens: number; digest: string; position: number },
      prevDigest: string, prevPos: number, prevBlocks: number, inc: Inc,
    ): number {
      if (pick.digest === prevDigest) return 0;
      if (pick.optionId.startsWith("base+") && !pick.optionId.includes("(")) return (pick.tokens / 1000) * CC;
      let cost = (pick.tokens / 1000) * CU;
      const blocksAfter = Math.max(0, prevBlocks - prevPos);
      if (prevBlocks > 0) cost += (inc.totalTokens * (blocksAfter / Math.max(1, prevBlocks)) / 1000) * (CU - CC);
      return cost;
    }

    function runPolicy(mode: "publish" | "fuse-each-step"): number {
      const lens = freshLens();
      const store = newStore();
      let inc = EMPTY_INC;
      let prevDigest = ""; let prevPos = 0; let prevBlocks = 0; let total = 0;

      for (let t = 2; t <= 7; t++) {
        if (t >= 3) lens.noteLiveDelta(t, DELTA_EVENTS[t - 3]!);
        const restrict = mode === "fuse-each-step" && lens.pendingDeltas.length > 0
          ? (ids: string[]) => ids.filter((id) => id.startsWith("base+("))
          : undefined;
        const r = turn(lens, store, inc, t, restrict);
        if (r.pick === undefined) throw new Error(`${mode}: lens not placed at t${t}`);
        total += realizedCost(r.pick, prevDigest, prevPos, prevBlocks, inc);
        prevDigest = r.pick.digest; prevPos = r.pick.position; prevBlocks = r.next.blockCount;
        inc = r.next;
        lens.commitConsolidation(r.pick.optionId, t);
      }
      return total;
    }

    const publish = runPolicy("publish");
    const fuseEachStep = runPolicy("fuse-each-step");
    // Measured on this scenario (2026-08-22 probe): $3.34 vs $19.67 — 6.2×.
    // Assert strict dominance with generous headroom for parameter drift.
    if (!(publish < fuseEachStep * 0.5)) {
      throw new Error(`publish-through-burst must dominate forced fusion: publish=$${publish.toFixed(3)} fuse-each-step=$${fuseEachStep.toFixed(3)}`);
    }
  });
});
