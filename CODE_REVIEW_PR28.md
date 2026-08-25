# Code review — PR #28: ADR-0007 substrate (`feat/adr-0007-substrate` vs `main@7af9011`)

Reviewer: fresh-context merge-gate review. All findings below were **reproduced by
execution** (repro scripts run with `bun` against the branch), not inferred.

## Verification (actually observed)

| Check | Result |
|---|---|
| `bun x --bun tsc --noEmit` | exit 0, no errors |
| `bun test` (full repo) | **926 pass / 0 fail**, 9769 expect() calls, 41 files, 13.06s |
| `bun test test/substrate.test.ts` | **11 pass / 0 fail**, 33 expect() calls |
| Adversarial repros (`/tmp/pr28_repro.ts`, `/tmp/pr28_crash.ts`) | all 6 landed (C1, C1b, C2, M2, C3b, M5 below) |

Bun 1.3.14, macOS arm64.

---

## CRITICAL (merge blockers)

### C1. Grant self-escalation: `ctx.grants` is live and mutable — "sealed ctx" is a shallow freeze
**loader.ts:44–57, plugin.ts:31, plugin.ts:70–72.** ADR-0001 §4: "a plugin system
whose plugins can bypass the grant machinery is theater." This PR's own header
(plugin.ts:13) claims the ctx is sealed and bypass is "detected."

- `GrantRegistry.grantsFor()` returns `this.#grants.get(name) ?? NO_GRANTS` — the
  **live stored object**, not a copy. `Object.freeze(ctx)` is shallow, so
  `ctx.grants` still points at it.
- Repro (executed): a plugin with **no** `steer` grant runs
  `ctx.grants.steer = true; ctx.submitSteering("pwned")` in `init` →
  `{"kind":"steer.request","text":"pwned","note":"escalator"}` **delivered to the
  loop's steering hooks**. The `if (!g.steer)` gate at loader.ts:49 reads the
  same object the plugin just flipped.
- Worse: ungranted plugins get the **shared exported** `NO_GRANTS` const
  (plugin.ts:31), which is not frozen. Any code mutating `NO_GRANTS.steer = true`
  flips the default to allow for **every** ungranted plugin. Reproduced
  (`"poisoned default"` accepted for a plugin granted nothing).
- Also: the closure captures `g` at register time — there is no revocation path
  even if the registry were hardened later.

Fix is cheap: `grantsFor` returns `Object.freeze({ ...NO_GRANTS, ...g })` (per
call), and `NO_GRANTS` is `Object.freeze({...})` at definition. A grant model
whose objects the adversary holds must be copy-on-read and frozen; this is the
one non-negotiable of ADR-0001 §4.

### C2. Async `init()` containment is broken — an async-throwing plugin kills the kernel
**loader.ts:60** — `void plugin.init?.(ctx);` discards the promise; the try/catch
only catches sync throws. The module's own contract (loader.ts:7–9): "a plugin
whose init/registration throws is dropped with a diagnostic — the kernel boots
regardless."

Reproduced (`bun`, exit code observed):

```
boot survived, active: ["bad"]        ← plugin counted ACTIVE despite failed init
KERNEL CONTINUES...
error: async boom                     ← unhandled rejection
  at init (...) at register (loader.ts:60) at bootPlugins (loader.ts:105)
PROCESS EXIT CODE: 1                  ← kernel process dies
```

Two failures in one: (a) the plugin is registered as active with its onEvent
wired even though its init failed — `collect()` reports it in `active`;
(b) the rejection is unhandled, and Bun's default crashes the process — the
exact catastrophic outcome the containment contract forbids. `init?(): void |
Promise<void>` (plugin.ts:47) *invites* async init, so this is an expected path,
not an exotic one. Also, since the promise is never awaited, `collect()`
(loader.ts:74) races any plugin that sets up surface state asynchronously.

Fix: track the promise; `await Promise.allSettled(...)` in `bootPlugins` (make it
async) before `collect()`; drop plugins whose init rejected; `.catch()` on the
stored promise regardless.

