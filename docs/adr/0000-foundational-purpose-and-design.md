# ADR-0000: Foundational purpose and driving design of agent-kernel

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** Daniel Eisner (ruling), Robby (analysis)
- **Supersedes:** nothing — this is the root. ADR-0001 is the first child.

## Context

The current crop of agentic frameworks each got one thing profoundly right
and the rest merely acceptable. DeepSeek's harness demonstrated the
kernel/plugin decomposition. jcode demonstrated that an agent runtime can
be genuinely fast and cheap per session. prime-agent demonstrated that
code-first agency — the model *programming* its own stateful workspace
rather than jabbing JSON tool calls — changes what agents can do. The open
protocol ecosystem (ACP, the OpenCode/openchamber protocol family, A2A)
demonstrated that agent harnesses need not be walled gardens.

None of them combines all four. Building on any single one means inheriting
its compromises. We evaluated reusing prime-agent as chassis directly and
rejected it; we studied jcode's architecture as reference rather than
merging codebases. The decision, therefore, is a synthesis harness built
from scratch, taking the best feature from each.

## Decision

**agent-kernel is a single harness that combines the four proven ideas:**

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

4. **Standards-based compatibility at the core.** The harness's
   outward-facing surfaces speak open protocols natively — ACP for
   client/editor integration, the OpenCode/openchamber protocol family, A2A
   for agent-to-agent interop — so agent-kernel agents interoperate with the
   wider ecosystem from day one rather than through bespoke bridges. The
   *commitment* to standards is constitutional; the adapters themselves are
   plugins (ADR-0001), which is what keeps the core small while the
   protocol surface stays open.

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
code-first under a strict type gate, and every external surface is an open
protocol. Each pillar constrains the others — plugin overhead must fit
inside the performance budgets; protocol adapters must be plugins, not
kernel residents; the type gate must enforce plugin ABIs, which is why
plugins ship `.d.ts` to the gate.

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
