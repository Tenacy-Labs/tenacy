# ADR-0001: Microkernel architecture with a coordinator-side plugin system

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** Daniel Eisner (ruling), Robby (analysis)
- **Sequence:** plugin loader lands *after* the agent loop (see Sequencing)
- **Parent:** ADR-0000 (foundational purpose and driving design)

## Context

The kernel now provides turn execution, journal/snapshot persistence with
snapshot-only recovery, the strict TypeScript cell gate, swarm envelopes,
and Commons. A list of upcoming capabilities — MCP server compatibility,
agent skills, AGENTS.md support, crons/scheduled tasks, memory with
dreaming/prompt-injection defense, and more — could each be accreted onto
the kernel one by one. That path bloats the core, couples unrelated
features to the persistence invariants, and multiplies the surface that a
future Rust/deno_core graduation would have to reproduce exactly.

Existing constraints already push toward a small core:

- Side effects are host-injected capabilities, by prior design.
- The kernel interface is deliberately narrow (`ops.*`) as graduation insurance.
- The coordinator/worker split exists precisely to keep heavy machinery
  (the 48.1MB lesson: a TypeScript compiler per worker) out of agent VMs.

## Decision

**agent-kernel remains a microkernel.** Every capability on the list is a
*plugin*: a userspace TypeScript module running on the coordinator thread,
conforming to a `Plugin` interface. None of them ship inside `src/kernel.ts`,
the worker runtime, or the cell gate.

### 1. Plugins run on the coordinator, never inside agent VMs

Agent cells see thin message-passing stubs (`ops.mcp.call(...)`) that cross
the worker boundary as capability-checked envelopes; the plugin executes on
the coordinator and returns a result. Plugins are trusted coordinator code;
agent cells remain the untrusted side; MCP servers stay external processes,
as their protocol intends. This preserves the compiler-free worker budget
(6.7MB marginal) and keeps untrusted code away from broker logic.

### 2. Plugins ship type declarations; the cell gate enforces the ABI

A plugin contributes ambient `.d.ts` text for its `ops.*` surface. The
CellCompiler merges it into every agent's virtual TypeScript program, so an
agent calling `ops.mcp.cal("tool")` receives a *type error at cell time* —
before any code executes. Plugin ABI violations become ordinary diagnostics
in the same feedback loop the agent already uses for self-correction. No
separate validation layer is required.

### 3. Contract by interface; base class optional

TypeScript's structural typing means plugins conform without inheriting
kernel internals. A base class may exist later as convenience sugar, but the
mechanism is the interface. This avoids fragile-base coupling and keeps
plugins independently testable against a mock `PluginCtx`.

### 4. The kernel owns capability mediation

Grants — which plugin ops each agent may invoke, which envelopes it may
send, whether it may spawn — are issued and enforced by the kernel, never by
plugins. A plugin system whose plugins can bypass the grant machinery is
theater.

### 5. Capability mapping

| Capability | Plugin | Mechanism |
|---|---|---|
| MCP servers | `mcp` | JSON-RPC to external processes; `ops.mcp.*` stubs |
| Agent skills | `skills` | `onTurn` context contribution (skill index) |
| AGENTS.md | `agents` | `onTurn` context contribution (rules) |
| Crons / scheduled tasks | `scheduler` | `onTick`; fires turns/DMs; persists own schedules |
| Memory + dreaming | `memory` | `ops.memory.*`; recall via `onTurn`; **dreaming = scheduler firing consolidation turns** — two plugins composing |

## Proposed contract

Frozen only after the second plugin ships (see Sequencing).

```ts
export interface Plugin {
  readonly name: string;             // "mcp", "memory", ...
  readonly version: string;
  init(ctx: PluginCtx): Promise<void>;
  /** Ambient .d.ts for the cell gate — the plugin's enforced ABI. */
  types?(): string;
  /** Coordinator-side implementations behind ops.* envelopes. */
  ops?(): Record<string, (arg: any) => any>;
  /** Contribute context before a turn's model call. */
  onTurn?(turn: TurnCtx): Promise<TurnContribution | void>;
  /** Observe/intercept swarm envelopes. */
  onEnvelope?(env: Envelope): void;
  /** Periodic tick (scheduler, dreaming). */
  onTick?(now: number): void;
  dispose?(): void;
}

export interface PluginCtx {
  readonly stateDir: string;   // plugin-private persistence
  log(level: "info" | "warn" | "error", msg: string): void;
  // swarm/commons access is grant-scoped by the kernel, not raw handles
}
```

## What stays in the kernel (non-negotiable)

Turn execution; journal + snapshot persistence and snapshot-only recovery;
the TypeScript cell gate; envelope routing; swarm lifecycle (spawn edge =
report-back edge, soft interrupts); Commons; capability grants.

Litmus test for every future PR: *could the kernel be rewritten in Rust
without touching this code?* If not, it belongs in a plugin.

## Consequences

**Positive:** core stays small and invariant-focused; capabilities develop,
test, and fail independently; the Rust graduation path narrows to the kernel
proper; plugin ABIs are type-enforced at agent authoring time; memory +
scheduler compose into dreaming without kernel changes.

**Negative:** an ABI to design and eventually freeze; one indirection hop
(cell → envelope → plugin) on every op call; a loader and grant registry to
build and maintain.

**Risks:** plugin `onTurn` hooks sit on the hot path of every turn — they
must be budgeted (timeouts) or a slow plugin stalls the swarm; `types()`
text must be validated (a plugin can widen agent authority via ambient
declarations, so declarations are review-gated like code).

## Sequencing

1. Agent loop (model calls, tool-call parsing, turn dispatch) — the hooks
   above presuppose it.
2. Plugin loader + `Plugin` interface + grant registry.
3. Plugin one: `mcp` (self-contained, external protocol, no kernel coupling).
4. Plugin two: `memory` (stresses `onTurn`; dreaming proves composability).
5. Freeze the plugin API.

## Rejected alternatives

- **Monolithic accretion** — one capability at a time into the kernel:
  coupling, bloat, and a graduation rewrite that must reproduce everything.
- **Plugins inside agent VMs** — reintroduces the per-worker memory blowup
  and puts trusted SDKs beside untrusted cells.
- **Base-class inheritance as the mechanism** — fragile-base coupling;
  interface + structural typing achieves the contract without it.
- **Freezing the ABI before two real consumers exist** — freezing a seam
  against hypotheticals is how the wrong seam gets frozen.