### C3. §2e mutation surface is inert, and the rw gate it ships with is bypassable
Three facets, together a blocker because the PR claims §2e as implemented:

**(a) The mutation ops don't exist in the intent pipeline.**
`WritableFileHandle.patch/replace/append` (handles.ts:61–70) emit
`files.patch` / `files.replace` / `files.append`, but `executeIntent`
(intents.ts:369 `default:`) has **no cases for them** — every mutation intent
returns `{ op: "unknown", ok: false, result: "unknown intent" }`. Grep across
`src/` confirms zero handlers. No conflict policy ("substrate changed;
re-expand"), no commit emission, no `digest`/`changedRanges`/`symbolDiff`
receipts — all promised by §2e — exist anywhere. §2e is typed, not implemented.

**(b) The rw gate is a raw string prefix match with two proven bypasses.**
ns-mount.ts:32 — `writable.some((r) => path.startsWith(r))`. Reproduced with
`writableRoots: ["/tmp"]`:
- `open("/tmp/../etc/passwd", { mode: "rw" })` → **WritableFileHandle**;
  `.append("evil")` emitted `{"op":"files.append","target":"/etc/../etc/passwd"}`
  — `/tmp/../etc/passwd` traverses out of the root.
- `open("/tmporary-secret", { mode: "rw" })` → **WritableFileHandle** — sibling
  prefix, not under `/tmp/`.

No path normalization, no lexical resolution, no boundary check. Today the ops
are inert (facet a), so nothing writes — but this gate is the *reviewed security
boundary* the ADR pins the mutation surface on; the moment someone wires the ops
into `executeIntent`, both bypasses become live file writes outside granted
roots. Fix: resolve/normalize both sides, compare path components, reject `..`
segments.

**(c) The type-level capability story is erased at the mount.**
§2e: "`open(path)` returns a read-only handle whose declaration carries no
mutation methods; granted `open(path, {mode:"rw"})` returns `WritableFileHandle
extends LensHandle`. The cell gate rejects mutation calls statically." But
`MountedNamespace.lenses.files.open` (ns-mount.ts:24, 36–41) declares return
type `LensHandle` for **both** modes — the WritableFileHandle specialization is
invisible to the type system. The test itself must cast
(`(rw as WritableFileHandle).append(...)` — substrate.test.ts:134). Overload the
signature (`mode: "rw"` → `WritableFileHandle`) or the static-gate claim is
unimplementable through this API.

---

## MAJOR (should fix)

### M1. `grants.events` and `grants.register` are never enforced
plugin.ts:20–29 declares four grants; only `steer` and `drive` are ever checked
(grep: zero reads of `.events`/`.register` anywhere in `src/`). Reproduced: a
plugin granted **nothing** still receives the full event stream —
loader.ts:66–70 wires `onEvent` to the bus unconditionally. An operator writing
`grant("x", { events: false })` believes the plugin is silenced; it is not.
Either enforce (`if (g.events)` before `bus.on`) or delete the fields — a grant
enum with decorative members trains operators to stop believing grants.

### M2. `ctx.bus` hands plugins the kernel's write side — forged telemetry is indistinguishable from truth
events.ts:22–23: "the bus carries kernel-outward events only (one direction, one
truth)." loader.ts:47 passes the loop's **actual bus** into the ctx. Reproduced:
a plugin emitted `ctx.bus.emit({ kind: "model.called", turn: 999, provider:
"fake", ... })` and a `model.called` subscriber received it — forged token
accounting/event-stream data indistinguishable from kernel emissions. Consumers
are telemetry/exporters (billing, attribution), DAP, ACP. A plugin can also
un-boundedly spam any listener. Pass a **read-only facade** (subscribe-only
wrapper exposing `on`), never the bus.

### M3. Emission seams: `render.decided` emitted after the model call, `latencyMs` hardcoded 0, `provider` field carries the model id
loop.ts:304–305. Causal order in `run()` is: solve → render (`rr`) →
`hooks.onRender` → `await callWithRetry` → … incumbent update → **then**
`render.decided` and `model.called` fire, back-to-back, after the response
arrived. A stream consumer reconstructing the turn timeline sees the render
decision *after* the model call it preceded. Move `render.decided` to just after
the render (next to `hooks.onRender`, loop.ts:215).

