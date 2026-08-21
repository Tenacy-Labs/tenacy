# agent-kernel — Design

A persistent TypeScript/JavaScript kernel for LLM agents. The agent does not dispatch
discrete tool calls; it executes code in a long-lived kernel whose namespace persists
across turns — trading context-window tokens for addressable, queryable state.

## Lineage

The design descends from three sources, taking concepts (not code) from each:

| Source | What we took |
|---|---|
| **prime-agent** (PrimeIntellect) | The RLM concept: a persistent kernel as the agent's hands, host-injected ops as its trust boundary, per-turn state persistence |
| **jcode** | Session physics: fast boot, low per-session memory, sessions as cheap contexts; cross-session memory as a first-class concern |
| **Bun / JavaScriptCore** | The runtime bet: one language across host and kernel, so the kernel boundary is a function call, not a network protocol |

### The key simplification

prime-agent's host (TypeScript) talks to its kernel (Python) over the Jupyter messaging
protocol: ZeroMQ, HMAC signing, connection files, and a control-channel deadlock
workaround. A JS host with a JS kernel deletes that entire layer — the kernel boundary
collapses from *network protocol* to *function call*. No venv management, no bootstrap
markers, no comm-target routing. Skills are plain ESM modules loaded with `await import()`.

### Why not the alternatives (decision log)

- **Rust kernel (evcxr)** — feasible via the protocol boundary but slower end-to-end:
  cells cost hundreds of ms; no namespace serializer exists; skills degrade to compiled
  crates; and the interpreter was never the bottleneck (LLM latency is). Prototype
  estimated at 2–4 weeks, production at months — for negative expected return.
- **PyPy kernel** — wrong workload shape: short-lived cells defeat a tracing JIT, and
  the cpyext tax applies to the numeric stack it would exist to serve.
- **Python control plane + Rust compute (rustimport/PyO3)** — the right answer for
  *scientific* workloads on an existing Python kernel; not the right chassis for this
  harness.
- **Node** — viable, but ~40% slower process spawn, heavier idle RSS, and no
  single-binary distribution. Bun's JavaScriptCore also tiers up to JIT faster, which
  suits many-short-cells workloads.
- **Rust host + deno_core** — the graduation path, deliberately kept open: keep the
  kernel interface narrow (`ops.*`) so it can port. Not needed at MVP scale.

## Architecture (current prototype)

```
Harness (Bun, TypeScript)
└── Kernel (per session)
    ├── eval(src)          — indirect eval in global scope; globals persist across cells
    ├── journal.jsonl      — append per turn (~50µs): {i, ts, src} — AUDIT ONLY
    ├── snapshot.json      — atomic commit per turn (tmp + rename)
    └── namespace harvest  — new globals recorded; live values refreshed at snapshot
```

Measured on M4 Max (Bun 1.3.14): turn cost 0.2ms small-state / 9.3ms with a ~5MB
namespace; recovery 5.5ms; session spawn+state-load 11.7ms; ~6–7MB marginal RSS per
session holding ~1MB live state; turn dispatch through a worker boundary 54µs median.
See `bench/` and `docs/benchmarks.md`.

## Persistence invariants (the heart of the design)

These are enforced in code and tested, not aspirations:

1. **Never replay journal cells — not as primary recovery, not as fallback, not at all.**
   Replay re-executes side effects. A cell that appends to a file would append twice;
   a cell that charges an API would charge twice. Amnesia is recoverable (the agent can
   re-derive); duplication is not (errors may go unnoticed). There is no code path
   anywhere that executes journal entries.
2. **The snapshot is the sole recovery source.** Journal is a readable historical
   record — after total persistence failure it tells the agent what it did, and the
   agent rebuilds deliberately if it cares to.
3. **Snapshot commit is atomic** (write tmp + rename): the snapshot file is never
   half-written.
4. **Snapshots read LIVE values from global scope.** Values captured at binding time
   go stale — a counter bound at 0 and incremented 266,649 times must snapshot as
   266,649. (This was a real bug caught by testing.)
5. **Non-serializable values become explicit tombstones** (`{__dead: true, note}`),
   visible in the namespace after recovery. The model *sees* what it lost; nothing is
   silently dropped or silently re-executed.

### Honest limits

- **Crash window:** a crash in the sub-10ms gap between a side effect firing and its
  snapshot commit can still pair with a re-run of that same cell — at-most-once per
  window, the practical ceiling without transactional side effects. Exposure is one
  cell in milliseconds, not the session.
- **Closures capture by re-derivation:** functions serialize as source; closed-over
  bindings revive via snapshot data on the second pass. Cycles and exotic objects
  (ArrayBuffer, class instances) tombstone conservatively.
- **One kernel owns the process.** Namespace harvest keys off global scope. Multiple
  kernels per process (worker-per-session) is the bench/ shape, but persistence assumes
  one namespace per process.

## Lessons baked into the tests

- **Recovery must be tested in a genuinely fresh process.** In-process recovery tests
  false-pass: the old session's globals are still present, so the harvest logic sees
  "nothing new" and the test proves nothing. `test/fresh-recovery.ts` exists for this
  reason and is spawned as a child by the suite.
- **`JSON.stringify` applies `Date.toJSON` before any replacer runs** — a replacer
  never sees a Date instance. Serialization therefore uses a pre-encode walk
  (`preEncode`) instead of a replacer; Map/Set/Date/RegExp are tagged plain objects.
- **Cross-test global pollution:** `var a` in one test is a pre-existing global to the
  next kernel in the same process. Test cells use unique variable names.

## Roadmap

### TypeScript cell gate (implemented)

Bun executes TypeScript modules by stripping types; it has no type-checking
mode, and `eval("const x: number = 1")` reaches JavaScriptCore unchanged and
throws. Agent cells therefore use `src/cell-compiler.ts`, a persistent
in-memory TypeScript LanguageService:

1. append the candidate to the successful source history in a virtual script;
2. run strict syntactic + semantic diagnostics;
3. reject before execution on any error (structured TS code/message/line/col);
4. transpile only the current cell to JavaScript in-process;
5. execute generated JS, while journaling the original TS only;
6. on recovery, rebuild static history from accepted journal source without
   executing it (never-replay remains absolute).

Measured on Bun 1.3.14 / M4 Max over 50 accumulating cells: first check 131ms,
first transpile 6ms; warm check median 50.8ms / p95 57.0ms; warm transpile
median 0.47ms. This is material versus raw eval but negligible beside a model
call, and it supplies the error-correction signal an RLM needs.

`tsc` is the type/static-analysis gate. ESLint is deliberately not in the
inline critical path: it primarily adds style and policy checks, not stronger
type correctness. It can be added later as an asynchronous policy pass.

- [ ] Agent loop: model calls, tool-call parsing, turn dispatch into the kernel
- [ ] `ops.*` host surface: `ops.rlm_spawn`, `ops.goal_set`, `ops.memory_search` —
      credentials and providers stay host-side (prime-agent's trust boundary)
- [ ] rlm(): child agents with typed handles and usage attribution
- [ ] Worker-per-session isolation + hibernation (idle sessions serialize to disk)
- [ ] Semantic session memory (jcode concept) backed by bun:sqlite
- [ ] Graduation path: if scale demands, port the ops surface to a Rust host on
      deno_core — the narrow interface is the insurance policy
