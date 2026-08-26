# CODE_REVIEW_PR29.md — PR #29 convo array interface (ADR-0002f amendment)

- Branch: feat/convo-array-interface @ 5413e92 → fixes at later tip
- Reviewer: fresh-context dispatch deleg_f5cc56a3 (2026-08-25)
- Gates at review time: tsc 0, 947/947 (CI run 32846561086)

## VERDICT: REQUEST CHANGES → resolved 2026-08-25 (0 critical / 3 major / 8 minor)

### Findings and resolutions

**M1 — hollow save/restore test (honesty).** Test 2 used `void agent.run("q1")`
(un-awaited, un-steered) — no tool row existed to round-trip; the test passed
with the feature reverted. **FIXED**: rewritten as steer → `await run` → save →
restore, asserting `chain[0].id === "turn-2-tool-0"`. Revert-probed: 3/3 tests
fail on the reverted tree (5413e92 reverted, fixed tests copied in).

**M2 — chain-parse fallback lied safe.** Unparseable tool-row verbatim
rendered `{ok: true}` — an error receipt could masquerade as success.
**FIXED**: non-match now yields `{op: "(raw)", ok: false}` (conservative
fail); discriminating test added (forged unparseable row asserts ok:false).

**M3 — merge valueMass sums tool rows at full conversational mass.**
Pricing shift for tool-heavy merged history; failures double-recorded
(err: notices + tool rows). **DEFERRED to owner ruling** — ADR amendment
noted; not a correctness defect (math is self-consistent per m7-style audit).

### Minors (all non-blocking, recorded)
m1 no double-render (solver pricing of independent rows is the design);
m2 mint-order asymmetry (steering priced same turn, model intents next) inherent;
m3 `convoTurnIds?.()` optional-chain benign; m4 dream SUMMARY on tool rows intended
(summaries may exceed short receipts — cosmetic); m5 REPL /convo output sane;
m6 save/restore fidelity verified (roleFromId fall-through + stripRolePrefix);
m7 no id collision (per-turn reset, continuous counter across both mint sites);
m8 ADR TOC consistent.

### Re-verification after fixes (parent, 2026-08-25)
- `bun x --bun tsc --noEmit` → 0
- `bun test` → 948/948 (947 + 1 new M2 test; M1 rewrite same count)
- Revert-probe (throwaway worktree /tmp/ak-pr29-probe, reverted 5413e92,
  fixed tests copied in): **3 fail / 0 pass** — honest discrimination.

## Blockers during review (environmental, resolved)
Host fd-exhaustion (Errno 24) killed the reviewer's terminal/execute_code/
read_file/write_file channels mid-run (the known gateway SQLite-handle leak,
upstream #88033 family); report file could not be written by the reviewer —
transcribed by the parent from its inline final message. Gateway since
updated to v0.20.5 and restarted (fd count 300 → 84).
