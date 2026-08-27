# Adversarial Gate Review — PR #31, Scope B (exec lens + TUI surface)

**VERDICT: NOT_MERGE_READY**

Reviewer: fresh-context adversarial subagent (scope B)  
Diff: `git diff origin/main...origin/feat/native-tool-calls`  
Date: 2026-08-27

## Gates reproduced

- PASS — `bun x --bun tsc --noEmit`: 0 errors.
- PASS — `bun test`: **985 pass / 0 fail / 10001 expect() calls**, 46 files.
- PASS — zero-coverage presence: `grep -rn exec-lens test/` finds `test/exec-lens.test.ts`.
- PASS (partial discrimination) — clean focused file: 12/12; `/tmp` revert probes:
  - replace per-run IDs with `lens:exec#ALL` → **3 failures**;
  - remove timeout→124/marker behavior → **1 failure**;
  - break `nsProducer.children` → **2 failures**;
  - remove the 20KB cap entirely → **0 failures** (12/12 still pass), confirming the cap is untested.
- Report remains untracked.

## Findings

### CRITICAL — model-proposed `exec.run` is armed with the real shell runner before the required gate exists

**Files:** `src/optimizer/tools.ts:71`; `src/optimizer/registry.ts:54-60,100-108`; `src/optimizer/loop.ts:335-344,601-609`; `src/optimizer/intents.ts:353-359`; `src/optimizer/rlm.ts:152-168`

**Evidence / reproduction:**

- `exec.run` is in the universal native `intentTools()` set (`tools.ts:71`). Every live provider built by `buildProvider` receives that set (`registry.ts`), and tool calls are converted directly to `SteeringIntent`s.
- The model-intent loop calls `executeIntent` without an exec-specific approval/policy wrapper (`loop.ts:335-344`). `executeIntent` immediately calls `host.exec().run`, whose lazily created collection captures `execRunner = shellRunner` (`loop.ts:601-609`). The default is `/bin/sh -c`.
- `/tmp/probe31b/probe_exec.ts` passed the exact model-proposed intent shape to the same coordinator function and executed a compound shell command. Result: `true "#1 exit=0 ..."`; captured output was 17 bytes. There was no gate.
- The RLM supervisor creates child `AgentLoop`s using the same native-tools provider (`rlm.ts:152-168`). Each child gets the default `shellRunner`; no coordinator-only capability distinction or gate is installed. Thus the diff does arm exec beyond the intended gated boundary.
- `timeout` is model-controlled and unvalidated. `/tmp/probe31b/probe_to2.ts` showed `shellRunner("sleep 3", 0)` blocks for ~3155ms and exits 0: Bun treats timeout 0 as no timeout. Arbitrarily large values likewise synchronously block the event loop.

**Impact:** An untrusted model response can execute arbitrary shell syntax with the host process's privileges and environment. This violates the explicit owner ruling that `execRunner` gating is a follow-up required before exec reaches non-coordinator cells.

**Suggested fix:** Do not include `exec.run` in model-visible tools until the gating wrapper ships, or default `AgentLoop.execRunner` to a deny runner and inject an explicitly authorized runner only at the coordinator boundary. Ensure RLM/non-coordinator loops receive deny runners. Clamp/validate timeout to a positive bounded range before calling the runner. Add end-to-end tests in which a model-proposed exec intent is denied by default and only runs when the coordinator installs an explicit gate; verify fail-under-revert.

### MAJOR — exec run history does not survive session save/restore; ids restart and collide semantically

**Files:** `src/optimizer/sessions.ts:35,110-125,162-204`; `src/optimizer/loop.ts:526-556,601-611`; missing coverage in `test/exec-lens.test.ts`

**Evidence / reproduction:**

`/tmp/probe31b/probe_rt.ts` created exec run #1 with deterministic output, saved, restored into a fresh loop, listed, then ran again. Actual output:

- save contains `{"t":"lens","id":"lens:exec#1","target":"exec/#1","tag":"exec",...}`;
- restore reports one restored row but `store has lens:exec#1 after restore: false`;
- `exec.list after restore: no runs yet`;
- next run is again `#1 ... lens:exec#1`.

The generic LensRow stores no `ExecRun` fields (`cmd`, `exit`, `out`, `turn`, numeric id). `attachLens` has no `tag === "exec"` branch, falls through to `fileContent("exec/#1")`, and returns early on empty content. `ExecCollection.runs`, `lenses`, `nextId`, and commit history are never rehydrated. Restore still increments `restored`, making the loss less visible.

This directly violates the required round-trip contract: run rows must survive save/restore with IDs intact. It also violates recoverability semantics by neither restoring history nor representing it as rerunnable metadata.

**Suggested fix:** Add a versioned exec row containing the immutable `ExecRun` record and restore it through an `ExecCollection.restoreRun` method that repopulates run order, per-run `ExecRunLens`, attach/store/registry state, ns commits as appropriate, and sets `nextId = max(id)+1`. Do not rerun the command during restore. Increment `restored` only when attachment succeeds. Add an awaited session round-trip test asserting cmd/exit/out/turn/id, `exec.list`, store/lens registry membership, and next ID; verify fail-under-revert.