Field honesty on a kind declared **stable public API** (events.ts:8–9): `model.called`
carries `latencyMs: 0` always, and `provider: this.providerId, model:
this.providerId` — `providerId` is `provider.modelId` (loop.ts:363–365), so the
`provider` field is populated with the model id and there is no real provider
name. Exporters will key on these fields; fixing semantics after consumers exist
is the expensive rename the file itself warns about. Either measure latency and
carry a distinct provider name now, or mark the fields explicitly provisional.

Related MINOR (see m2): `steering.executed` (loop.ts:110) fires with the
**previous** turn number (increment happens at loop.ts:124) — defensible
temporal ordering, but events.ts:6 says "every event carries the turn it belongs
to"; document the convention or emit the upcoming turn.

### M4. Failure path emits nothing; 3 of 8 event kinds are dead vocabulary — including `error.thrown`
When `callWithRetry` throws (auth error, retry exhaustion — it rethrows,
loop.ts:371 area), the turn emitted `turn.started` but never emits
`turn.completed` or anything else: consumers hang on a half-open turn. The
vocabulary has an `error.thrown` kind (events.ts:19) that is **emitted nowhere**
(grep across `src/`: zero sites); same for `solver.ran` and `lens.delta`. The
kind strings are declared stable public API — shipping dead kinds means removing
them later is an ADR-worthy rename. Wire `error.thrown` into the failure path
(and ideally `solver.ran` after `solve`), or cut the dead kinds before freeze.

### M5. `mountNamespace` re-mount silently diverges — the "idempotent second mount" is not idempotent
ns-mount.ts:47–51: `if (!(k in g))` silently skips binding when `lenses` already
exists, but the function still builds and returns a **fresh** `lenses` object
and **fresh** `HandleRegistry`. Reproduced: two mounts → different objects,
second registry size 0, `globalThis.lenses` keeps the first cohort. §2 says the
`lenses` ns references **every** lens instantiation; after a second mount (REPL
re-init, test fixtures, per-session mounts) every handle opened through the new
mount is invisible in the global namespace binding. Also: writing `globalThis`
in a module function means the test suite mutates process-global state for every
other test file. Either return the existing binding's objects or throw on
re-mount — silent divergence is the worst option. The test
(substrate.test.ts:141–142) calls this "idempotent" and merely asserts it
doesn't throw.

### M6. §2 namespace layout: 1 of 4 top-level bindings mounted
ADR §2 and Sequencing step 1: "mount `lenses`/`ctx`/`ops`/`rlm` as
non-configurable, non-enumerable top-level bindings." ns-mount.ts mounts only
`lenses` (ns-mount.ts:47 `Object.entries({ lenses })`) while its own docstring
(ns-mount.ts:3) claims "(lenses / ctx / ops / rlm)". If the scope was cut, say
so in the PR and the module comment — as written the module claims §2
conformance it doesn't have. (Also fine to fix by mounting the other three as
empty sealed namespaces now, so plugin families have their parent surfaces.)

### M7. DAP facade §4 gaps: `setVariable` ignores the value and always demotes
dap.ts:72–76: every `setVariable` becomes
`sink({ op: "ctx.demote", id: name })` — the `value` argument is **never read**.
An operator setting a variable to `"live"` (promote-intent) gets a **demote**;
any value, any variable, same intent. §4: "setVariable | an intent — journaled
and priced, same mediation as every write" — mediation is upheld (nothing raw),
but the mapped intent is not the expressed intent. Map value → op (`"frozen"` →
demote, `"live"`/`"polled"` → ctx.watch, else reject), or reject all values
until real mapping exists — silently doing the opposite of the user's action is
the honest-failure antithesis. Additionally:
- `evaluate` (dap.ts:69–71) returns a canned string with `success: true` —
  §4 maps evaluate → ctx.search. A front-end console displays the canned line as
  the evaluation *result*. Either wire ctx.search (read-only, already an
  executeIntent op) or return `success: false` with the pointer message.
