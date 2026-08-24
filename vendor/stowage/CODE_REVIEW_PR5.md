# Code Review — PR #5: default native-first `dpKernel` policy with TS soa fallback

- **PR:** #5 `feat: default dpKernel prefers native with TS soa fallback`
- **Branch:** `perf/native-default` @ `a04743e` ← `main` @ `0affcc9` (MERGEABLE, 1 commit)
- **Reviewer:** fresh context, 2026-08-24. Repo treated as data; all gates re-run this session on this host (aarch64 darwin, dylib present). CI rollup on head: `test` SUCCESS (ubuntu-latest, bun 1.3.14, frozen lockfile).
- **Diff:** 6 files, +153/−19 — `README.md`, `vendor/knapsack/README.md`, `vendor/knapsack/package.json` (0.1.1→0.2.0), `vendor/knapsack/src/solve.ts`, `vendor/knapsack/src/types.ts`, `vendor/knapsack/test/native.test.ts`. Nothing else touched; no artifacts; worktree clean at `a04743e`.

## Verdict: **APPROVE**

Functional behavior is correct and verified on every dispatch route, observability is honest, the behavior flip has zero blast radius inside this repo, the new tests genuinely discriminate on both host classes, all gates are green (re-run, not trusted), and the README claims check out against both committed spike measurements and a fresh probe. Two stale in-code doc comments predate this PR and are listed as Minors with a recommended follow-up — they do not change behavior.

---

## A. Dispatch correctness — VERIFIED

`solve.ts:214–233` read in full; additionally exercised live (`/tmp` probe, `bun run`, this host):

| Route | Expected | Probe result |
|---|---|---|
| default, dylib present, under budget | native | `kernelUsed=native` ✓ |
| default, dylib forced absent (`KNAPSACK_NATIVE_DYLIB=/nonexistent` + cache reset) | soa | `kernelUsed=soa` ✓ (and `native` again after restore) ✓ |
| default, above budget (`maxDpBytes: 1000`) | reference D&C | `kernelUsed=reference`, status `optimal` ✓ |
| `dpKernel:"native"`, above budget | reference D&C | `kernelUsed=reference` ✓ |
| `dpKernel:"soa"`, above budget | reference D&C | `kernelUsed=reference` ✓ |
| `reliefMode:"bounded"`, above budget | bounded early return, no DP | `status=bounded`, `kernelUsed=none` ✓ |
| infeasible | early return | `status=infeasible`, `kernelUsed=none` ✓ |
| `dpKernel:"reference"` | reference | suite test + probe ✓ |

- `const wantKernel = options.dpKernel ?? "native"` (line 221) is the only default change; `"soa"` and `"reference"` explicit semantics are byte-identical to base (only the LHS of the conditions changed from `options.dpKernel` to `wantKernel`; budget gates, branch order, and the else-fallback are untouched).
- Bounded-mode precedence: the bounded branch (line 189) sits **before** dispatch and takes precedence over all kernels — unchanged, probe-confirmed.
- The native-null → soa fallback preserves the under-budget invariant: `solveDpNative` returns null for absent dylib *and* over-budget inputs, but the outer `expectedDpBytes(...) <= resolvedDpBudget` gate already held in that branch, so the soa call inside the fallback can never see an over-budget input through this path (belt-and-braces rc −1 mirror inside the kernel noted in `native.ts` docs).

## B. `dpKernelUsed` stamping — VERIFIED

- Exactly four stats sites: three early returns (`:95` infeasible, `:118` LP-integral, `:204` bounded) stamp `"none"`; the main return (`:249`) stamps the variable set by the branch that actually ran.
- Honesty of the interesting case: default + absent dylib reports **`"soa"`**, not `"native"` — the field reports what served the answer. Probe-confirmed.
- `types.ts`: `readonly dpKernelUsed?: "native" | "soa" | "reference" | "none"` — optional, purely additive; `tsc --noEmit` clean in both trees, so no consumer breaks structurally.
- Doc comment on the field accurately enumerates the four values and their meanings.

## C. Behavior-flip blast radius — ZERO in-repo (verified by search, not assumption)

