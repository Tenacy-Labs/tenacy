# Adversarial Gate Review — PR #34 (exec gating wrapper)

- **Branch:** `feat/exec-gate` (4f5513d) vs `origin/main` — diff: +204/−2 across 4 files
- **Method:** targeted reads + live probes against the real `AgentLoop`/`gateRunner` (NaN/Infinity math, double grant, cold grant, re-arm via reused gate object, live-collection runner mutation, revoke, id/lens/store/ns invariants; REPL arg matrix; 2 revert-probes). Probes in /tmp; repo working tree left clean (only this file untracked).
- **Doctrine:** owner ruling 2026-08-26 — model channel can *spend* a grant, never *mint* one; deny-by-default; a forgotten window cannot outlive its task.

## Gates

| Gate | Result |
|---|---|
| `bun x --bun tsc --noEmit` | ✅ exit 0, no errors |
| `bun test` | ✅ **1003 pass / 0 fail** (10064 expects, 48 files) |

## 1. Capability escape (model → mint/extend) — ✅ CLOSED

- **Intent union** (`intents.ts:51-53`): exec surface is `{exec.run, exec.list, exec.release}` — run/list/release only. No grant, no mint, no runner, no `uses` field anywhere in `SteeringIntent`.
- **Tool advertisement** (`tools.ts:71,88`): `exec.run` is `coordinatorOnly: true` and `intentTools()` skips it. Verified live: `exec_run in intentTools()` → **false** (36 tools advertised, exec.run absent). `exec.list`/`exec.release` are advertised but are read/prune-only.
- **Op smuggling** (`tools.ts:106-108`): tool input's `op` key is stripped before intent construction — a model cannot redirect a call to exec ops via input.
- **grantExec reachability**: grep across `src/` — `grantExec`/`gateRunner` appear only in `exec-lens.ts`, `loop.ts` (definition), and `repl.ts` (the operator `/exec` handler behind `command()`). No intent path, no rlm child (`rlm.ts:167` builds a fresh `AgentLoop` with default `execRunner = denyRunner`), no session path.
- **Re-arm via reused grant object**: probed — `grantExec(g)` re-invoked with the SAME spent gate (`remaining()=0`): next run exits **126** (P4). Budget lives in the runner closure; re-installation cannot re-arm it. ✅
- **Re-arm via session restore** (`sessions.ts:228`): restore calls only `restoreExecRun` (history replay, never reruns, never touches `execRunner`). Grant state (closure) is deliberately not serialized — resume starts closed. ✅
- **Re-arm via provider swap** (`loop.ts:472`): `swapProvider` sets provider+ParamSet only. Runner untouched — an open grant intentionally survives a provider swap (operator-minted against the loop, not the model). Consistent with doctrine.
- Note: the model channel *can* spend — `executeIntent` `case "exec.run"` (intents.ts:353) runs model-proposed commands **through the installed gate**. With no grant: exit 126. That is the designed spend path; E2E test pins it.

## 2. Swap correctness (grantExec seams) — ✅ ALL HOLD

Probed against the real `AgentLoop` (probe P2–P6):

| Seam | Probe result | Expected |
|---|---|---|
| Double `grantExec` | ids `[1,2,3]` monotonic; lens keys `exec#1..3` no dupes; store rows no dupes; ns producer re-registered (Map.set overwrite = exactly one factory) | ✅ |
| Grant before any exec exists (cold) | first run id=1, executes, runs=1 | ✅ |
| Grant during in-flight turn | REPL input pump is strictly serial (`repl.ts:174-186`: one `await command(line)`/turn at a time); `grantExec` is sync — no interleaving window exists in-process | ✅ by construction |
| Live-collection runner mutation (P5) | `loop.execRunner = escape` after collection exists: both captured collection and getter deny (exit 126) — collection captures the runner at construction; grantExec's null-then-rebuild is the only swap path | ✅ |
| Revoke (`/exec 0`) | exit 126, history preserved (2 runs) | ✅ |
| nextId across swaps | `#pendingExecRestores` → `restoreRun` sets `nextId = max(nextId, run.id+1)` (exec-lens.ts:200) | ✅ |
| Store dupes across swap | remove-then-restore (`store.remove` before each `restoreRun`) — no duplicate ids | ✅ |

## 3. Gate math — 🔴 ONE REAL HOLE (blocker), otherwise sound

- **`gateRunner(authorized, NaN)` never closes.** `exec-lens.ts:36`: `Math.max(0, Math.floor(NaN))` = `NaN`; `NaN <= 0` is **false**, so every call decrements NaN→NaN and **authorizes**. Probed live: 100 consecutive calls, all exit 0, `remaining()` = NaN, `grant.uses` = NaN. Also `NaN` poisons the honest-budget invariant: `grant.uses` (the only inspectable field) reads as NaN, yet the gate is fully open — the *display* says broken, the *enforcement* says unlimited. **`Infinity` is the same class**: `floor(Infinity)=Infinity`, never closes (probed: 5/5 authorized). The contract on the interface says "N uses then reverts to deny" — NaN/Infinity violate it in the worst direction (fail-open).
  - Reachability today: the only mint surface (`/exec`) filters this — `Number.isFinite(Number("nan"))`/`1e400` → `false` → usage message (verified across a 15-case arg matrix). So **no live exploit path**. But `gateRunner` is the exported mint API; the next trusted boundary (TUI, remote ops surface) that passes an un-sanitized N inherits a fail-open gate. Doctrine is fail-closed; this must clamp, one line:
    `let remaining = Number.isFinite(uses) ? Math.max(0, Math.floor(uses)) : 0;` (same for `grant.uses`).
  - The test suite's "fractional/negative uses clamp honestly" covers 2.9 and −5 but misses NaN/Infinity — the clamp test asserts the exact invariant the implementation fails.
