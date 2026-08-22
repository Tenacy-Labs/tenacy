import { KnapsackGroup, KnapsackOption, ReducedGroup } from "./types.ts";

/**
 * Within-group dominance reduction (Pareto frontier).
 *
 * An option is dominated when another has weight <= and profit >= (one
 * strict). Only the strict Pareto frontier survives: weight strictly
 * increasing, profit strictly increasing. This reduction is EXACT — no
 * optimal solution ever uses a dominated option, so it is safe for the DP.
 *
 * Classical lineage: mcknap preprocessing; Booking.com's production pipeline
 * opens with the same transform. O(k log k) per group.
 */
export function reduceGroupToHull(group: KnapsackGroup): ReducedGroup {
  const sorted = group.options.slice().sort((a, b) => {
    if (a.weight !== b.weight) return a.weight - b.weight;
    if (a.profit !== b.profit) return b.profit - a.profit; // higher profit first
    return a.id < b.id ? -1 : 1; // code-unit tie-break, no locale collation
  });
  const hull: typeof sorted = [];
  let bestProfit = -1;
  for (const opt of sorted) {
    if (opt.profit > bestProfit) {
      hull.push(opt);
      bestProfit = opt.profit;
    }
  }
  return { id: group.id, options: hull, originalCount: group.options.length };
}

export function reduceAll(groups: readonly KnapsackGroup[]): ReducedGroup[] {
  return groups.map(reduceGroupToHull);
}

/**
 * Upper CONVEX hull of an already Pareto-reduced group.
 *
 * Removes points lying on or below the chord between neighbors (integer
 * cross-product test; collinear middle points dropped — the chord skips them
 * with equal slope, so the LP is unaffected and the DP never sees this set).
 *
 * On the convex hull, segment densities are STRICTLY DECREASING with weight —
 * the property the Dyer–Zemel LP walk depends on. This reduction is valid for
 * BOUNDS ONLY: an optimal integral solution may use a non-convex point
 * (e.g. profit-cliff options), so the DP must run on the Pareto set.
 */
export function convexHull(g: ReducedGroup): ReducedGroup {
  const pts = g.options;
  if (pts.length <= 2) return g;
  const out: KnapsackOption[] = [pts[0]!];
  for (let i = 1; i < pts.length; i++) {
    const c = pts[i]!;
    // Pop while the last kept point lies on/below the chord (kept[-2] -> c).
    // cross = (b-a)×(c-a) > 0  <=>  b lies BELOW chord(a,c)  <=>  b is a dent.
    while (out.length >= 2) {
      const a = out[out.length - 2]!;
      const b = out[out.length - 1]!;
      const cross =
        (b.weight - a.weight) * (c.profit - a.profit) -
        (b.profit - a.profit) * (c.weight - a.weight);
      if (cross < 0) break; // b strictly ABOVE the chord: a true hull vertex
      out.pop(); // b on or below the chord: dent — remove
    }
    out.push(c);
  }
  return { id: g.id, options: out, originalCount: g.originalCount };
}

/** Minimum hull weight of a reduced group (its first option — hull is sorted). */
export function minWeightOf(g: ReducedGroup): number {
  return g.options[0]!.weight;
}

/** Maximum hull profit of a reduced group (its last option — hull is sorted). */
export function maxProfitOf(g: ReducedGroup): number {
  return g.options[g.options.length - 1]!.profit;
}
