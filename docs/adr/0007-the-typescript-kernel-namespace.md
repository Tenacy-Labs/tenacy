# ADR-0007: The TypeScript kernel namespace and the RLM-native tool-call surface

- **Status:** Proposed
- **Date:** 2026-08-24
- **Deciders:** Daniel Eisner (ruling), Robby (analysis)
- **Parents:** ADR-0000 (five pillars), ADR-0001 (microkernel + plugin system), ADR-0002 (context optimizer), ADR-0002a (calling surface), ADR-0002d (lens family)
- **Sequence:** lands with the plugin substrate (ADR-0001 step 2)

---

**Summary.** The namespace ruling: **every tool call materializes a typed TypeScript object in the kernel namespace** — lenses, handles, registries — so the RLM stays pure (tool calls are code; code holds the results; results hold the state) while gaining native conveniences. The namespace is curated top-level real estate: a `lenses` namespace references every lens instantiation with handles the RLM manipulates; the namespace lens itself is non-deletable.

## Context

The plugin architecture (ADR-0001) gives capabilities a coordinator-side state home, but leaves the *calling surface* — what a cell actually sees and holds after a tool call — under-specified. Three pressures shape it:

1. **RLM purity.** The RLM paradigm is code-as-act: tool calls are TypeScript calls inside the cell; results are values bound to variables. The harness must not drift into the accumulator pattern where every call appends to a transcript log the model re-reads (the horizontal gap the RLM paper left unaddressed; ADR-0002's core objection). Code holds results; the store holds only what the solver prices.
2. **Native conveniences.** Lenses (ADR-0002d), ctx.* (ADR-0002g), goal/advisor modes, MCP tool handles — these are conveniences for the RLM-as-coder. They must not require transcript accumulation to use.
3. **Namespace curation.** A namespace is real estate. Without curation, `ops.mcp` + `ops.skills` + `ops.memory` + `ctx.*` + `lenses.*` + commands + legacy aliases accrete into a flat soup. The model's trained vocabulary and the cell gate's type discipline are the scarce resources; the namespace is where both are spent.

## Decision

### 1. Every tool call materializes a typed object

Every capability a cell invokes — via `ops.*` envelope or lens op — returns a **typed value** and, when the result is stateful or durable, **materializes a typed object in the kernel namespace**. Two channels per call (ADR-0002a two-channel rule): the typed value (returned, bound in cell scope) AND a ContextItem contribution to the store (priced by the solver). The object is the handle; the handle is the capability.

```ts
// what a tool call looks like to the cell
const gh = await ops.github.issue("org/repo", 123);   // typed handle
const issue = await gh.get();                          // method calls on the handle
await gh.edit({ labels: ["bug"] });                    // handle methods
const lens = await lenses.files.open("/src/loop.ts");  // lens instantiation
lens.expand(SymbolRanges);                             // expand algebra on the symbol tree
lens.focus("src/optimizer/");
```

- **Handles are frozen envelopes**: read-only objects wrapping coordinator-side state. Handle methods emit envelope ops (the single-RPC-envelope ABI from ADR-0002); they never mutate cell-visible state in place.
- **Materialization is journaled** — handle creation is a journaled action under the journaling discipline (never replay; snapshot-only recovery), so a crashed cell's handles re-inject at boot (environment-not-state, like plugin bindings).
- **Materialized objects have ContextItems.** Every materialized object gets a store item (the context contribution channel); the solver prices whether it renders. Unpriced objects stay invisible but recallable (ctx.search, ADR-0002d §3).

### 2. The namespace layout (curated)

```
globalThis
├── lenses     // ALL lens instantiations, references + handles (ruling: top-level lenses ns)
│   ├── files  // four substrates as sub-namespaces: files, code, tree, ns
│   ├── code
│   ├── tree
│   ├── ns     // the namespace lens itself — non-deletable (ruling)
│   ├── memory
│   ├── goals
│   └── …      // plugin-registered lens families (e.g. lenses.web)
├── ctx        // self-reflection surface (ADR-0002g)
├── ops        // plugin op surfaces: ops.mcp, ops.skills, ops.memory, ops.scheduler
├── rlm        // child management (rlm.spawn, rlm.gather, rlm.join — gap #1)
```

The namespace lens (ADR-0002d kernel-namespace lens) renders this namespace as a lens — focusable, recursive over path prefixes. The ruling makes `lenses.ns` **non-deletable**: it can be focused, expanded, released, live/polled/frozen — but never deleted. Rationale: the RLM must always be able to see what it holds; a cell that could delete `lenses.ns` could blind itself to its own state. Self-blindness is not an economic decision; it is a safety property. Non-deletable applies to the lens *object*; rendered *entries* inside it remain subject to solver economics (the lens shows an honest ledger of what exists, even when entries render empty).

```
(lens entry format, illustrative)
lenses.files["/src/loop.ts"]: FileView — 3 coalesced ranges, 812 tokens, live
lenses.ns["ops.mcp"]: NamespaceEntry — 4 tools, 12k tokens if expanded
lenses.ns["ctx"]: NamespaceEntry — 6 fns, 40 tokens
```

### 2b. Handle protocol (the RLM's manipulation surface)

```ts
export interface LensHandle {
  readonly id: string;                  // stable lens instance id
  readonly substrate: "files" | "code" | "tree" | "ns" | "memory" | string;
  expand(range | symbolScope): void;    // one expand algebra (0002d)
  focus(pathPrefix: string): void;
  release(range | symbolScope): void;
  watch(mode: "live" | "polled" | "frozen"): void;
  digest(): string;                     // content digest for the cache chain
}
```

- `LensHandle` methods are envelope ops. `watch()` is the 0002d §7 toggle surface. `digest()` feeds the CacheModel digest chain.
- Handles are **non-deletable from the cell side**: `delete` is not in the protocol. Release/purge goes through solver-priced ops (`release()`, solver liquidation of oversized lenses) — economics, not deletion.

### 2c. Lens family registration (ADR-0001 plugin surface #7)

```ts
export interface LensFamilyPlugin extends Plugin {
  lenses(): LensFamilySpec[];
}
export interface LensFamilySpec {
  readonly family: string;       // "web", "github", ...
  readonly substrate: string;    // descriptor for the family's substrate type
  readonly dts: string;          // ambient .d.ts for the cell gate
}
```

Plugins register lens families through `lenses()`; the loader validates the `.d.ts` (review-gated like all ambient declarations — a plugin can widen agent authority through declarations), mounts the family as a `lenses.<family>` sub-namespace, and instantiates handle classes per call. Existing four substrates (files/code/tree/ns) are kernel-resident families; plugins add more. The `lenses` registry object itself is non-enumerable/non-configurable on globalThis — no `delete lenses` and no re-assignment.

### 2d. Persistent handle objects across turns (RLM-pure persistence)

Handles persist across turns via snapshots (Bun: closures do not serialize — but handles are frozen records of (family, id, coordinator-state pointer), so snapshot serializes the record, and the coordinator re-materializes the handle at boot). This is "state revival" under the persistence invariants: the *record* persists; the *referent* is coordinator-side; revival re-attaches.

### 3. RLM purity: the complete chain

Code holds the results; the store holds only solver-priced projections. The transcript is a projection of the render, not the context (ADR-0002). An RLM working this way never needs to re-read a transcript to know what it holds: it looks at `lenses.ns`, or its own variables. "Tool call → typed object → namespace entry → priced ContextItem" is the complete chain, and every link is typed, journaled, and snapshot-recoverable.

## Sequencing

1. Substrate PR: plugin loader + grant registry + event bus + this namespace curation (mount `lenses`/`ctx`/`ops`/`rlm` as non-configurable, non-enumerable top-level bindings; namespace lens non-deletion enforcement).
2. Lens-family registration surface (`lenses()` on `Plugin`).
3. MCP plugin with handle-materializing ops (first real consumer; stress-tests the chain end to end).
4. Freeze the namespace charter (this ADR) after two real consumers (per ADR-0001's freeze discipline).

## Consequences

**Positive:** the RLM gets native conveniences without accumulator drift — every capability lands as typed code objects the RLM manipulates; the namespace is curated, typed at authoring time by the cell gate, snapshot-recoverable; plugins gain a standard way to expose lens families; the non-deletable namespace lens guarantees self-visibility.

**Negative:** every capability now requires handle design (names, methods, digests); handles add one indirection hop (cell → envelope → coordinator object); the namespace layout needs a curator (new top-level names are ADR-worthy, like commit rights).

**Risks:** handle bloat (unbounded materialization — solver-priced ContextItems + ctx.search recall cap this); model fluency with handle-rich code (mitigated by compat skin aliases per ADR-0002a and prompt-time type errors from the cell gate); frozen-namespace anti-pattern — if the layout is wrong, every plugin inherits the mistake (mitigated by the freeze discipline: no top-level name lands without two real consumers).

## Rejected alternatives

- **Transcript accumulation for tool results** — the accumulator pattern; the horizontal gap. Rejected by ADR-0002.
- **Plain return values with no materialization** — breaks persistence and recall (results live only in a turn's cell scope; a later turn cannot recall what it once held). Materialization is the minimum for snapshot revival.
- **Deletable namespace lens** — self-blindness; rejected by the non-deletion ruling (safety, not economics).
- **Base-class LensHandle** — fragile-base coupling; interface + structural typing per ADR-0001 §3.
- **Registry in the store** — the store prices context; it does not own namespaces. The registry is code, not context.
- **Flat `ops.*` for everything** — a flat soup that spends trained vocabulary and cell-gate discipline on collisions; curation is the point.

## Index

*Update this index whenever this file is edited.*

Sections:

- Context — line 13
- Decision — line 21
- The namespace layout (curated) — line 41
- Sequencing — line 107
- Consequences — line 114
- Rejected alternatives — line 122

Key points:

- Every tool call materializes a typed object — handles, registries, lenses; two channels per call; the object is the handle — §1 — line 23
- The namespace layout: lenses/ctx/ops/rlm top-level, curated; `lenses.ns` non-deletable (safety, not economics) — §2 — line 41
- Lens family registration via `lenses()` on Plugin; declaration review-gated; registry non-configurable — §2c — line 84
- Handles persist as records; revival re-attaches (state revival under persistence invariants) — §2d — line 99
- RLM purity chain: tool call → typed object → namespace entry → priced ContextItem — §3 — line 103
- Freeze the namespace charter after two real consumers — Sequencing — line 107