- The **only** production caller of the vendor `solve` is `src/solver.ts:712`: `solveMckp({groups, capacity}, { reliefMode: "bounded" })` — passes no `dpKernel`, never reads `res.stats` (grep: zero `stats` references in `src/`). The flip is invisible to it except wall-clock time (an improvement).
- Searched all of `src/`, `test/`, `bench/` for `dpCellsVisited` / `dpKernelUsed` / stats pins: the only assertion is `test/…` none; vendor `solver.test.ts:347` pins `dpRequired === false` (early-return path, unaffected). **No test or bench pins exact `dpCellsVisited` values or kernel identity on the default path.** `bench/relief-dp.ts` only requires `dpCellsVisited > 0` for DP-engagement instrumentation — holds on native (`countCells` pre-pass stamps it; probe: 3,486,686 cells > 0).
- Cross-kernel stats comparability is by design: `countCells` in `native.ts` reproduces the SoA counter, and the 500-problem differential asserts `cellsVisited` equality (soa vs native). My probe additionally showed default (native) and reference reporting the *same* `dpCellsVisited` (3,470,222) on the same problem. So even numeric stats don't shift for the flip; the only observable deltas are `dpKernelUsed` itself and timing.

## D. Test honesty and discrimination — VERIFIED

The 5 appended tests (`vendor/knapsack/test/native.test.ts:170–249`), with a fresh generator (`mulberry32`, quadratic-profit curve — independent of the pre-existing xorshift generator):

1. **default prefers native when present, soa otherwise** — on this dylib host asserts `"native"` (fails if the default had stayed `"reference"`); on CI x86_64 asserts `"soa"` (fails if the fallback were removed). Genuinely host-agnostic via `nativeAvailable()`. CI green on head is direct evidence the CI branch of this test runs and passes with no dylib.
2. **forced-absent fallback identity** — forces absence on a dylib host (the only host where the fallback is *not* the ambient condition), asserts `dpKernelUsed === "soa"` **and** value/choices identity vs explicit reference. Discriminates: if the null-fallback were rerouted to `solveDp`, the stamp would read `"reference"` → fail; if soa diverged → fail. Env mutation is properly bracketed (set + `_resetNativeCache()`, `finally` restores and resets).
3. **explicit reference opt-out** — asserts `"reference"`; guards the opt-out contract this PR promises unchanged.
4. **LP-integral → `"none"`** — guards the early-return stamping (complements the three `"none"` sites; infeasible/bounded `"none"` are covered by probe + existing suites).
5. **40-problem default-vs-reference sweep** — value + choices identity across seeds 100–139, host-agnostic (native vs reference here, soa vs reference on CI). Any value/selection divergence fails the suite on **both** host classes.

Nano-nits (non-blocking): (a) the sweep doesn't assert `dpRequired` per seed, so an LP-integral seed would compare early-return vs early-return — coverage dilution, not a hole (test 1 asserts the generator yields DP-required problems, and identity still holds trivially on such seeds); (b) test 2 replaces `process.env` wholesale (`process.env = {...process.env, …}`) rather than property-assign like the pre-existing fallback tests — works under bun:test's serial execution and restores correctly (verified: my probe and the remainder of the suite re-resolve native after it), just a different idiom.

## E. Gates — ALL GREEN (re-run this session, this host, at `a04743e`)

- `bun test` (vendor/knapsack): **641 pass / 0 fail**, 6,331 expects, 3 files.
- `bun test` (stowage root): **671 pass / 0 fail**, 9,267 expects, 11 files.
- `bun x --bun tsc --noEmit`: exit 0 in **both** trees.
- CI on head `a04743e`: `test` job SUCCESS — x86_64 linux, no dylib, so the soa-fallback branch of every new test is exercised and asserted green in CI, not just locally.

## F. Hygiene — CLEAN

- `git diff --name-status 0affcc9..a04743e`: exactly the six listed files; no stray artifacts; `.gitignore` unchanged and still covering `node_modules/` and `native/target/`.
- Version: vendor `0.1.1 → 0.2.0` — appropriate minor bump (additive optional field; default flip with identical outputs + documented opt-out). Root `package.json` stays `0.1.0` — fine: the dep is `file:vendor/knapsack` with no version pin, and `bun.lock` carries no version for the file: dep, so nothing to sync.
- `node_modules/@connectotron/knapsack` (gitignored copy): **src is current** (contains `wantKernel` and `dpKernelUsed` — so the stowage suite exercised PR5 dispatch through the copy as well); only its `package.json` version metadata is stale at 0.1.1. No functional impact; a `bun install` would sync it. Noted for completeness, not a PR defect.
- `native/prebuilt/PROVENANCE.md` present (PR4 requirement), dylib + provenance timestamps consistent with the branch.

