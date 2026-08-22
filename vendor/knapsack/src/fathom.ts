import { KnapsackOption, ReducedGroup } from "./types.ts";
import { greedyWalk } from "./lp.ts";

/**
 * Option fathoming: drop a hull option when a VALID upper bound on every
 * completion through it cannot reach the incumbent value.
 *
 * Bound for option o in group g (all other groups at their hull base, then
 * filled at the global maximum increment density λ_max — an over-estimate by
 * construction, since no segment anywhere has density above λ_max):
 *
 *   bound(o) = baseP_other(g) + o.profit
 *            + max(0, capacity - baseW_other(g) - o.weight) * λ_max
 *
 * where baseP_other/baseW_other are the sums of the other groups' hull-min
 * profits/weights. If bound(o) < incumbent, no feasible completion through o
 * beats the incumbent. The incumbent path's own options are always preserved.
 *
 * Integer form (λ = λp/λw, λw > 0):
 *   bound(o) >= T  <=>  (baseP + o.profit)*λw + λp*max(0, slack) >= T*λw
 */
export interface FathomResult {
  readonly groups: ReducedGroup[];
  readonly fathomedCount: number;
}

export function fathomOptions(
  reduced: readonly ReducedGroup[],
  capacity: number,
  lp: { lowerBound: number; maxGradient: { p: number; w: number } },
  incumbentValue: number,
): FathomResult {
  const { p: lamP, w: lamW } = lp.maxGradient;
  const useGradient = lamP > 0 && lamW > 0;
  const walk = greedyWalk(reduced, capacity);
  const incumbentIndex = new Map<string, number>();
  reduced.forEach((g, i) => incumbentIndex.set(g.id, walk.state.indices[i]!));

  // Per-group base sums of the OTHER groups.
  const totalBaseP = reduced.reduce((s, g) => s + g.options[0]!.profit, 0);
  const totalBaseW = reduced.reduce((s, g) => s + g.options[0]!.weight, 0);

  const out: ReducedGroup[] = [];
  let fathomedCount = 0;

  for (const g of reduced) {
    if (!useGradient) {
      out.push(g);
      continue;
    }
    const baseP = totalBaseP - g.options[0]!.profit;
    const baseW = totalBaseW - g.options[0]!.weight;
    const incIdx = incumbentIndex.get(g.id);
    const keep: KnapsackOption[] = [];
    for (let i = 0; i < g.options.length; i++) {
      const o = g.options[i]!;
      if (i === incIdx) {
        keep.push(o); // incumbent path is untouchable
        continue;
      }
      const slack = Math.max(0, capacity - baseW - o.weight);
      const lhs = (baseP + o.profit) * lamW + lamP * slack;
      const rhs = incumbentValue * lamW;
      if (lhs >= rhs) keep.push(o);
      else fathomedCount++;
    }
    // A group never becomes empty: its incumbent option always survives.
    out.push({ ...g, options: keep.length > 0 ? keep : g.options });
  }
  return { groups: out, fathomedCount };
}
