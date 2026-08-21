# ADR-0000: Foundational purpose and driving design of agent-kernel

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** Daniel Eisner (ruling), Robby (analysis)
- **Supersedes:** nothing — this is the root. ADR-0001 is the first child.

---

**Summary.** The root decision: agent-kernel is built from scratch as a synthesis of the five best ideas from existing harnesses — plugin-everything architecture, jcode-class economics, code-first agency, open protocols as plugins, and a pi-small core with batteries included by example.

**Key points**

- Five pillars combined: everything-is-a-plugin (DeepSeek); measured speed/memory budgets (jcode: ~21ms cold start, 6.7MB/worker); code-first agency in TypeScript under a strict gate (prime-agent); ACP/OpenCode/A2A spoken natively — as plugins; pi-small core with an OMP-style reference distribution as proof — Decision
- Derived principles: mechanisms in kernel / policy in plugins; code-first typed turns; measured budgets over vibes; untrusted cells over a trusted coordinator; narrow `ops.*` as graduation insurance; journal audit-only, snapshots the sole recovery — Principles
- The identity is the combination — each pillar constrains the others (plugin overhead inside budgets, protocols as plugins, the gate enforces plugin ABIs) — Consequences
- Rejected: adopting any single chassis (prime-agent evaluated and declined), merging codebases, bespoke external protocols, batteries in the kernel — Rejected

*An index of sections and key points, with line anchors, appears at the end of this file. If you edit this file, update that index to match.*

## Context

The current crop of agentic frameworks each got one thing profoundly right
and the rest merely acceptable. DeepSeek's harness demonstrated the
kernel/plugin decomposition. jcode demonstrated that an agent runtime can
be genuinely fast and cheap per session. prime-agent demonstrated that
code-first agency — the model *programming* its own stateful workspace
rather than jabbing JSON tool calls — changes what agents can do. The open
protocol ecosystem (ACP, the OpenCode/openchamber protocol family, A2A)
demonstrated that agent harnesses need not be walled gardens.
pi demonstrated that a tiny, simple, foundational core can be immediately
useful — and OMP demonstrated that batteries-included richness can ride on
top of such a core as assembled examples rather than core machinery.

None of them combines all five. Building on any single one means inheriting
its compromises. We evaluated reusing prime-agent as chassis directly and
rejected it; we studied jcode's architecture as reference rather than
merging codebases. The decision, therefore, is a synthesis harness built
from scratch, taking the best feature from each.

## Decision

**agent-kernel is a single harness that combines the five best ideas:**