- No lazy expansion: all children get `variablesReference: 0` (dap.ts:84–97,
  `#leaf()`), so the "variables tree, lazy children = expand algebra" row of §4
  is one level deep with no drill-down into handles — the DAP payoff of §2b
  uniformity isn't demonstrable.
- Error responses use `command: "error"` (dap.ts:119) — DAP expects the response
  `command` to echo the request's; strict front-ends will mismatch.
- `#nextVar` (dap.ts:37) is dead; `#vars` never evicts (currently only 2 memo
  entries, so harmless, but the machinery implies per-variable refs that don't
  exist).

### M8. Test honesty: the fake sink green-lights the inert mutation surface
The suite's header claims "Every module gets discriminating coverage — not
vacuous passes." Partially true (the non-deletable-binding test and the
honest-denial grant test are real). But:

- **Every handle/mount/DAP test uses `sinkSpy`** (substrate.test.ts:15–22),
  which fabricates `{ ok: true, result: "queued" }`. That is why the suite is
  green while `files.patch/replace/append` are unexecutable in the real
  pipeline (C3a) — one test running a mutation op through the **real**
  `executeIntent` (or the real loop) would have caught it. The tests test the
  mock, not the substrate.
- **Grant tests miss both proven bypasses**: no test mutates `ctx.grants`, none
  poisons `NO_GRANTS`, none checks that an ungranted plugin is *silent* on the
  event stream (M1). A reviewer relying on the suite would believe the gate
  holds; C1 passes all 11 tests.
- **rw-gate tests miss both proven bypasses**: `/etc/hosts` outside roots is
  covered (substrate.test.ts:138–139) but neither `/tmp/../etc/...` traversal
  nor the `/tmporary` sibling-prefix case is (C3b).
- **DAP tests bake in the M7 bug**: substrate.test.ts:168–170 asserts
  `setVariable` → `ctx.demote` regardless of value — the test *pins* the broken
  mapping. No test that `evaluate` can't execute anything (a facade with free
  eval would pass the suite).
- **Async init**: the init-throw test only covers the sync throw
  (substrate.test.ts:74–78); the async case (C2) is untested and would fail.

---

## MINOR (nice to have)

- **m1. `focus` == `expand`** (handles.ts:50–52) — §2b specifies
  `focus(pathPrefix: string)` as a distinct op; here it aliases line-range
  expand with `sel: unknown`. This is the "mandatory uniform protocol" the ADR
  says registration will reject families for omitting — get the shape right
  before it calcifies.
- **m2. `steering.executed` turn attribution** (loop.ts:110) — emits the
  previous turn's number; see M3. Document or fix.
- **m3. `digest()` returns the id** (handles.ts:39) — placeholder that makes the
  cache-chain digest degenerate; fine for substrate, but mark it.
- **m4. `PluginEmitted` / `isPluginEmitted` are dead vocabulary**
  (events.ts:24–30) — nothing consumes the type except the submitSteering
  return value; the guard's doc says "used by the DAP facade and tests" but
  dap.ts imports nothing from events.ts.
- **m5. Sink-throw containment** — handle methods call `this.sink(...)`
  unguarded; a throwing coordinator sink propagates into cell code. The loop's
  own intent execution wraps in try/catch (loop.ts:104–106); handles should
  state the contract (throw vs receipt).
- **m6. Listener mutation during dispatch** (bus.ts:43–51) — a listener calling
  `bus.on("all", ...)` mid-emit is visited in the same iteration (Set semantics);
  a self-subscribing listener can loop. Cheap guard: snapshot the sets.
- **m7. Grant snapshot semantics** — ctx captures `g` at register time; there
  is no revocation path. Boot-only is per-ADR, but a one-line doc on PluginCtx
  would prevent someone "revoking" later and wondering why nothing changed.

---

## ADR conformance summary

