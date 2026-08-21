# ADR-0002a: Calling surface and context contributions

- **Status:** Accepted (guidelines subordinate to ADR-0002)
- **Date:** 2026-08-21
- **Deciders:** Daniel Eisner (rulings), Robby (analysis)
- **Parent:** ADR-0002
- **Refined by:** ADR-0002c (the mtime protocol is instance two of the
  generic item-source interface; §4 maps to validate/cache-and-validate)

---

**Summary.** The calling surface: a trained-convention compatibility skin over kernel-native lenses, the two-channel rule for results, the lease for context contributions, mtime validation without invalidation, and trivial-query collapse.

**Key points**

- Compat skin: trained-convention naming (read_file-style) mapped onto lens behavior — zero retraining cost — §1
- Two-channel rule: values return to code, observations to context — never both — §2
- The lease: coordinator-side authoring of context contributions with token accounting — §3
- mtime protocol: validate-without-invalidate — cheap freshness checks before re-reads — §4
- Trivial-query collapse: cheap queries skip the model entirely — §5

*An index of sections and key points, with line anchors, appears at the end of this file. If you edit this file, update that index to match.*

## Context

ADR-0002 made the context a projection: a typed store rendered by an
optimizer. But two surfaces still spoke accumulator dialect. First, tool
names and call/response records — models were trained on `read_file`
conventions, and a harness that renames everything fights its own model.
Second, tool results — a bulky observation flowing through a cell result
lands in context as scar tissue unless something intercepts it.

Rulings this session resolve both, and fold the resolution into the plugin
ABI itself.

## Decision

### 1. Compatibility skin: trained-convention naming, lens behavior

The calling surface presents tool names the models were trained on —
`read_file`, `write_file`, `get_time` — as **aliases bound to
optimizer-native operations**: `read_file(path, from, to)` internally maps
to `lens.expand`; a re-read maps to validation; `get_time` maps to a clock
notice. Agents fluent in mainstream harness conventions operate without
retraining; the optimizer gets lens semantics underneath. The alias
registry is review-gated like plugin declarations (ADR-0001).

### 2. Two-channel rule: value to code, observation to context

Every plugin call produces two artifacts with two consumers:

```
PluginCall → { value: TypedData,               // code channel → namespace
               contributions: ContextItem[] }  // observation channel → store
```

The cell receives only the typed value; the model consumes only the
rendered contributions. Neither consumer pays the other's token tax.
`read_file` returns a real `FileSlice` (later cells use `slice.lines[i]`
at zero context cost) while the lens — not the transcript — carries the
lines for the model.

**Cells never receive mutable context objects.** Context mutation is a
coordinator-side, capability-scoped act; handing set-methods into the VM
would reintroduce accumulator behavior through a side door and open an
injection surface.

### 3. The lease (contribution authoring, coordinator-side)

Plugin implementations may write structured contributions mid-call:

```ts
interface ContextLease {
  expand(target: string, range: Range, content: string,
         meta?: { mtime?: number; size?: number; digest?: string }): void;
  release(target: string, range: Range): void;
  notice(text: string, ttl: "turn" | "task" | "session"): void;
  reference(item: Omit<ContextItem, "id">): void;
}
```

Contribution tiers (per method, declared at registration):

- **derived** (default) — runtime derives the contribution from
  (method, args, result) via declarative policy. `get_time` needs no code:
  its policy says "collapse to notice."
- **lease** — the implementation authors contributions itself.
- **inline** — legacy string blob, rendered as traditional tool output.
  Compat escape hatch only.
- **silent** — no contribution; pure programmatic value.

Value policies: **data** (full value to namespace), **handle** (value to
namespace; summary + digest to context), **void**.

### 4. mtime protocol: validation without invalidation

Every `expand` records `{mtime, size, digest}` per range in the lens.

- Re-read with **matching mtime** → idempotent: value served to the cell,
  **zero context change**, zero cache invalidation. Optionally a volatile
  tail notice: "validated kernel.ts unchanged since turn 41."
- **Mismatch** → the range invalidates; the lens re-reads; the objective
  function re-prices the item and everything after it.

Split placement principle (general): stable artifact content renders
early; volatile validation notices render late at the tail. The
confirmation an agent needs costs one line at the cheapest position, and
the file view it confirms stays cached.

### 5. Trivial-query collapse

Single-fact calls (`get_time`, `pwd`, `whoami`) contribute one notice
line — no tool-call/response transcript pair. General rule: **a
tool-call record renders only if the model needs to see the exchange.**
The journal retains the full call audit regardless; rendering is for the
model, journaling is for truth.

Conservative default: **failure results keep their transcript record.**
"I already tried that and it failed" is exactly the causality the model
must not lose; only successful trivia collapse.

## Consequences

- The plugin ABI (ADR-0002 §5) extends from
  `{surface, method, args} → result` to
  `{surface, method, args} → {value, contributions}`. Both channels derive
  from the same call record — desync between what code sees and what the
  model sees is a single-source derivation, golden-tested.
- File views become the template for all lens tools: fetch → expand →
  validate → age → migrate or evict, priced end-to-end.
- The compat skin means existing harness-trained agents adopt the
  optimizer with zero prompt migration; the optimizer is invisible to
  them by design.

## Risks

- **Alias drift** — a skin that silently diverges from trained semantics
  (a `read_file` that behaves surprisingly) is worse than a new name.
  Aliases are review-gated; semantic parity is part of the review.
- **Lease as injection vector** — contributions are data crossing the
  capability boundary; coordinator-side only; surfaces review-gated.
- **Over-collapse** — hiding exchanges the model needed. Defaults are
  conservative; collapse is opted into per-method by policy.


---

**Index** — line anchors as of this revision.

*Update this index whenever the file is edited.*

Sections:

- Context — line 24
- Decision — line 36
- Consequences — line 122
- Risks — line 135

Key points:

- Compat skin: trained-convention naming (read_file-style) mapped onto lens behavior — zero retraining cost — §1 — line 38
- Two-channel rule: values return to code, observations to context — never both — §2 — line 48
- The lease: coordinator-side authoring of context contributions with token accounting — §3 — line 68
- mtime protocol: validate-without-invalidate — cheap freshness checks before re-reads — §4 — line 95
- Trivial-query collapse: cheap queries skip the model entirely — §5 — line 110