1. **Kernel/plugin decomposition (DeepSeek's insight): everything is a
   plugin.** The kernel provides only mechanisms — turn execution,
   persistence, the type gate, routing, capability grants. Every capability
   (MCP, skills, AGENTS.md, scheduling, memory, protocol adapters) is a
   coordinator-side plugin per ADR-0001. Litmus test for all code: could
   the kernel be rewritten in Rust without touching this?

2. **Efficiency and speed (jcode's physics).** Agents are cheap enough to
   spawn freely: ~21ms cold start, ~11.7ms session spawn, 54µs dispatch,
   ~6.7MB marginal per worker, 5.5ms recovery — measured, not aspirational.
   The swarm maps jcode's primitives (sessions, notifications as soft
   interrupts, single VersionedPlan, spawn edge = report-back edge) onto Bun
   worker threads. Performance is a design constraint with budgets, not a
   post-hoc optimization.

3. **Code-first agency (prime-agent's insight).** The agent's primary act
   is *writing code into a persistent kernel*. State lives in the namespace,
   not in a context window; the model programs its own workspace and the
   harness executes it. TypeScript everywhere (author's ruling): the harness
   is tsc-strict in CI, and agent cells pass the same kind of strict gate
   in-process before execution — diagnostics are the error-correction
   signal. Recovery is snapshot-only; replay does not exist; side effects
   stay exactly-once ("forgetting is recoverable, repeating is not").

4. **Standards-based compatibility.** The harness's
   outward-facing surfaces speak open protocols natively — ACP for
   client/editor integration, the OpenCode/openchamber protocol family, A2A
   for agent-to-agent interop — so agent-kernel agents interoperate with the
   wider ecosystem from day one rather than through bespoke bridges. The
   commitment is constitutional — the kernel's envelope/turn model must
   never preclude these protocols — and **the protocols themselves are
   implemented as plugins** (ADR-0001): no protocol code lives in the
   kernel. This is what keeps the core small while the protocol surface
   stays open.

5. **Simple foundational availability (pi's insight), batteries-included by
   example (OMP's).** The kernel core stays pi-small: minimal enough to
   hold in one head, immediately useful on its own, admitting no capability
   that fails the plugin litmus test. Richness ships as a reference
   distribution — batteries-included, OMP-style assembled agents (skills,
   memory, protocols, scheduling pre-wired) built entirely from plugins
   with zero kernel changes. The distribution is the proof of the plugin
   thesis.

## Driving design principles (derived)

- **Mechanisms in the kernel, policy in plugins** — ADR-0001.
- **Code-first turns:** a turn is a typed cell executed against persistent
  state, not a tool-call round-trip.
- **Measured budgets over vibes:** every layer ships with numbers.
- **Untrusted cells, trusted coordinator:** the type gate, capability
  grants, and plugin code sit on the coordinator; workers stay compiler-free
  and minimal.
- **Narrow kernel interface** (`ops.*`) as standing insurance for a
  Rust/deno_core graduation.
- **Persistence invariants:** journal is audit-only; snapshots are the sole
  recovery path; commits are atomic.

## Consequences

The framework's identity is the *combination*: plugin-everywhere
architecture running at jcode-class economics, where the agent works
code-first under a strict type gate, every external surface is an open
protocol, and the whole arrives as a pi-simple core plus a
batteries-included reference distribution. Each pillar constrains the others — plugin overhead must fit
inside the performance budgets; protocol adapters must be plugins, not
kernel residents; the type gate must enforce plugin ABIs, which is why
plugins ship `.d.ts` to the gate; and the core must never accrete what the
distribution can assemble.

**Sequencing remains as ADR-0001 records it:** agent loop, plugin loader,
MCP plugin, memory plugin, freeze the plugin API. Protocol adapters (ACP,
OpenCode/openchamber, A2A) land as plugins on that spine as the loop
matures.

## Rejected alternatives

- **Adopting any single existing harness as chassis** — inherits its
  compromises; prime-agent-as-chassis was explicitly evaluated and declined.
- **Merging codebases (jcode + prime-agent)** — rejected; reference their
  ideas, own the implementation.
- **Bespoke external protocols** — rejected; walled gardens are how harnesses
  die.
- **Batteries in the kernel** — rejected; the reference distribution carries
  the batteries, so the core never accretes them.


---

**Index** — line anchors as of this revision.

*Update this index whenever the file is edited.*

Sections:

- Context — line 21
- Decision — line 41
- Driving design principles (derived) — line 89
- Consequences — line 103
- Rejected alternatives — line 120

Key points:

- Five pillars combined: everything-is-a-plugin (DeepSeek); measured speed/memory budgets (jcode: ~21ms cold start, 6.7MB/worker); code-first agency in TypeScript under a strict gate (prime-agent); ACP/OpenCode/A2A spoken natively — as plugins; pi-small core with an OMP-style reference distribution as proof — Decision — line 41
- Derived principles: mechanisms in kernel / policy in plugins; code-first typed turns; measured budgets over vibes; untrusted cells over a trusted coordinator; narrow `ops.*` as graduation insurance; journal audit-only, snapshots the sole recovery — Principles — line 89
- The identity is the combination — each pillar constrains the others (plugin overhead inside budgets, protocols as plugins, the gate enforces plugin ABIs) — Consequences — line 103
- Rejected: adopting any single chassis (prime-agent evaluated and declined), merging codebases, bespoke external protocols, batteries in the kernel — Rejected — line 120