| ADR section | Status |
|---|---|
| §1 typed objects / two-channel | Partial — handles exist; ContextItem channel unimplemented (acceptable for substrate PR; not claimed in PR title) |
| §2 curated ns layout | **Non-conformant** — only `lenses` mounted of 4 bindings (M6); `lenses.ns` non-deletion: ns-lens itself not in this PR; the `lenses` binding non-configurable ✔ (tested) |
| §2b uniform protocol | Shape only — `focus` drifts (m1), `digest` placeholder (m3); no enforcement surface exists |
| §2c family registration | Shape only — `lenses()` collected but nothing mounts families (per sequencing, step 2) |
| §2e writable handles | **Non-conformant** — ops unexecutable (C3a), gate bypassable (C3b), type-level capability erased (C3c) |
| §4 DAP facade | Read-safe (exposes less than the ns, not more — no grant or raw-state exposure found); but setVariable mapping broken (M7), evaluate/lazy-expand stubs |
| ADR-0001 §4 grants | **Violated** — self-escalation + shared-mutable default (C1); `events`/`register` grants decorative (M1) |

## What I did not cover

- No end-to-end run of `AgentLoop` with a live provider (emission sites reviewed
  statically plus full existing suite); the loop's `bus` has zero in-process
  consumers, so consumer-side behavior is untested by anything.
- `vendor/stowage` untouched by this PR — not reviewed here.
- DAP facade not exercised against a real front-end (VS Code/nvim-dap); framing
  (Content-Length) is explicitly declared the front-end's job.
- `lens.delta`/`solver.ran` semantics — dead code today (M4), nothing to review.

## VERDICT: REQUEST_CHANGES

The build is green (tsc clean, 926/926 tests) and the bones are good — the bus
containment, the non-deletable binding test, and the honest-denial grant return
are real. But three blockers, all **proven by execution**, stand between this
and merge:

1. **C1** — the grant machinery is bypassable in two lines and the shared
   `NO_GRANTS` default is poisonable; ADR-0001 §4 is the PR's own founding rule
   and the module header falsely claims the ctx is sealed.
2. **C2** — an async-throwing plugin registers as active *and* crashes the
   kernel via unhandled rejection, violating the loader's first stated
   guarantee.
3. **C3** — §2e is claimed as implemented but is inert end-to-end (ops hit
   "unknown intent"), its rw gate is trivially bypassable by path traversal and
   sibling prefixes, and the type-level capability is erased at the mount —
   landing it would enshrine a broken security boundary that successor PRs will
   trust as reviewed.

None require redesign; all are localized fixes (frozen grant copies, awaited
init with allSettled, real path normalization + intent handlers or an explicit
scope cut, plus the M8 tests that would have caught each). Re-review after the
criticals; M1/M2 (un enforced grants, writable bus in ctx) should ride the same
fix since they're the same trust boundary.


---

## Re-review (after 176f50f + d6774c7)
Verified: tsc clean; bun test 936/936 (41 files, 9797 expects). All prior criticals reproduced as fixed (C1/C1b frozen copy-on-read grants; C2 contained async init, dropped w/ diagnostic; C3a live gated mutation ops; C3b component-normalized gate both mount- and host-side — traversal/sibling/dot/relative dead through real executeIntent; C3c rw overloads) with discriminating tests per repro.
New, execution-proven:
- **MAJOR N1** bus.ts:66–73 + loader.ts:47 — `ctx.bus.on` ignores the events grant; ungranted plugins read the full kernel stream. M1's claim is false via the M2 seam.
- **MAJOR N2** loader.ts:89–108 — zombie listeners: dropped plugins (init-throws-after-subscribe; or `#wire` at :100 before the commands() catch) keep bus subscriptions.
- **MAJOR N3** loader.ts:89 — never-settling init hangs boot forever (no timeout); "kernel boots regardless" still violated.
- **MAJOR N4** loop.ts:591 + intents.ts:96–122 — new-file write commits via fileWrite, then fileLens throws → receipt `ok:false` for a write that landed; invites duplicate writes.
- **MAJOR N5** loop.ts:125–135 — no lens refresh after committed writes (claim of re-parse/symbol-remap is untrue); lens serves stale content post-write; §2e receipts absent.
- **MINOR** rw-denied type-lie via cast (ns-mount.ts:88); render.decided still post-model (loop.ts:365); solver.ran dead; no real-pipeline host-gate test.
**VERDICT: REQUEST_CHANGES** — prior blockers are fixed, but the fix seams carry four execution-proven majors (grant bypass via bus facade, zombie listeners, boot hang, dishonest/incoherent write receipts). All are localized: gate the facade's `on` by events grant, unsubscribe on drop, timeout init, refresh-or-create the lens before returning the write receipt (or fail before committing).

