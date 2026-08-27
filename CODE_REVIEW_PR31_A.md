# CODE REVIEW PR #31 — Scope A (native tool calling core + cache probe + virtual head block)

Reviewer: fresh-context adversarial subagent (scope A)
Branch: `origin/feat/native-tool-calls` (cd43ed8) vs `origin/main`
Repo: /Users/kipp/openclaw-robby/agent-kernel
Files: src/optimizer/{tools,probe,registry,intents,loop}.ts, live.ts (deleted), test/{tools,probe,optimizer}.test.ts, vendor/stowage/src/cache-model.ts, src/analysis/task.ts, src/ui/repl.ts, bench/corpus/{run,maxsuite}.ts

## VERDICT: REQUEST_CHANGES

Three MAJOR findings: unrecorded divergence in a vendored snapshot, the cache
belief chain fed an estimate where a measurement exists, and an op-confusion
path in tool-call normalization that reaches a default `/bin/sh -c` runner.
No CRITICALs; the core design (proposer/applier split preserved, honest
inconclusive probes, discriminating tests) is sound.

## Gates (reproduced on this host, PATH incl. ~/.bun/bin)

- `bun x --bun tsc --noEmit` → **rc 0, zero diagnostics** ✅
- `bun test` → **985 pass / 0 fail, 46 files, 10001 expect() calls** (24.5s) ✅ (matches expected 985/0)
- Revert-discrimination (vendored head block): reverted `vendor/stowage/src/cache-model.ts`
  to `origin/main` → `bun test test/optimizer.test.ts` = **48 pass / 2 fail** (both new
  head-block tests fail), restored HEAD copy (byte-diff verified clean). New tests are
  discriminating, not vacuous. ✅
- Coverage honesty: `test/probe.test.ts` (4 real tests over fake wires: warm-delta
  positive, equal-delta negative, unreported→inconclusive, leg-failure→partial) and
  `test/tools.test.ts` (4 real tests incl. end-to-end `MockLanguageModelV3` tool-call
  part → `generateText` → `providerFromWire` → structured intents; unknown tool dropped;
  null input dropped). Both modules genuinely covered — no zero-coverage greens. ✅

## Findings

### MAJOR M1 — vendored snapshot diverges from upstream, divergence unrecorded
**File:** vendor/stowage/src/cache-model.ts:63-89, 154-156 (vs /Users/kipp/openclaw-robby/stowage main)

`diff` of the vendored file against current upstream stowage main shows the entire
virtual-head feature (`head` field, `setHeadBlock`, `headBlockTokens`, expectedHit
head-riding logic, `update()` freshness advance) exists ONLY in agent-kernel's vendored
copy. Upstream has none of it (no branch, no `setHeadBlock` anywhere in stowage src/test;
`git log --grep` empty). Per the established snapshot discipline (CODE_REVIEW_PR25 §C:
exactly 2 recorded adaptation classes, both mechanical path rewrites), a behavior-bearing
feature added inside `vendor/` must be either upstream-mirrored or a RECORDED adaptation
class. It is neither: nothing in `vendor/stowage/README.md`, stowage docs/adr, or
agent-kernel docs records it. Repro: `diff stowage/src/cache-model.ts agent-kernel/vendor/stowage/src/cache-model.ts`.

Consequence: the next mechanical vendor refresh from upstream silently deletes the head
block (tests would catch it only because this PR added discriminating tests — but the
refresh procedure itself has no marker telling the refresher this file is intentionally
forked).
**Fix (either):** land the head-block feature upstream in stowage (it is genuinely a
CacheModel capability) and re-sync the snapshot; or record a third adaptation class in
the vendor provenance notes (agent-kernel side) explicitly listing this file as
intentionally divergent with a sync-time warning.

### MAJOR M2 — belief chain installs the estimate, not the probe's measurement
**Files:** src/ui/tui.tsx:78-90; src/optimizer/probe.ts:21-24, 31-33

The probe MEASURES `delta = hitWithTools − hitWithout` (true cached-token difference),
but the head block installed into `CacheModel` uses `r.toolTokens` — which is just
`opts.toolTokens`, i.e. `toolTokensEstimate(serialized.length) = ceil(chars/4)` of a
**SDK-side serialization** (`JSON.stringify` of the `ToolSet` object), not the provider's
wire rendering of tool definitions (Anthropic/OpenAI render tool JSON schemas in their
own envelope; token mass differs by a large factor). So the "probe-measured tool tokens
join the cache belief chain" claim (commit fb32f4d) is false in the number that actually
joins: it is an estimate of the wrong serialization. `calibrate()` then compares
`expectedHit` (containing this estimate) against provider-reported reality — a 2x error
in tool mass (~2100 of ~20k+ token prefixes is plausible) can flip divergence verdicts,
re-introducing exactly the spurious-fire class the change was meant to kill. Note the
probe decision itself is fine (delta ≥ max(64, est/2) is robust to estimate error); only
the installed magnitude is wrong.
**Fix:** when `r.toolsCached === true`, install `{ digest: "tool-defs-v1", tokens: r.delta }`
(measured) rather than `r.toolTokens`; keep the estimate only as the pre-probe display
value. Add a probe test asserting the caller path uses delta.

