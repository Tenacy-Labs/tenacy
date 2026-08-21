# ADR-0002d: The lens family and live views

- **Status:** Accepted (guidelines subordinate to ADR-0002 / 0002b / 0002c)
- **Date:** 2026-08-21
- **Deciders:** Daniel Eisner (rulings), Robby (analysis)
- **Parent:** ADR-0002c · **Ancestors:** ADR-0002 §3, ADR-0002a §4
- **Extended by:** ADR-0002f (self-lenses — conversation history with
  lossy summary transforms, and goals & objectives with the first
  decay-exemption value profile)
- **Input:** this session — ruling enumerating the primary lens
  implementations and live views, with the render contract for change
  legibility.

## Context

ADR-0002 §3 designed the file lens as the worked example and deferred
"kernel view, plans, recall sets, child-agent reports" as future lenses.
ADR-0002c made lens-ness a generic interface in wait of instances.
Rulings this session populate the family: **four primary
implementations**, plus a push-driven update mode — **live views** — with
an explicit contract that updates render legibly as sequences.

## Decision

### 1. The primary lens family

| Lens | Substrate | Observability | Subscription |
|---|---|---|---|
| File view | file contents, line ranges | stat/etag (cheap) | optional fs.watch |
| Kernel namespace | live namespace: bindings, cells, values | in-process — free | versioned-commit events (commons) |
| Code on disk | source files, symbol trees | stat → incremental re-parse | fs.watch → targeted re-parse |
| Directory tree | fs layout | dir mtime / walk + stats | fs.watch recursive |

All four instantiate the ItemSource interface (ADR-0002c). The family
spans the axes: the **namespace lens is the best-observable source in the
system** — the kernel is the source of truth, no boundary to cross — and
the **directory lens is the subscribable instance**, the first real
workload for "where subscription exists, the forecast retires"
(ADR-0002c §4). The rate-limited remote API remains the stress test,
still unbuilt.

### 2. One algebra, four backends

Every lens is a **focusable tree with priced expansion**:

- `focus(scope)` — bind to a subtree (path prefix, symbol, directory)
- `expand(node)` — reveal children/ranges; re-expand is idempotent
  (zero tokens, zero invalidation)
- `release(node | scope)` — drop from view

The tool surface generalizes `files.expand/release` per substrate;
trained-convention names remain as the compat skin (ADR-0002a §1). Lenses
compose as a DAG (ADR-0002c §5): directory-lens leaves are file/code
lenses; namespace-lens cell leaves are code lenses over cell source, and
value leaves render under the handle policy. Leaf validation covers the
subtree.

### 3. Kernel namespace lens (the live kernel)

Because the Bun kernel is the first-class and primary interface, its own
namespace is a primary lens substrate.

- **Focusable and recursive** (ruling "maybe recursive" — resolved yes):
  focus a path prefix (`ns["mcp"]`), expand children, refocus deeper.
  Recursion is the same expand algebra as file ranges; depth is priced.
- **Two projections:** *structure* (which bindings exist — cheap,
  stable) and *content* (a cell's source, a value's repr — per-leaf,
  delegated to the code lens / handle policy).
- **Subscription is already built in spirit:** the commons layer's
  versioned commits are the namespace's mutation events. The lens
  subscribes to commit diffs, not polling; versioning yields
  sequence-legible deltas (§6) for free.

### 4. Code-on-disk lens (tree-sitter backend)

Same focus/expand algebra, different anchoring: **ranges bind to symbols,
not line numbers.**

- An edit that shifts lines does not invalidate a lens focused on an
  untouched symbol — tree-sitter's incremental re-parse re-anchors.
  Stale-line-number bugs become a non-category.