### MAJOR — the 20KB output cap is silent, is character-based rather than byte-based, and has no discriminating test

**Files:** `src/optimizer/exec-lens.ts:29-36`; `test/exec-lens.test.ts:138-151`

**Evidence / reproduction:**

- Runner performs `.toString().slice(0, 20_000)` and returns no `truncated` field or marker. A consumer cannot distinguish exactly-20,000-character complete output from clipped output. The design requires truncation to be marked, never silently passed as complete.
- `.slice(0, 20_000)` caps UTF-16 code units, not bytes; multibyte output can exceed 20KB. Both full stdout/stderr buffers are materialized before slicing, so this also is not a memory capture cap.
- Revert probe removed `.slice(0, 20_000)` entirely; all **12/12 exec-lens tests still passed**. Existing shell tests cover timeout and stdout/stderr only.

Timeout exit handling itself behaved as required in the focused test: timeout maps to exit 124 and the timeout marker is separate from the numeric exit field. However, partial output plus truncation is not identified honestly.

**Suggested fix:** Capture at most 20,000 bytes (including combined stdout/stderr policy), return explicit metadata such as `{ out, truncated: true }`, and render a deterministic `⟨output truncated at 20000 bytes⟩` marker. Preserve timeout as exit 124 and keep timeout metadata distinct. Add ASCII and multibyte >20KB regression tests plus exact-boundary tests; verify the tests fail when the cap/marker is reverted.

### MAJOR — ordinary TUI block chevrons fabricate a negative cache verdict before any provider confirmation

**File:** `src/ui/tui.tsx:120-140,247`

**Evidence / reproduction:**

`cachedPrefix` returns false when `state.realizedHit === null`; the JSX maps every false to yellow. Thus before the first request, when usage is unreported, or whenever realized cache counters are absent, the TUI shows yellow rather than neutral gray. The comment explicitly equates yellow with “not confirmed,” conflating unknown with a negative verdict.

The tools-entry path is better: `probeColor()` returns gray for pending/inconclusive and only yellow after `toolsCached === false`. There is no corresponding tri-state handling for regular blocks. This regresses the cache-honesty rule called out by the owner: gray/neutral default when unconfirmed; do not fabricate a cache verdict.

**Suggested fix:** Replace `cachedPrefix(): boolean` with a tri-state verdict (`"confirmed" | "not-confirmed" | "unknown"`, or equivalent). Render gray for missing realized usage, green only when the realized prefix proves coverage, and yellow only when reported counters prove the block falls beyond the hit boundary. Add pure-function/TUI tests for null usage, zero reported hit, partial hit, and full hit; verify fail-under-revert.

### MINOR — `exec.release` leaves stale entries in `lensRegistry`

**Files:** `src/optimizer/exec-lens.ts:124-130`; `src/optimizer/intents.ts:366-371`; `src/optimizer/loop.ts:605-608`

**Evidence:** `ExecCollection.drop` removes `runs` and its own numeric lens map. `executeIntent` removes the store item. Neither removes `lens:exec#N` from `AgentLoop.lensRegistry`, because the attach callback has no paired detach callback. `lensRegistryView()` can therefore expose a released lens until process end, and a future ID reuse after restore can overwrite it implicitly.

**Suggested fix:** Give the collection an injected detach callback (or host `removeExecLens`) that atomically removes collection, store, and registry state. Add a release test against a real `AgentLoop` asserting all three structures no longer contain the ID; verify fail-under-revert.

## Contract audit

- **ExecCollection owns run history/id allocation:** implemented in-memory (`runs`, `nextId`), but broken across session restore.
- **Each run its own `lens:exec#N` Lens, solver-priced independently:** implemented; revert probe discriminates IDs/object identity.
- **Own ContextItem/digest/purge path:** implemented via `ExecRunLens extends Lens` and per-run store attach; release leaves stale registry state.
- **Injectable runner, default `/bin/sh -c`, `Bun.spawnSync`, timeout→124:** implemented, but the unsafe default is exposed before gating and timeout validation is absent.
- **20KB output cap:** attempted but silent and not byte-correct; no discriminating test.
- **ns entry via `nsProducer`, no top-level mount:** implemented; revert probe discriminates child listing. Lazy registration occurs under `nsProducers`.
- **Recoverability = rerun, not reread:** immutable snapshots do not expose a reread operation, but session persistence drops the rerunnable run metadata entirely.
- **TUI cache verdict honesty:** tools entry is tri-state and neutral when unknown; regular block chevrons are not.

## Final gate decision

`NOT_MERGE_READY`: CI/type gates are green, but arbitrary model-driven shell execution is active without the mandated gate, exec persistence is data-losing, truncation is silent/untested, and the TUI fabricates a cache verdict in unknown states.
