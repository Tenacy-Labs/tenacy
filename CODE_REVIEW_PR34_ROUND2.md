# Round-2 Verification — PR #34 fix commit (4f5513d..1fb9bd4)

- **Scope:** one fix commit `1fb9bd4` ("fix: PR34 gate — gateRunner fails CLOSED on NaN/Infinity..."), +92/−6 across 3 files: `src/optimizer/exec-lens.ts` (clamp), `test/exec-gate.test.ts` (2 hunks: clamp test + mint-test rewrite), `CODE_REVIEW_PR34.md` (round-1 report, new file).
- **Round-1 MAJOR under test:** `Math.max(0, Math.floor(NaN))` = NaN; `NaN <= 0` is false → `gateRunner(runner, NaN)` authorized **every** call forever (fail-open).
- **Method:** live probes against the real module (spy runner + real `shellRunner` + filesystem marker), self-run revert-probe of the clamp, two mutation-probes of the mint-test pins, full gates. Probes in `/tmp`; repo tree left clean at `1fb9bd4` (verified `git diff --exit-code` after every restore).

## 1. Fail-closed fix — ✅ VERIFIED (probe, not just test)

New code (exec-lens.ts:39-43): `const n = Number.isFinite(uses) ? Math.max(0, Math.floor(uses)) : 0;` with `n` used for **both** `remaining` and `grant.uses` (single source — no divergence between reported grant and enforced budget).

Live probe (`/tmp/pr34_r2_probe.ts`), spy runner that records every would-be spawn:

| input | grant.uses | remaining | runner exit | out | authorized runner invoked |
|---|---|---|---|---|---|
| `NaN` | 0 | 0 | **126** | `⟨exec denied…⟩` | **0 times** |
| `+Infinity` | 0 | 0 | **126** | `⟨exec denied…⟩` | **0 times** |
| `-Infinity` | 0 | 0 | **126** | `⟨exec denied…⟩` | **0 times** |

Re-probed against the real `shellRunner` with a `touch` marker: all three exit 126, **marker never created**. Positive control: `gateRunner(spy, 1)` spawns exactly once (`exit 0`), then `remaining()=0` — the fix did not over-tighten finite grants.

## 2. Expanded clamp test + revert-probe — ✅ VERIFIED

Test now pins all four dimensions: `grant.uses` for NaN **and** +Infinity (`toBe(0)`), **and** live runner denial for both (`runner("x",1000).exit === 126`). Note: it does not pin `-Infinity` at test level — covered by implementation symmetry (`Number.isFinite` rejects both infinities identically; probed live above) and by the `clampTimeout` precedent. Acceptable; not a defect.

**Revert-probe (self-run):** restored `let remaining = Math.max(0, Math.floor(uses)); const grant = Object.freeze({ uses: Math.max(0, Math.floor(uses)) })` → `bun test test/exec-gate.test.ts`:

```
49 |     expect(gateRunner(shellRunner, Number.NaN).grant.uses).toBe(0);
Expected: 0
Received: NaN
(fail) gateRunner > fractional/negative/non-finite uses clamp honestly (fail closed)
6 pass, 1 fail
```

The test **fails under revert** at the first non-finite pin — it is regression-tight. Fix restored; `git diff --exit-code` confirms byte-identical to `1fb9bd4`.

## 3. Mint-test rewrite — ✅ REAL PINS, MUTATION-SENSITIVE

New pins vs round-1's `typeof` no-op:

- **Pin A:** `Object.keys(intentTools()).some(n => toolNameToOp(n) === "exec.run")` must be `false`. Live check: 36 tools advertised; `exec.run` absent while `exec.list`/`exec.release` are present — so the `.some()` sweep is doing real work over a set that genuinely contains exec-adjacent ops.
  - **Mutation-probe A:** `coordinatorOnly: true → false` on `exec.run` in tools.ts → the mint test fails exactly: `Expected: false / (fail) model channel E2E (the attack path) > no intent shape can mint a grant` (6 pass, 1 fail). Pin catches advertisement leaks.
- **Pin B:** un-granted `loop.exec.run("x", 1).run.exit === 126`. Backed by `loop.ts:605` default `execRunner: ExecRunner = denyRunner`.
  - **Mutation-probe B:** default flipped to `shellRunner` → 4 pass / **3 fail** (denial pins + E2E t1/t3 catch it). Pin catches default-runner swaps.
- The E2E attack-path test (t1 deny → t2 grant executes exactly once → t3 deny, marker written exactly once) is unchanged and still passes.

The residual `typeof loop.grantExec === "function"` line is now decorative, not load-bearing — the two real pins carry the invariant. No test-honesty issue remains.

## 4. Fix-diff defect scan — ✅ CLEAN

Scope exactly as declared: 3 files, nothing else touched in the commit.

- exec-lens.ts: single behavioral change (the clamp); comment accurate; no control-flow, runner, or denyRunner changes; `uses = 1` default intact.
- Test hunks: one import added (`intentTools, toolNameToOp`) — used, typed correctly; no assertion weakened or removed (round-1's `2.9→2`, `-5→0`, E2E matrix all retained).
- Report file: docs only.

No new MAJOR/MINOR findings.

## 5. Gates — ✅

| Gate | Result |
|---|---|
| `bun x --bun tsc --noEmit` | exit 0, no errors |
| `bun test` | **1003 pass / 0 fail** (10069 expects, 48 files, 24.64s) |

## Verdict

# ✅ APPROVE

The round-1 MAJOR (fail-open on NaN/±Infinity) is fixed at the single choke point, verified by direct probe (deny + zero spawns, all three non-finite values, real shellRunner + filesystem evidence), the regression test fails under revert (self-probed), the mint-test now pins real invariants and both pins are mutation-sensitive, the fix diff introduces no new defects, and both gates are green (tsc 0 errors; 1003/0).
