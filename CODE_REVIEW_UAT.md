# Code Review — feature/loop-milestone → main (uat merge gate)

- **Date:** 2026-08-21
- **Reviewers:** Three scoped fresh-context subagents (core optimizer / security & credentials / analysis & tests), dispatched 16:26; findings consolidated and verified by the orchestrator after all three hit the 600s delegation wall mid-writeup. First wave (single reviewer, 16:10) contributed the duplicate-err-id crash probe.
- **Scope:** full diff vs main — 91 files, ~8,200 insertions; branch tip under review `7143c95` (fixes below included).
- **Method:** transcript mining + independent re-run of every probe (findings accepted only with reproduced evidence); every fix verified fail-under-revert before landing.

## Critical (all resolved)

1. **Duplicate error-evidence ids crash `run()`** — `err:{turn}:{op}` collides in `store.add` when the same op fails twice in one turn (retry loops, repeated probes); threw out of `run()`. Fixed: monotonic `failedIntents` counter in the id, both journaling sites (`421719f`). Discriminating regression test verified to fail under the old scheme.
2. **`loadHarnessConfig` accepted `providers: null`** — `typeof null === "object"` passes the guard; downstream `cfg.providers[name]` throws raw `TypeError`. Arrays also slipped through. Fixed: null/array rejected like any malformed file (`7143c95`). Verified fail-under-revert.

## Major (resolved)

3. **Blank-tier credential masking** — empty-string env var (or config `model: ""`) defeated the `??` chain because `""` is defined; a valid config-file key or `defaultModel` was masked by a blank earlier tier. Fixed: blank treated as unset at every tier; explicit > env > file preserved (`7143c95`). Regression test pins `AGENT_KERNEL_CONFIG` at a tmp config so the real `agents/config.json` cannot mask the behavior.

## Minor (documented / backlog)

4. **`valueDensity ≥ 0` test could not fail** — non-negativity is structural. Hardened: `mean > 0` for a passing task with rendered tokens + `perTurn.length` assertion (`7143c95`).
5. **`invalidateUpstream` is dead code in v1** — exported, called nowhere; descendants unreachable (no reverse DAG edges). No action for this merge; revisit when the first real invalidation consumer lands (0002d lens invalidation).
6. **Solver header comment says "mean-variance placement"** — superseded by ADR-0005 (knapsack characterization). Docs-only; fold into the next docs commit rather than churning history.

## Security verdict: clean

No credential value reaches any log line, ledger record, error message, or journaled string — traced through `registry.ts`, `harness-config.ts`, `anthropic.ts`, `live.ts`, `task.ts`; probe D silent-pass. Error strings name the *env var*, never the value. `agents/config.json` gitignored, chmod 600, value never in chat or commits.

## Honest limitations of this review

- All three reviewers were wall-clock limited before writing their final reports; this document consolidates their *verified* probe evidence, not their (unwritten) full narratives. Two probe families they started but did not finish — placement-digest-vs-renderer consistency, synthetic-generator determinism audit — remain partially unexercised; the shipped tests cover both behaviors but an adversarial second pass would not hurt as a backlog item.
- The core reviewer's final suspect list (beyond items above) died at the wall; its reading notes surfaced no further confirmed defects, but "no further findings" is weaker evidence than a completed report.

**Gate status:** criticals resolved and verified; majors resolved; minors documented. Suite 57/57, tsc strictest clean, CI green at `7143c95`. Cleared to merge by the standing gate.
