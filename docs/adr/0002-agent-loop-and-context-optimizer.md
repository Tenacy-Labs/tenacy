# ADR-0002: The agent loop and the context optimizer

- **Status:** Accepted
- **Date:** 2026-08-21
- **Deciders:** Daniel Eisner (rulings), Robby (analysis)
- **Parent:** ADR-0000 · **Relates to:** ADR-0001
- **Extended by:** ADR-0002d (the lens family — kernel namespace,
  code-on-disk, directory — and live views; §3's "future lenses" partly
  specified there); ADR-0002e (the InvalidationLedger of §4 subsumed
  into the decision ledger with per-step forecast/computation/cache
  detail)
- **Input:** prime-agent loop study (packages/agent/src/agent-loop.ts, read 2026-08-21)

## Context

The loop milestone arrived with three facts on the table. First, the
prime-agent study: a generic turn loop whose policy is entirely hooks
(non-throwing contracts, three-tier message injection, continuation as the
autonomy engine, epoch-guarded async results) — wrapped in an 11,590-line
session god-object that is the counter-example our plugin split exists to
avoid. Second, our kernel is cell-shaped, not tool-call-shaped: the agent
writes TypeScript cells against a persistent namespace, so the inner loop
needs no JSON tool protocol at all. Third, the traditional context window —
an accumulator that appends entries and periodically compacts — is
structurally hostile both to attention quality and to prefix KV caching,
and every existing harness we studied commits to it.

A sequence of rulings (this session) replaced the accumulator outright.

## Decision

### 1. The loop

```
while (true):
  drain interrupts (steering)            # safe point; already built
  store.update(turn results)             # rich objects, not strings
  render(store, taskFocus, cacheModel)   # pure, deterministic
  model call → cell (TypeScript)         # against materialized modules
  gate: check + transpile                # already built (coordinator-side)
  execute in worker                      # already built
  settle outstanding plugin RPCs         # turn ends only when settled
  snapshot                               # already built
  cacheModel.calibrate(actual usage)     # close the loop
  continuation?                          # goals/scheduler plugin
```

Hook contracts follow prime-agent's discipline: hooks must not throw (safe
fallback), every async hook result is re-validated against an epoch before
use, steering owns the turn boundary it drains. Each concern that
prime-agent accreted onto its session object (goals, refine, compaction,
steering) is here a plugin with a hook.

### 2. Context optimizer, not context accumulator

The transcript is not the context; **the context is a projection.** The
pattern is immediate-mode: `context = render(store, focus, cacheState)`,
analogous to UI = f(state). Three cooperating parts:

- **ContextStore** — kernel-resident, typed, journaled. Collections of
  `ContextItem`s, never rendered directly.
- **Renderer** — pure and deterministic; constructs the entire context
  string as an engineered artifact every turn. Golden-testable.
- **CacheModel** — our belief about the server's KV cache: digest chain of
  emitted blocks, checkpoint placement, TTL decay, provider block
  granularity; self-calibrates against reported cache-hit usage every call.

```ts
interface ContextItem {
  id: string;            // stable handle ("goal", "turn-41", "mem:7")
  kind: "identity" | "directive" | "goal" | "episodic" | "reference"
      | "lens" | "kernelView" | "artifact" | "notice";
  importance: number;    // base weight x task relevance
  velocity: "frozen" | "stable" | "evolving" | "volatile";
  immutable: boolean;    // episodic records never change once written
  tokens: number;        // accounted at insertion
  lastRender?: { position: number; digest: string };  // render memory
}
```

Velocity zones become the cache layout: frozen identity at the head
(cache-pinned), stable material early with explicit checkpoints, evolving
material mid-render, volatile churn confined to the tail. "Compaction" as
an event ceases to exist. What remains: store maintenance (summarize old
episodic items into `reference` items, asynchronously in dreaming turns,
never touching a live prefix) and render-time curation (drop the
least-important, not the oldest). The journal keeps full-fidelity history
regardless.

### 3. Lens objects (worked example: file views)

Repeatedly consulted artifacts become **lenses**, not transcript events. A
file read is a mutation of a persistent view object:

```ts
interface FileView {
  kind: "lens"; target: string;
  ranges: Range[];            // coalesced line ranges actually read
  lastTouchedTurn: number;    // temperature input
}
```

- Nine chunked reads render as **one** entry. Re-reading an already-loaded
  range is idempotent: zero tokens, zero cache invalidation.
- The tool surface inverts: not `read(path, from, to)` but
  `files.expand(path, from, to)` / `files.release(path, n)` — tools that
  add/remove from the file window, returning tiny confirmations. Lines
  never flow through cell results.
- Placement is economic: actively-read files render near the tail (growth
  invalidates only what follows); as a file cools it earns migration toward
  the stable prefix; eviction happens when the token value finally exceeds
  the one-time re-prefill cost, or when the item has drifted near the tail
  so removal is nearly free. Migration is opportunistic — reorder only
  when an invalidation is already being paid.

