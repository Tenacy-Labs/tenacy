# Concurrency: the shared namespace under multiple agents

## The problem (RLM-specific)

Agents do not just call functions — they *mutate the kernel itself*: adding
bindings, renaming, refactoring. Turns are separated by model-call gaps of
seconds. JavaScript gives us run-to-completion atomicity for synchronous code,
so classic data races on the namespace cannot happen *within* a cell. The real
hazards are semantic:

1. **Lost update.** Agent A reads namespace@v5 and asks its model for a change.
   During the call, agent B commits v6 (renames `helper` → `helper2`). A's next
   cell commits against stale assumptions and silently clobbers B's rename.
   No exception is thrown; the kernel is simply corrupted.
2. **Write-after-return.** A cell fires `fetch().then(x => ns.result = x)`.
   The callback runs *after* the turn ended, interleaving arbitrarily with
   other agents' turns — ambient mutation with no commit, no version, no audit.
3. **Divergent replicas.** If each worker holds a copy of the shared namespace,
   copies drift. There is no merge machinery in a snapshot.

## The discipline (src/commons.ts)

jcode's documented stance, mapped from files to bindings — *"optimistic by
default, no locks; conflicts prompt the involved agents to communicate
directly"*:

- **Single writer.** All mutations apply in `commit()` on the coordinator's
  thread. Workers hold *private* namespaces (scratch + private functions);
  only commits cross the boundary. One thread mutates ⇒ no torn state, ever.
- **Turn-scoped, versioned commits.** Every read carries the namespace
  version it observed. A commit is a *batch* of writes with a base version;
  the coordinator compares (CAS). Interleaving since the base ⇒ the commit is
  rejected with the specific conflicting names. The receipt's version is the
  safe retry base. No locks held across model calls (they would be held for
  seconds — deadlock-shaped).
- **Renames are atomic batches.** `{helper2: set, helper: delete}` in one
  commit: no observer can see both or neither (single-writer + one version
  bump per commit).
- **No write-after-return.** Async results arrive as *data* — interrupts,
  mail, commit receipts — never as ambient namespace writes from `.then()`
  callbacks. The `.then()` posts; the owning agent commits.
- **Code-shift notifications.** Every reader of a binding is interrupted when
  that binding changes (jcode: "B edited a file A read → notify A; A ignores
  or inspects"). Notifications drain at safe points (turn start), like the
  swarm inbox.

## What this buys us

- Functions cross the boundary as source (`fn.toString()`), revive as
  callables — equality by source, not identity (same trick as snapshots).
- The CAS version is cheap: an integer compare per commit.
- Retry is mechanical: re-read at receipt version, re-derive the plan, commit.
  For renames, the conflict names tell the agent *what moved* — enough to
  re-target without a full re-plan.

## Residual exposures (honest)

- **Retry storms** are possible if many agents hammer the same names. jcode's
  answer is social (DM the other agent); ours can be mechanical (backoff) but
  is not implemented.
- **Semantic conflicts that CAS cannot see**: two agents writing *different*
  names is always allowed; if the functions are semantically coupled, only
  the code-shift notifications give the agents a chance to reconcile.
- **Mid-cell awaits**: a cell with `await` yields the event loop; another
  agent's commit can land *inside* the cell. The discipline still holds —
  the cell's eventual commit carries its base version, so the CAS catches
  the interleaving — but the cell's intermediate reads may be stale. Agents
  should treat post-await namespace state as unverified until re-read.
