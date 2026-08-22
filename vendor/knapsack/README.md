# @connectotron/knapsack

Exact **multiple-choice knapsack problem (MCKP)** solver in pure TypeScript.
Zero dependencies, integer-exact bounds, deterministic output, built for
latency-sensitive in-process use: pick one option per group under a weight
budget, maximize total profit — proven optimal, every time.

Born from [agent-kernel](https://github.com/Connectotron/agent-kernel)'s
per-turn context optimizer (ADR-0005: the render solve *is* an MCKP),
extracted as a standalone component for pure focus on mathematical structure
and implementation efficiency. First consumer: agent-kernel; the library
knows nothing about LLMs, tokens, or turns.

## The problem

```
maximize   Σ_i  p_i(x_i)          one option x_i per group i
subject to Σ_i  w_i(x_i) ≤ C      integer weights and profits
```

Agent-kernel's mapping: groups = context items, options = render variants,
weight = tokens, C = the turn budget, profit = utility.

## API

```ts
import { solve } from "@connectotron/knapsack";

const result = solve({
  groups: [
    {
      id: "file:src/lp.ts",
      options: [
        { id: "full",   weight: 420, profit: 90 },
        { id: "outline", weight: 60, profit: 55 },
        { id: "purge",   weight: 0,  profit: 0  },
      ],
    },
    // ... more groups
  ],
  capacity: 8_000,
});

result.status;        // "optimal" | "infeasible"
result.value;         // optimal total profit
result.choices;       // [{ groupId, optionId }, ...] — one per group
result.bounds;        // { lpUpper, greedyLower } — LP/Dantzig bracket
result.stats;         // reduction counts, dpRequired, dpCellsVisited
```

`weight` and `profit` are non-negative integers (validated; throws
`KnapsackValidationError` otherwise). "Choose nothing" semantics are modeled
explicitly with a zero-weight zero-profit option — agent-kernel's purge.
Capacity is a non-negative integer below 2²¹, and the problem must satisfy
the exactness envelope (Σ per-group max profits)·(largest weight) < 2⁵³,
and each group may carry at most 255 options (all validated; throws
`KnapsackValidationError` otherwise). Option ids must be
unique within a group; group ids globally unique.

## Pipeline

Each stage is the classical exact-MCKP lineage, adapted for small instances
re-solved every turn (full survey with sources in [`docs/survey.md`](docs/survey.md)):

1. **Validate** — structure and integer-domain enforcement.
2. **Pareto reduction** — within-group dominance: an option dominated in both
   weight and profit can never be chosen; exact, safe for the final search.
3. **LP relaxation on convex hulls** (Dyer–Zemel parametrization) — walk the
   hulls' incremental segments in density order using integer cross-product
   comparisons; yields the Dantzig upper bound, a greedy integral incumbent,
   and the break gradient. No floats touch any decision.
4. **Fathom** — drop hull options whose optimistic completion (base profits +
   λ_max slack bound, integer form) cannot reach the incumbent.
5. **Exact DP** — two-row `Int32Array` Bellman with reachable-weight
   windowing; skipped entirely when the LP solution is integral (the greedy
   walk consumed every segment — a certificate of optimality). Memory is
   budget-dispatched: when the back-pointer table would exceed 50 MiB the
   DP switches to a divide-and-conquer traceback (Hirschberg shape) that
   uses only four `O(C)` rows — peak stays bounded at any input size the
   validation envelope admits, at ≤ 2× time (measured +2% at the largest
   benchmark shape).

## Memory

Peak DP allocation is predictable at solve time:
`expectedDpBytes(n, C) = n·(C+1) + 8·(C+1)` bytes in back-pointer mode
(u8 table), cross-validated within ±3% against measured peak RSS across
11 shapes and two languages. Above a configurable budget (default
50 MiB) the solver automatically uses the O(C)-memory divide-and-conquer
traceback — exact, deterministic, ≤ 2× time — so worst-case memory stays
under `16·(C+1) + ε` bytes no matter how many groups the caller brings.

Determinism: no locale collation, no float ordering, no unordered iteration
in any decision path. Same input, byte-identical output, every run.

## Performance

Measured on this machine (Mac Studio, Bun 1.3), median per-solve:

| shape | time | DP invoked |
|---|---|---|
| 20 groups × 3 options, w≤400 | 67 µs | 51% |
| 60 groups × 5 options, w≤600 | 103 µs | 3% |
| 120 groups × 6 options, w≤800 | 4.4 ms | 52% |
| 30 groups × 3 options, roomy capacity | 11 µs | 0% |

Correctness gate: every release is cross-checked against exhaustive
brute force on randomized instances (300 seeds in CI plus an adversarial
fuzz corpus: strongly-correlated, coarse-weight, and profit-cliff styles,
tight and roomy capacities — 600 seeds, zero divergence).

## Development

```sh
bun install
bun run typecheck   # bunx tsc --noEmit, strictest flags
bun test            # 307 tests incl. brute-force cross-check
bun run bench       # the numbers above
```

## Documentation

- **[docs/paper.md](docs/paper.md)** — the scientific write-up: problem
  statement, algorithm, correctness propositions, adversarial validation,
  measured results.
- **[docs/research/](docs/research/)** — the full research corpus this
  implementation was extracted from (solver survey, classical exact-MCKP
  extraction, production-implementation reviews, online-policy papers).

## License

MIT — see [LICENSE](LICENSE).