---

## Final gate (70a0379)

Reviewer: third-pass merge gate, fresh probes written independently (not the gate-2 scripts). Repo at HEAD 70a0379, base 7af9011.

### Verification (actually observed)

| Check | Result |
|---|---|
| `bun x --bun tsc --noEmit` | exit 0, no errors |
| `bun test` (full repo) | **941 pass / 0 fail**, 9808 expect() calls, 41 files, 18.10s |
| Probe A (N1/N2/N3 + trackingOn) | all 9 checks pass |
| Probe B (new-seam hunt) | **seam CONFIRMED** (F1 below) |
| Probe C (rw refusal + N4/N5) | all 15 checks pass |
| Probe D (timer leak) | process exits in 0.014s after fast-init collect — no timer leak |

### N1–N5 re-verified fixed (own repros, executed)

- **N1** — ungranted `ctx.bus.on("all"|"turn.started",…)` hears nothing; granted plugin
  delivers (grant honored, not globally suppressed). loader.ts:49–57.
- **N2** — subscribe-then-throw init (events granted): dropped AND unsubscribed;
  surface-throw (`commands()` throws after subscribing): dropped AND unsubscribed.
  loader.ts:135, loader.ts:144.
- **N3** — never-settling init: `collect()` resolves at **5004ms**, reason
  `init failed: Error: init timeout`; fast init resolves in ~0ms (timer cleared).
- **N4** — commit-then-lens-fail (provider serves nothing): receipt
  `ok:true` with caveat `appended /tmp/n4.txt (lens refresh deferred: Error: no such file: …)`,
  file actually committed, `lens.delta` emitted. intents.ts:107–121.
- **N5** — pre-existing lens refreshed after append (`one\n` → `one\ntwo\n`); new-file
  write creates the lens fresh (`born\n`). loop.ts:152–160.
- **N4 inverse** — failed write (`ok:false` from the writer) and non-writable target both
  return `ok:false`, no `lens.delta`. No path found where a failed write returns `ok:true`.

### Adversarial checks on the new seams (all clean except F1)

- Resolve-only done-promise: plugin cannot settle it early (never handed out);
  `clearTimeout` runs on every settle path; Bun exits 0.014s after a fast-init collect —
  the 5s timer does not hold the process open.
- `trackingOn` off(): actually removes from the bus; double/triple-unsub safe;
  ungranted `on` returns an inert unsub. (off() correctness verified, see F1 for the
  post-drop hole.)
- rw hard refusal: throws before any handle is constructed — registry size and
  `lens:/etc/hosts` both untouched after refusal; traversal (`/tmp/../etc/passwd`) and
  sibling (`/tmporary`) refused; normalized-inside (`/tmp/../tmp/ok.ts`) still opens.
  ns-mount.ts:83–93.
- Commit-then-lens ordering: failed writes never `ok:true` (above); host gate
  (`isWritable`) still enforced before any commit (intents.ts:103).

### Findings

**F1. MAJOR (merge blocker) — the N3 timeout window resurrects the N2 zombie: a
late-settling init keeps a fully-live ctx after the plugin was dropped.**
loader.ts:49–70 + loader.ts:130–137. The drop at collect() unsubscribes `unsubs` and
deletes the ctx from `#ctxs`, but the init continuation is still running and holds the
frozen ctx object — whose `trackingOn` still subscribes (grant check only, no
dropped-check) and whose `submitSteering`/`spawnTurn` still pass their grant gates
forever. Reproduced (probe B, executed): plugin with `{events,steer,drive}` grants,
`init` resolves at 6.3s (past the 5s timeout):