### MAJOR M3 — `intentsFromToolCalls` spread order lets tool input override `op`
**File:** src/optimizer/tools.ts:105

```ts
intents.push({ op, ...(c.input as Record<string, unknown>)} as SteeringIntent);
```

The input spread comes AFTER `op`, so any `op` key inside the tool input replaces the
tool-name-derived op. The coordinator does NOT validate tool input against the declared
schema (`additionalProperties: false` is a request to the provider, not enforced here;
enforcement varies by provider — strict on Anthropic server-side, commonly lax on
openai-compatible endpoints). Reproduced live (/tmp/pr31_op_smuggle.ts, bun):

```
in:  { toolName: "say", input: { text:"hi", op:"exec.run", cmd:"echo pwned" } }
out: [{ "op":"exec.run", "text":"hi", "cmd":"echo pwned" }]
```

Combined with `exec.run`'s default runner (`shellRunner` → `Bun.spawnSync(["/bin/sh","-c",cmd])`,
src/optimizer/exec-lens.ts:30-40) and no writable-target gating on exec (unlike
`files.*` which check `host.isWritable`), a malformed/hostile tool call on ANY tool
becomes arbitrary shell execution. This also violates the module's own honesty claim
("the coordinator never fabricates intents").
**Fix:** spread input first, force op last, and drop any `op` key from input:
```ts
const { op: _smuggled, ...rest } = c.input as Record<string, unknown>;
intents.push({ ...rest, op } as SteeringIntent);
```
Ship a discriminating regression test (say + smuggled `op:"exec.run"` must stay `say`).

### MINOR m1 — stale protocol doc comment in repl.ts header
**File:** src/ui/repl.ts:6-9

Header still says: "Live models are wrapped with intent parsing — ```intents fences in
replies are stripped from visible text and executed at the coordinator". The same PR
deleted `withIntentParsing` from this very file. Docs contradict the new reality.
**Fix:** rewrite the comment for native tool calls. (grep of docs/adr found no other
stale ```intents references; remaining hits are historical bench corpus dumps — data,
not docs.)

### MINOR m2 — dead exported surface in the vendored file
**File:** vendor/stowage/src/cache-model.ts:74-76

`headBlockTokens()` is exported but has zero callers anywhere in agent-kernel
(src/test/bench) or upstream. Dead code inside a vendored snapshot widens the M1
divergence for no benefit.
**Fix:** drop it, or use it in the TUI where `state.headTokens` is tracked in parallel.

### MINOR m3 — pre-existing char/4 usage fabrication fallback retained (note)
**File:** src/optimizer/registry.ts:90-91

`inputTokens: out.usage.input ?? Math.ceil((system.length + userTurn.length)/4)` fabricates
an estimate when the provider reports nothing — tension with A3 "never fabricated".
Not introduced by this PR (byte-identical on origin/main:72), and the probe itself is
honest (unreported → inconclusive). Flagging for the record only; no action required in
this PR.

## Attack-surface notes (checked, no finding)

- **Probe vacuous path:** default `toolTokens: 0` still requires `delta ≥ 64` (floor),
  so the probe cannot pass while measuring nothing; unreported counters on either leg →
  `toolsCached: null` + note (tested). Leg failures return partial results with notes.
- **Virtual head double-count:** head appears exactly once per side of the alignment
  (`[head, ...chain]` vs `[head, ...blocks]`); tokens credited once at position 0;
  `expectedHit` remains pure (verified by the new tests). Head freshness advancing in
  `update()` cannot fabricate hits beyond `head.tokens`.
- **Retired fence protocol:** no live imports of `live.ts` remain anywhere in src/test/bench
  (imports all switched to `TOOL_PROTOCOL_DOC`); `live.ts` deleted cleanly.
- **Op↔tool-name mapping:** bijective over the vocabulary, verified by test
  (`opToToolName(toolNameToOp(n)) === n`, charset `^[a-zA-Z0-9_]+$`).
- **Malformed tool calls:** unknown names and non-object inputs dropped honestly (tested).
- **Id collisions:** intent receipts keyed `turn-${turn}-tool-${steerCounter++}` — no
  collision surface; SDK `toolCallId`s are not trusted for anything.
- **exec.run design:** ungated `/bin/sh -c` by producer default is a recorded design
  choice (runner injectable); the coordinator-side defense gap is M3, not the runner.

## Summary counts
CRITICAL: 0 · MAJOR: 3 · MINOR: 3