- mtime mismatch → incremental re-parse (cheap, error-tolerant —
  tree-sitter's design purpose) → **symbol diff** → only changed symbols'
  entries invalidate. Unchanged symbols render byte-identical; their
  digests and cache survive.
- The file lens remains the raw-text substrate (logs, CSVs, notebooks);
  the code lens is the projection for source. A file may carry both; the
  optimizer prices which representation renders.

### 5. Live views (push-driven lenses)

A lens whose substrate is subscribable can run **live**: a
coordinator-side watcher feeds invalidation without the model polling.

- **Wiring:** watcher → store mutation (async, outside render) → next
  render reflects it. Render stays pure; the watcher is just another
  store client. `validate` for a live lens is answered from the watcher's
  last event — push answers before we ask (ADR-0002c §4).
- **The turn is the sampling boundary.** Filesystems emit storms (atomic
  saves, rename chains); events are debounced and coalesced to at most
  one committed delta per lens per turn. Events drain at the same safe
  point as steering (ADR-0002 §1) — no mid-turn mutation; a cell executes
  against a stable world.
- **Capability + scope:** watches are granted, path-scoped, ignore-globbed
  (`.git`, `node_modules`, build output); OS watch limits are real.
- **Churn pricing:** realized churn is journaled; a live lens whose
  realized invalidation cost exceeds its rendered value is **demoted to
  on-demand validation**. Live is a mode the optimizer can revoke, not a
  property of the lens.
- **Representation:** BASE+DELTA (ADR-0002b §5) is the native shape —
  the base block stays cache-immortal; deltas land at the tail.

### 6. Sequence legibility (the render contract for updates)

Ruling: a live-updated lens must render so the model **understands the
sequence** — a changed view reads as one evolving fact, not a new fact.

1. **Identity stability** — the item keeps its id and slot across
   updates; updates mutate the item, never drop-and-recreate.
2. **Marked deltas** — within the artifact, changes carry markers with
   turn citations: `+` added, `−` removed, `→` renamed/moved. The diff
   is the observation.
3. **Tail change-notices** — one line at the cheapest position when a
   watched substrate moves (split placement, ADR-0002a §4): the model
   that never re-reads the base still learns the world moved.
4. **Unchanged-stamps** — the render header carries `unchanged since
   turn N`. Explicit absence of change is information; silence is
   ambiguous.

### 7. The update toggle (model-authored relevance signal)

Ruling: each lens carries a toggle the model controls — **does it want
change updates, or does it not care.** Three states, one declarative:

- **live** — push updates flow (§5); watcher active; tail notices on.
- **polled** — default: validate on use, no watcher; updates only when
  the model touches the lens.
- **frozen** (mute) — the model declares it does not care.

**Mute is a state transition, not silence:**

- The watcher is **released** (resource reclaimed; the watch capability
  retires with it).
- Tail change-notices and unchanged-stamps cease for this lens.
- The rendered artifact becomes a **digest-stamped snapshot at
  mute-time** — stable content, eligible for promotion toward the cached
  prefix. Mute converts a volatile asset into a stable one: the toggle is
  a placement input, not only a value input.
- Explicit re-expand of a muted range is **implicit re-interest**: reset
  Δt, revalidate that range (its mismatch renders as a delta since the
  mute turn).

**Toggle flips are declarative journal signals.** The journal already
records behavioral signals (touches, re-references — ADR-0002b §2);
toggle flips add the declarative class: high-confidence, low-frequency
intent. Feeding the value utility:

- **Model-authored mute** bumps effective decay (α) — stronger than
  non-use, because non-use is ambiguous (may be mid-task) while mute is
  a declaration.
- **Unmute** resets Δt and re-confirms μ₀ — a re-declared interest.
- Portfolio reading: mute is the model's shadow vote for liquidation;
  the optimizer still prices the position (option value persists after
  declaration).

**Flip authorship is journaled.** The optimizer's churn demotion (§5)
lands in the same polled state, but an optimizer-forced flip must **not**
feed value decay — demote → decay → evict would spiral away lenses the
model still wants. Only model-authored flips are value signals;
optimizer flips are cost decisions.

## Consequences

- ADR-0002c's instance space gains two real residents (namespace:
  in-process observable; directory: subscribable); the subscribability
  axis is no longer hypothetical.
- The loop milestone's lens tools generalize from `files.*` to the family
  algebra; the file lens still ships first (ADR-0002 staging unchanged).
- The commons versioned-commit log doubles as the namespace lens's
  watcher backend — no second event system.
- Render purity is preserved: all asynchrony mutates the store at safe
  points; render remains a pure function of the store.
- The toggle state (§7) participates in both placement and value: mute
  promotes the snapshot toward the cached prefix; model-authored flips
  feed α and Δt; optimizer-authored flips never do.

## Risks / research areas

- **Watcher portability** — macOS FSEvents vs Linux inotify emulation;
  recursive-watch limits; debounce windows are empirical.
- **Churn attack** — a hot directory thrashes context if churn pricing is
  wrong; demotion-to-polled is the safety valve, journal-calibrated.
- **Diff legibility** — marker formats are model-facing UI; golden tests
  must cover update *sequences*, not just static renders.
- **Namespace lens scope creep** — "view the namespace" can balloon into
  a debugger; v1 is structure + leaf delegation, nothing more.