## G. Docs accuracy — VERIFIED against measurements (one stale intro sentence, see Minor 3)

- **stowage README** default-policy paragraph matches the code exactly: native-first, soa fallback on absent/unloadable, `dpKernel:"reference"` opt-out, `stats.dpKernelUsed` reporting, enumeration `"native" | "soa" | "reference" | "none"`.
- **End-to-end 3.1x claim (300 groups, cap 30k: 5.6 ms vs 17.2 ms):** re-measured with a fresh DP-required generator at that shape (300 groups, cap 30k, 30 reps): **default 4.88 ms vs reference 13.94 ms = 2.9x, `kernelUsed=native`** — same ballpark, direction and magnitude confirmed on independent code.
- **Kernel-level 4.2x @ 30k / 6.9x wall:** trace to committed `docs/spikes/003-simd/README.md` (3.2 ms vs 9.2 ms TS = 4.2x; 585 ms vs 2.4 s D&C = 6.9x). Numbers transcribed faithfully.
- **"differential-proven, 500 problems, ran>0 guard"**: matches the first test in `native.test.ts` exactly (including value/weight/choices/**cellsVisited** equality and the `ran > 0` guard that keeps the test honest on no-dylib hosts).
- **"CI (x86_64 linux, no dylib) exercises the fallback path visibly"**: true and stronger than "visibly" — the new policy tests *assert* the soa branch in CI, and CI is green on head.
- **vendor README**: stats line + new "Native kernel" section accurate (prebuilt triple list matches `native.ts` `triple()`; `KNAPSACK_NATIVE_DYLIB` override documented; `dpKernel:"soa"` pin documented; provenance pointer correct).

## Minor (non-blocking, recommend a small follow-up)

1. **Stale `SolveOptions.dpKernel` doc comment** — `solve.ts:26–27` still reads `'"reference" (default) or "soa"'`. After this PR that is wrong twice over: the default is native-first, and `"native"` is missing from the prose enumeration (the type includes it). This is the doc a caller reading the option will trust; the PR updated the adjacent dispatch comments but not this one (it predates the PR — present verbatim in `0affcc9` — which is exactly why it slipped through).
2. **Stale perf-item comment** — `solve.ts:177–179`: "the reference path (incl. divide-and-conquer above the budget) remains the default and the fallback." First half is now false. Also `:208–213` ("native SIMD when requested…") describes the opt-in era immediately before the corrected PR5 comment block — harmless but mildly confusing back-to-back.
3. **Stale Performance-section intro** — stowage `README.md:52–56`: "the perf work attacks only the over-budget regime" was written for PR3 (bounded mode); PR4/#5 attack the *under*-budget kernel. The sentence "Nothing below changes an answer a user of the default options could observe" remains true (outputs differential-identical — that's the PR's core claim), but "only the over-budget regime" is outdated framing.

All three are documentation-only, predate or orbit the diff, and none misstate behavior in a way that could produce a wrong call — the canonical user-facing docs (both README sections this PR wrote) are accurate.

## What was verified and found correct (summary)

- Every dispatch route live-probed on a dylib host, including forced-absent fallback, above-budget routing for all three kernels, and bounded-mode precedence.
- `dpKernelUsed` stamped at all four sites; fallback honestly reports `"soa"`; early returns report `"none"`.
- Zero in-repo blast radius: sole production caller passes no `dpKernel` and reads no stats; no test/bench pins default-path `dpCellsVisited` or kernel identity; cross-kernel stats comparability holds by construction (`countCells` mirrors the SoA counter; differential asserts it).
- The 5 new tests discriminate on both host classes; CI green on head is affirmative evidence for the no-dylib branch.
- Gates re-run: 641/641, 671/671, tsc clean ×2. Diff hygiene clean; version bump coherent; no lockfile sync needed.
- README performance claims traced to committed spike measurements and independently reproduced at claimed scale (2.9x fresh probe vs 3.1x claimed).

## Verdict: **APPROVE**

Merge as-is; fold the three doc nits (two in-code comments, one README sentence) into a trivial follow-up commit on this branch or the next docs pass.
