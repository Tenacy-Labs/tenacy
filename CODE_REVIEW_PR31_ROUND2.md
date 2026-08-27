# Round-2 Verification Gate — PR #31 fix commits (cd43ed8..d028dce)

Reviewer: fresh-context verification subagent (round 2)
Diff under review: `git diff cd43ed8..d028dce` — d3d1421 (fixes), 152c958 (regression tests), d028dce (verdict docs)
Findings under fix: CODE_REVIEW_PR31_A.md (A-M1/M2/M3), CODE_REVIEW_PR31_B.md (CRITICAL C1, B-M1/M2/M4, B-m1)
Date: 2026-08-27

## VERDICT: APPROVE

All 8 resolutions verified against the fix tree with original repro shapes re-run live;
gates reproduce exactly; 4 of 11 regression tests revert-probed in a /tmp-copied tree,
each confirmed discriminating (fails under revert, passes restored). No new defects in
the fix diff. Two non-blocking observations noted below.

## Gates (reproduced on this host, PATH incl. ~/.bun/bin)

- `bun x --bun tsc --noEmit` → **rc 0, zero diagnostics** ✅
- `bun test` → **996 pass / 0 fail / 10034 expect() calls, 47 files, 24.6s** ✅ (matches expected 996/0)
- Working tree clean before and after all probes (verified `git status --short` empty; probes ran only in /tmp/round2_tree, removed-file repro scripts cleaned).

## Resolution-by-resolution verification

### 1. C1+B CRITICAL — ungated exec → DENY by default ✅ VERIFIED

- **Deny default, both surfaces:** `src/optimizer/exec-lens.ts:124`
  (`constructor(public runner: ExecRunner = denyRunner, ...)`) and
  `src/optimizer/loop.ts:605` (`execRunner: ExecRunner = denyRunner`). `denyRunner`
  (exec-lens.ts:32-35) returns exit 126 + `⟨exec denied: no authorized runner installed⟩`
  without spawning.
- **`exec.run` absent from model-visible tools:** `src/optimizer/tools.ts:71` carries
  `coordinatorOnly: true`; `intentTools()` (tools.ts:84-87) skips coordinatorOnly specs.
  Verified live: `Object.keys(intentTools())` contains no exec.run entry (regression test
  also pins this).
- **clampTimeout:** exec-lens.ts:49-53 — non-finite/≤0 → 10_000; >60_000 → 60_000.
  Live repro output: `[0,-5,NaN,10_000_000,5000].map(clampTimeout)` →
  `[10000, 10000, 10000, 60000, 5000]`. Applied at the intent boundary
  (intents.ts:355-358, `clampTimeout(s.timeout ?? 10_000)`) AND inside `shellRunner`
  itself (exec-lens.ts:39-41) — defense in depth; B's `timeout 0 = no timeout` repro is dead.