```
collect resolved at 5003ms; dropped=[{"name":"late","reason":"init failed: Error: init timeout"}]
post-drop submitSteering returned: {"kind":"steer.request","text":"post-drop steer","note":"late"}
post-drop spawnTurn returned: {"ok":true,"queued":true}
post-drop listener saw: ["turn.started"]        ← permanent untracked bus subscription
```

Three failures in one: (a) the post-drop `bus.on` lands on the real bus **after** the
`unsubs` array was drained — no code path can ever remove it (the returned `off()` is
held only by the dropped plugin); this is N2 again, one window later; (b) the operator
sees "init timeout" and believes the plugin is dead, yet it can queue steering and spawn
turns at any future moment — the containment contract ("dropped with a diagnostic")
is false for slow inits; (c) no malice is required: any plugin doing a >5s network fetch
at boot hits this on a slow day. Note this does **not** bypass grants (post-drop actions
are still grant-checked), so it is MAJOR not CRITICAL by this review's scale — same
class as N2/N3, which gate 2 treated as blockers. The suite misses it because the N2
test throws synchronously (pre-timeout) and the N3 test never settles.
Fix is ~5 lines: a shared `dropped` flag flipped at collect(), checked in `trackingOn`
(return inert unsub), `submitSteering`, and `spawnTurn` (return `{error:"plugin dropped"}`);
plus one settle-after-timeout test.

**F2. MINOR — `lens.delta` can fire for a lens that was never created/refreshed, and the
N4 comment lies about which layer notes the caveat.** loop.ts:161–172: the inner catch is
empty ("receipt notes it (N4)") but this layer adds nothing to the receipt — the caveat
the caller sees is minted by intents.ts:120. When the provider serves nothing,
`#writeFile` still emits `lens.delta` (loop.ts:170) for `lens:<target>` which may not
exist in the registry; and `changedLines` is always `[]`. Consumers key on lens ids
(events.ts: "stable public API") — emitting deltas for nonexistent lenses trains them to
ignore the kind. Move the caveat-annotating into `#writeFile` (one place), and emit
`lens.delta` only when the lens exists post-refresh.

**F3. MINOR — `asReadOnlyBus` is dead code duplicating the N1 gate.** bus.ts:74–80
exports a grant-gated facade that nothing calls (loader.ts:16 imports it, but the loader
builds its own `trackingOn` closure at loader.ts:51–57). Two divergent copies of a
security gate is a liability: the next edit fixes one and not the other. Delete one
(prefer keeping the bus-side helper and have `trackingOn` delegate to it, so the
tracking wrapper is the only addition).

**F4. MINOR (carried, still open from gate 2, non-blocking)** — `solver.ran` remains
dead vocabulary (events.ts:19, zero emit sites); `render.decided` still fires after the
model call (loop.ts:372). Both were noted as minors in gate 2; unchanged here.

### VERDICT: REQUEST_CHANGES

One blocker, execution-proven: **F1** — the timeout-fix seam re-opens the exact zombie
containment failure (N2) this commit claims to close, plus permanent post-drop inbound
capability, and it triggers on any legitimately slow (>5s) init with no malice. The
N1–N5 fixes themselves are genuine (all five re-verified by independent repros), the rw
hard-refusal path is clean end-to-end, the done-promise/timer machinery leaks nothing,
and the build is green (tsc clean; 941/941). The fix is a five-line ctx-revocation flag
plus one settle-after-timeout test — small, local, and it makes "dropped means dead"
true at every settle time, which is the whole point of the loader's containment
contract. Everything else in this PR is merge-ready.

---

## Confirmation gate (e21e272)

Reviewer: final merge gate, fresh probes written independently of all prior gates.
Repo at HEAD e21e272 (PR head confirmed via `gh pr view`), base 7af9011. Scope:
F1 fix execution, new-seam hunt limited to e21e272's diff, build/tests/CI.

### Verification (actually observed)

