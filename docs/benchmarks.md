# Benchmarks

All numbers measured on Mac Studio M4 Max (arm64), Bun 1.3.14, 2026-08-20, unless
noted. Reproduce with `bun bench/bench.ts` (sessions) and the scripts in `bench/`.
jcode figures are their *published claims*, not our measurements.

## Runtime choice (measured here)

| Metric | Bun 1.3.14 | Node 22.16 |
|---|---|---|
| Process spawn → trivial script (median, n=10) | 21.0 ms | 29.4 ms |
| Session RSS after 2s idle (identical file) | 27 MB | 37 MB |
| In-process 1000 trivial cell ops | 0.085 ms | — |

Note: Bun's advertised ~1–2ms boot is time-to-first-JS *inside* the process; a real
terminal invocation pays process spawn (~20ms). Both are humanly instantaneous.

## Concurrent persistent sessions (bench/bench.ts)

10 sessions as workers in one Bun process, each holding ~1MB structured state plus a
131KB context-buffer-equivalent string; state verified resident by query.

| Metric | Measured |
|---|---|
| Session spawn + state load (median) | 11.7 ms |
| Marginal RSS per session | ~6–7 MB |
| 10 warm sessions total | 98 MB |
| Turn dispatch round-trip (worker boundary) | 54µs median / 94µs p95 |

jcode publishes ~10MB marginal / ~117MB for 10 sessions — same league, while sessions
carry live programmatic state (jcode sessions hold only transcripts).

## Persistence costs (from the test suite)

| Operation | Cost |
|---|---|
| Journal append per turn | ~50µs |
| Full snapshot commit, small namespace | 0.1–0.3 ms |
| Full snapshot commit, ~5MB namespace (20k records) | ~9.3 ms |
| Recovery, snapshot only, fresh process | 5.5 ms |

Interpretation: the entire price of the never-replay guarantee is sub-10ms per turn,
scaling with serializable state, not session length.