- Race between `remaining()` read and call: single-threaded JS, sync runner, no awaits between check and decrement — no TOCTOU.
- External mutation of closure state: `remaining` is a closed-over `let` reachable only through `runner`/`remaining()`; `Object.freeze(grant)` prevents `grant.uses` spoofing (and `grant.uses` is display-only anyway — `grantExec` ignores it, the closure enforces). Sound design; the `void gate.grant` comment at loop.ts:636 is honest.

## 4. REPL surface — ✅ acceptable (two cosmetic notes)

Arg matrix (all 15 cases exercised):
- `/exec` → status (remaining/total or DENIED). `/exec 0` → revoke (installs `gateRunner(denyRunner, 0)`, clears REPL vars). ✅
- `-3` → clamps to 0 → **revoke** (reasonable: negative = close). `2.9` → 2. `abc`/`nan`/`1_0`/`1e400`/`Infinity` → usage error (finite check). `0x10` → 16, `2e2` → 200, `+7` → 7 (Number() semantics — acceptable operator shorthand). ✅
- **`/exec 999999999` → grants 999,999,999 uses** — an effectively unbounded window. This is operator-only and explicit (the operator typed it), so it is *acceptable operator behavior* under the ruling; the defense is that the model can never extend it. Note-only: a soft cap or confirmation for N > ~1000 would better honor "a forgotten window cannot outlive its task," but not blocking.
- **REPL var drift**: `execGate`/`execGrantTotal` are module state; nothing else mutates the loop's runner (`swapProvider` doesn't touch it, `/resume` doesn't touch it), so no drift path exists. Cosmetic: after a grant is *spent*, `/exec` reports "DENIED (no open grant)" while `execGrantTotal` still holds the stale total — harmless display nit (the message text is right, the dead total just lingers).

## 5. Test honesty — ✅ HONEST (verified by revert-probe)

- The 7 tests: 5 are direct-API (gateRunner math ×3, grantExec swap ×2), 1 is genuine E2E through the **model-intent path** (`ScriptedProvider` emitting `{op:"exec.run"}` intents → `loop.run()` → `executeIntent` → gate → real `touch` marker file asserted on disk across denied/granted/spent states), 1 is a weak grep-level "no mint" test (asserts `typeof loop.grantExec === "function"` — it pins nothing about the intent channel; my section-1 greps + live `intentTools()` check cover what it should have).
- **Revert-probe A** (`remaining--` removed — gate never spends): **2 fail** (budgets-uses test AND the ScriptedProvider E2E). ✅
- **Revert-probe B** (`grantExec` early-return no-op): **3 fail** (both grantExec tests AND the E2E). ✅
- Both probes reverted; working tree clean; `bun test test/exec-gate.test.ts` → 7/7 pass again, full suite re-verified 1003/0 before and after probes.

## Verdict: REQUEST_CHANGES

One blocker, everything else approve-grade:

| # | Severity | Location | Finding | Fix |
|---|---|---|---|---|
| 1 | 🔴 MAJOR (latent — fail-open API contract) | `src/optimizer/exec-lens.ts:36-37` | `gateRunner(_, NaN or Infinity)` never closes: `Math.max(0, Math.floor(NaN))` = NaN, `NaN <= 0` false → unlimited authorization with `grant.uses` reporting NaN. Unreachable via today's `/exec` (finite-check), but the exported mint API violates its own "N uses then reverts to deny" contract fail-open. | Clamp non-finite to 0 (fail-closed) in both `remaining` and `grant.uses`; add NaN/Infinity cases to the clamp test |
| 2 | 🟡 minor | `test/exec-gate.test.ts:113-118` | "no intent shape can mint a grant" pins nothing (typeof check) | Assert `!("exec_run" in intentTools())` / that no SteeringIntent op reaches grantExec |
| 3 | 🟢 note | `src/ui/repl.ts:283` | `/exec 999999999` = effectively unbounded window (operator-only, acceptable) | Optional soft cap/confirm for large N |
| 4 | 🟢 note | `src/ui/repl.ts:276` | `execGrantTotal` stale after spend; status line reads "no open grant" | Reset total when `remaining()===0` |

The blocker is a one-line fail-closed clamp plus two test cases. Swap correctness, capability confinement, test honesty, and both gates (tsc 0 / 1003-0) are clean — after the NaN clamp lands, this is an APPROVE.