| Check | Result |
|---|---|
| `bun x --bun tsc --noEmit` | exit 0, no errors |
| `bun test` (full repo) | **942 pass / 0 fail**, 9812 expect() calls, 41 files, 23.11s |
| `bun test test/substrate.test.ts` | 27 pass / 0 fail |
| Own F1 probe (`/tmp` scratch, deleted after run) | **16/16 checks pass** |
| Mutation check on the discriminating test | gate removed → test FAILS (0 pass / 1 fail); gate restored → passes; loader byte-identical after restore |
| `gh pr checks 28` | `test` **pass** (1m6s), run 32799384696, head e21e2724… OPEN |

### F1 fix verified by execution (own probe, not the shipped test)

Init settling at **5510ms** (past the 5s timeout), holding its ctx:

```
collect resolved at 5003ms; dropped=[{"name":"late","reason":"init failed: Error: init timeout"}]
post-drop bus.on refused (no zombie sub) — seen=[]
post-drop submitSteering refused — {"error":"plugin dropped"}
post-drop spawnTurn refused — {"error":"plugin dropped"}
steer hook never invoked / spawn hook never invoked (0 calls each)
```

- **No path leaves `state.dropped` unset on a drop.** All four drop paths probed —
  init timeout, sync throw, async rejection, surface throw (`commands()` throws) —
  each drops AND seals: post-drop `bus.on` lands nothing, post-drop steer returns
  `plugin dropped` (loader.ts:142, loader.ts:153 are the only two drop sites; both
  set the flag, and the timeout path routes through `state.failed` → loader.ts:142).
- **The shipped test discriminates.** Removing only the `state.dropped` clause from
  `trackingOn` (loader.ts:59) makes "F1: late-settling init cannot resurrect a
  dropped plugin" fail (seen=["turn.started",…] zombie sub observed); restoring it
  passes. Not a vacuous test.

### New-seam hunt (scoped to e21e272's diff) — clean

- **`state` leak paths: none.** Enumerated every own-property reachable from the
  frozen ctx (`pluginName, bus, grants, submitSteering, spawnTurn`) and the bus
  facade (`on` only): the `LoaderState` object is closure-captured, never a ctx
  property, never exported. A plugin can neither read nor flip `dropped`. The
  only other holder is `#pending` (private, drained at collect()). Grants remain
  frozen copy-on-read: mutation attempt throws and steering stays refused.
- **LoaderState type change: contained.** Non-exported interface, two use sites
  (loader.ts:55, loader.ts:120) updated consistently; tsc clean confirms no
  dangling shapes.
- **F2: correct.** `lens.delta` emit moved inside the try, after
  `refreshLensFromSubstrate` (loop.ts:137–143) — a provider that serves nothing
  now emits no delta for a nonexistent lens; committed+refreshed writes still emit.
- **F3 removal: nothing dangling.** Zero references to `asReadOnlyBus` anywhere in
  `src/` or `test/` (grep); the loader's `trackingOn` is the sole gate, so the
  duplicated-security-gate liability is gone.

### Findings

- **MINOR — orphaned doc comment.** bus.ts:72–73: F3's removal deleted the
  function but left its doc comment ("N1 fix: `on` is grant-gated — plugins
  without the events grant subscribe to nothing…") dangling at EOF describing a
  function that no longer exists. The gate now lives (correctly, per F3's own
  recommendation) in loader.ts:59 — move or delete the stale comment. Cosmetic;
  not merge-blocking.
- **MINOR (carried, unchanged, non-blocking)** — F4 from the final gate:
  `solver.ran` still dead vocabulary; `render.decided` still post-model; and
  `lens.delta.changedLines` remains always `[]` (loop.ts:139). All previously
  classed minor; no regression introduced by e21e272.

### VERDICT: APPROVE

F1 — the sole blocker from the final gate — is fixed and proven by independent
execution on every drop path, the ctx-revocation flag is unreachable from plugin
code, the F2/F3 fixes are clean with no new seams, the build is green (tsc clean;
942/942 across 41 files), and CI passes on the exact PR head (e21e272). The two
minors above are comment-hygiene and carried items — neither blocks merge.