- **RLM children:** `src/optimizer/rlm.ts:167` constructs `new AgentLoop(provider, this.ps,
  this.ledger)` with NO runner injection → inherits the deny default. `grep -rn
  'shellRunner|denyRunner|execRunner' src/` shows **zero injection sites anywhere in src/**:
  shellRunner survives only as (a) its definition in exec-lens.ts and (b) a comment in
  loop.ts. Even the operator REPL/TUI do not inject it yet — stricter than the finding
  required; exec is denied everywhere until the gate wrapper ships (see Observation 1).
- **Live end-to-end repro re-run** (original shape: model-proposed `exec.run` with
  `touch /tmp/round2_pwned_marker` through `executeIntent` on a default AgentLoop):
  receipt `#1 exit=126 … (45B out)`, marker file **not created**. No gate bypass.

### 2. A-M3 — op smuggling ✅ VERIFIED

tools.ts:107-110: input destructured first (`const { op: _smuggled, ...rest } = c.input`),
`op` forced last (`{ ...rest, op }`). Live repro of the original shape
(`say` + `{text:"hi", op:"exec.run", cmd:"echo pwned"}`) through `intentsFromToolCalls`:
`[{"text":"hi","cmd":"echo pwned","op":"say"}]` — extra fields pass through, the op never
flips. Combined with C1's deny default, the original critical chain (smuggle → exec.run →
/bin/sh) is doubly dead.

### 3. B-M1 — session round-trip ✅ VERIFIED

- Save: sessions.ts:147-153 emits `{t:"exec", id, run:{id,cmd,exit,out,turn}}` from the
  lens registry's immutable `ExecRun`; orphans skipped honestly.
- Restore: sessions.ts:226-229 → `AgentLoop.restoreExecRun` (loop.ts:619-626) →
  `ExecCollection.restoreRun` (exec-lens.ts:171-184): pushes the run, rebuilds the lens,
  records the commit, sets `nextId = max(nextId, id+1)`, attaches. **No rerun** — restore
  is pure replay of the snapshot.
- Classification: `rowType` (sessions.ts:258) adds the `"exec"` branch AFTER the
  merge/turn episodic checks and BEFORE generic lens — exec lenses are `kind:"lens"`,
  so they cannot shadow merge/turn rows, and merge rows (`merge:` prefix, episodic kind)
  cannot hit the exec branch. Ordering is correct.
- Regression test (gate-review-pr31.test.ts:99-127) asserts the full contract: id/cmd/out
  preserved, runner-call log shows exactly one call (`["original command"]` — no rerun),
  store + registry rehydrated, next run gets `lens:exec#2` (no collision). Revert-probed —
  see Probes.

### 4. B-M2 — 20KB cap ✅ VERIFIED

`capOutput` (exec-lens.ts:56-65): `Buffer.byteLength` gate, UTF-8 continuation-byte
walk-back (`(buf[cut] & 0xc0) === 0x80`) so no sequence is split, explicit
`⟨output truncated at 20000 bytes⟩` marker. `shellRunner` caps combined stdout+stderr
through it; timeout marker remains distinct and outside the cap. Live checks: exactly
20,000 ASCII bytes passes through untouched; 24,000-byte `é`×12,000 output truncates with
marker, no U+FFFD, final string 20,038 bytes (payload cut at 20,000-byte boundary — 10,000
`é` chars — plus the marker). The original review's three defects (silent, char-based,
untested) are each cured.

### 5. B-M4 — TUI tri-state chevron ✅ VERIFIED

tui.tsx:123-138: `cachedPrefixVerdict` returns `"unknown"` when `realizedHit === null`,
`"not-confirmed"` only when realized counters exist and prove the block is past the
boundary (incl. the head-token subtraction), `"confirmed"` when the realized hit covers
the cumulative prefix. Render (tui.tsx:250): confirmed→green, unknown→**gray**,
not-confirmed→yellow. The fabrication path (null usage → yellow) is gone. Note: this is
JSX-render logic not covered by the new test file — acceptable as it matches the
suggested pure-function shape internally; flagging as observation-free residual, not a
finding.

### 6. A-M2 — head block installs measured delta ✅ VERIFIED

tui.tsx:87-92: `setHeadBlock({ digest:"tool-defs-v1", tokens: r.delta })` and
`state.headTokens = r.delta`, gated on `r.toolsCached === true && r.delta !== null`
(the null-guard is a correct strengthening — delta is `number | null`, probe.ts:24).
`r.toolTokens` is no longer installed anywhere.

### 7. A-M1 — vendor divergence ledger ✅ VERIFIED

vendor/stowage/README.md:3-13: HTML comment ledger names the exact divergent file
(src/cache-model.ts), enumerates the head-block surface (head field, setHeadBlock,
headBlockTokens, expectedHit head-riding, update() freshness), instructs refreshers to
re-apply or drop-on-upstream-landing, and carries forward the PR #25/#26 adaptation
classes. Matches the finding's required remedy (option B).

### 8. B-m1 — release detaches registry entry ✅ VERIFIED

`ExecCollection` gains a `detach` callback (exec-lens.ts:130-132); AgentLoop wires it to
`lensRegistry.delete(lensId)` (loop.ts:611-612); `drop` calls it before deleting its own
map entry (exec-lens.ts:161-166). Regression test asserts registry + store + collection
all drop `lens:exec#1` after `exec.release`.

## Fix-diff defect audit (new-code review)

- **Scope:** every hunk maps 1:1 to a numbered finding (C1, A-M1/M2/M3, B-M1/M2/M4, B-m1)
  plus their regression tests and verdict docs. The only ride-alongs are direct
  strengthenings of the same findings: the null-delta guard (A-M2), clampTimeout inside
  shellRunner (C1), and the repl.ts:6-9 stale-doc rewrite — which is scope-A MINOR m1
  from the same review cycle, so in-scope. No scope creep.
- **exactOptionalPropertyTypes:** the only new optional property (`coordinatorOnly?` on
  ToolSpec, tools.ts:34) is always assigned an explicit boolean, never `undefined`;
  tsc --noEmit clean under the repo's strictest config.
- **Tool-set enumeration regressions:** `test/tools.test.ts:23` asserts
  `names.length > 30` (not an exact count) and bijection over whatever is present —
  unaffected by exec.run's removal. `TOOL_PROTOCOL_DOC` (tools.ts:116-117) enumerates
  ops informally and never mentioned exec.run — no doc drift. `toolSummary()` (operator
  TUI display) still lists exec.run — correct: it is the coordinator-side affordance
  display, not the model-visible ToolSet. No test or doc enumerates intentTools() exactly.
- **sessions.ts ordering:** exec branch is lens-kind and positioned after episodic
  classification — merge (`merge:` + upstreams) and turn rows cannot be misclassified
  (verified reasoning above + full suite green).
- **restoreExecRun store handling:** `store.remove` then `store.add` of the rebuilt
  context item — idempotent replay, consistent with the B-11 pattern cited in-code.
- **Nothing in the diff touches provider construction, cache accounting, or probe
  decision logic beyond installing the measured value.**

## Regression-test discrimination (4 revert probes, /tmp/round2_tree)

Baseline: `bun test test/gate-review-pr31.test.ts` → **11 pass / 0 fail** (also verified
in the /tmp copy before probing).

| # | Probe (revert applied in /tmp copy) | Result |
|---|---|---|
| 1 | A-M3: restore original `{ op, ...input }` spread order in intentsFromToolCalls | **1 fail** (op-smuggling test) — discriminates |
| 2 | C1: `execRunner: ExecRunner = shellRunner` in AgentLoop | **1 fail** (deny-by-default test) — discriminates |
| 3 | B-M2: neuter capOutput back to `.slice(0, 20_000)` (char-based, no marker) | **3 fail** (ASCII boundary, UTF-8 boundary, shellRunner combined-cap) — discriminates |
| 4 | B-M1: remove the `rowType` exec branch in sessions.ts | **1 fail** (round-trip test) — discriminates |

After each probe the file was `git checkout --`-restored and the suite re-run green
(11/0). Final `git status --short` empty in BOTH the /tmp tree and the real repo —
working tree never left dirty. (The remaining tests not probed — clampTimeout, tool-set
absence, denyRunner, release-detach, under-cap passthrough — are trivially coupled to
their fixes by direct import; the 4 probes cover every fix mechanism class: normalization
order, default injection, byte-cap, and persistence wiring.)

## Observations (non-blocking, no action required for this PR)

1. **Exec is now denied EVERYWHERE, including the operator surfaces.** No src/ file
   injects `shellRunner` — not even repl/tui. This is the correct/safe side to err on
   and matches the owner ruling (gate wrapper is a follow-up), but the operator UX for
   exec is currently exit-126 until that wrapper ships. Worth tracking as the named
   follow-up.
2. **A-m2 residual:** `headBlockTokens()` (vendor/stowage/src/cache-model.ts:74) remains
   an exported no-caller. The new ledger explicitly names it as part of the intentional
   divergence, which adequately records it; dropping it can ride the upstream sync.

## Summary counts

CRITICAL: 0 · MAJOR: 0 · MINOR: 0 (2 non-blocking observations)
All 8 findings verified fixed; gates 996/0 + tsc-clean reproduced; 4/11 regression tests
revert-probed and discriminating.