The read history stays in the journal for audit; the transcript stops
being the memory of what was read. Kernel view, plans, recall sets, and
child-agent reports are future lenses.

### 4. Render economics — the objective function

Every render decision (place, keep, reorder, summarize, evict) is priced
by one utility function, with three terms:

```
utility(item, pos) = benefit(item, pos) − cacheCost(item, pos) − rot(Λ, pos)
```

- `cacheCost` — marginal re-prefill: tokens after `pos` x (uncached −
  cached price), computed from `lastRender` positions and the digest chain.
- `benefit` — probability of near-term use x token value, discounted by
  horizon.
- `rot(Λ, pos)` — **context rot**: the empirical degradation of model
  performance as rendered length Λ grows (lost-in-the-middle attention
  falloff, instruction drift, distraction). Applied as an increasing
  marginal penalty on total rendered tokens, position-weighted (middle
  positions rot worst). The rot term gives the optimizer a *quality*
  incentive to stay small — eviction and summarization remain correct even
  when tokens are cheap. Its shape is empirical: calibrated from observed
  task performance (redo rate, instruction misses) against rendered
  length, exactly as cache forecasts calibrate against usage reports.

Every render emits an **InvalidationLedger** (what moved, what dropped,
predicted cost vs. realized usage) — journaled, closing the calibration
loop on both money and rot.

### 5. Materialized plugin surfaces (everything is code)

Per ruling: a plugin with a callable surface does not expose stringly
`ops.*` stubs — it **materializes typed modules in the kernel namespace**.

- **Types:** each plugin ships `.d.ts` declaring real modules
  (`declare module "mcp/github" {...}`); declarations join the coordinator
  gate's virtual program. Mistyped calls are authoring-time errors.
- **Runtime:** worker boot injects proxy bindings
  (`mcp.github.create_issue = async (...a) => rpc("mcp.github", "create_issue", a)`).
  The single `{surface, method, args} → result` RPC envelope is the entire
  plugin ABI — the narrow, Rust-portable interface.
- **Environment vs. state:** injected bindings are environment, not state.
  Snapshots skip them; recovery re-materializes from the capability
  manifest. The namespace splits into what the agent built (snapshot
  recovery) and what it was granted (boot-time injection).
- **Capability = existence:** no grant → no binding, no declaration → the
  reference is a compile error. Nothing to bypass at runtime.
- **Async:** cells may hold Promises from plugin calls; the turn is not
  complete until all outstanding RPCs settle (or deadline → crash path).
- **Exactly-once:** each RPC carries an idempotency key
  (agent + turn + sequence); the plugin boundary logs effect-intent before
  the wire and result after — dedupe happens at the boundary where the
  outside world is touched.
- **Recorded tension:** materialized modules are ambient and typed — their
  power and their injection risk. Plugin declarations are review-gated
  like code (ADR-0001); grants are per-agent; all calls cross the audited
  manifest boundary.

### 6. Kernel as medium, kernel as tool

Inside a turn the kernel is the medium the agent thinks in — no tool
protocol. At boundaries it is a tool: `rlm.spawn()/turn()/stop()` (parents
operating children — the swarm API, already built) and protocol adapters
(ACP/A2A peers, per ADR-0001). Both surfaces narrow, typed, gated.

## Consequences

- The loop milestone ships as: turn engine with hook contracts, renderer
  v1, cache model v1, lens tools (`files.expand/release`), provider
  adapters, plugin loader. Goals/scheduler, memory (recall + dreaming as
  scheduled consolidation turns), skills, MCP follow per the ADR-0001
  sequence.
- Staging: v1 = zone order + append-only lenses + idempotent re-reads;
  v2 = opportunistic migration + eviction calculus; v3 = full reorder
  optimization under the three-term objective. `render()` stays pure and
  golden-tested at every stage; placement changes require a cleared
  hysteresis margin (recompute always, churn never).
- Open questions recorded: (a) the no-code turn — pure-prose replies need
  a construct (`ops.reply(text)` or a `reply` cell kind) or a dual-channel
  model output; (b) mid-cell abort remains snapshot-and-restart (JSC
  watchdog unexposed in Bun); cell timeouts are treated as worker crashes,
  which already resolve gracefully.

## Rejected alternatives

- **Context accumulator + periodic compaction** — the industry default;
  structurally hostile to cache and attention; replaced by the optimizer.
- **MemGPT/Letta-style eviction** — size-driven paging of the string;
  ignores structure, provenance, and cache economics.
- **JSON tool protocol in the inner loop** — unnecessary when the turn is
  a cell; tools are typed calls on materialized modules.
- **`ops.*` string dispatch** — subsumed by materialized modules; the ABI
  shrinks to one RPC envelope.
- **Compaction as a first-class event/plugin** — dissolved into store
  maintenance (dreaming) + render-time curation.
