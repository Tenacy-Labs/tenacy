# Independent code review — PR #24 stowage extraction

**Reviewed:** `feature/solver-extraction` at `f4af2d8fb7242c2bda531e7e7c8e0a26572f1cee` versus `origin/main` at `6e71f2ba0bab5ca647047a202f2f2958fae8b29b`  
**Verdict:** **REQUEST CHANGES** — 0 critical, 2 major, 3 minor.

The solver move itself is behavior-preserving: SHA-256 comparison confirmed that all eight files under `vendor/stowage/src/` are byte-identical to their former `origin/main:src/optimizer/` bodies. The package root contains every former runtime export, and manual inspection found every exported type represented. No hard-coded secrets, unsafe evaluation, command execution, network access, or new input-handling attack surface was found.

## Critical findings

None.

## Major findings

### M1 — Legacy shims and the package root instantiate two distinct module/type graphs

**Files:**
- `src/optimizer/cache-model.ts:2` (representative; the same defect is at line 2 of all eight shims)
- `vendor/stowage/package.json:12-14`
- `vendor/stowage/src/cache-model.ts:47-51`

Each compatibility shim re-exports a physical source path such as `../../vendor/stowage/src/cache-model.ts`, while the advertised package API resolves through `node_modules/@connectotron/stowage`. Bun and TypeScript do not canonicalize those two specifiers to one module identity. A consumer that incrementally adopts `@connectotron/stowage` while retaining any legacy kernel import gets two copies of every function/constant and, critically, two nominally incompatible `CacheModel` classes.

**Runtime reproduction from a clean install:**

```sh
bun -e 'import {CacheModel as Legacy} from "./src/optimizer/cache-model.ts"; import {CacheModel as Package, paramSetV1} from "@connectotron/stowage"; const x=new Legacy(paramSetV1("x").cache); console.log({sameConstructor:Legacy===Package,legacyInstance:x instanceof Legacy,packageInstance:x instanceof Package})'
```

Observed:

```text
{ sameConstructor: false, legacyInstance: true, packageInstance: false }
```

**Type-system reproduction:** add a temporary included file containing assignments between `CacheModel` imported from the two paths, then run `bunx tsc --noEmit -p tsconfig.json`. TypeScript reports both directions as `TS2322`, with:

```text
Types have separate declarations of a private property 'chain'.
```

This contradicts ADR-0002's package-boundary claim and makes the compatibility seam unsafe for mixed imports. Fix the shims to resolve through package exports (root named re-exports or explicit package subpath exports), so both old and new import surfaces load the same module graph. Add a compile-time and runtime identity regression test.

### M2 — Regenerating `bun.lock` upgrades unrelated production dependencies

**File:** `bun.lock:26-38,44-62,76`

The extraction also changes unrelated resolved versions despite no corresponding manifest edits:

- `@ai-sdk/anthropic` 4.0.40 → 4.0.41
- `@ai-sdk/openai` 4.0.45 → 4.0.46
- `@ai-sdk/openai-compatible` 3.0.34 → 3.0.35
- `@ai-sdk/xai` 4.0.42 → 4.0.43
- `@ai-sdk/provider-utils` 5.0.28 → 5.0.29
- `@ai-sdk/gateway` 4.0.60 → 4.0.62
- `ai` 7.0.74 → 7.0.77
- `@opentui/core` / `@opentui/react` and all native OpenTUI packages 0.5.6 → 0.5.7

**Reproduction:** `git diff origin/main...HEAD -- bun.lock` shows these resolution changes alongside the intended stowage entries.

These packages include provider protocol code and native UI binaries, so the PR is no longer a behavior-only solver relocation even though `package.json` only adds stowage. Existing tests do not prove unchanged live-provider/UI behavior across these upgrades. Preserve the `origin/main` resolutions and add only the stowage dependency graph, or split the dependency updates into a separately reviewed PR with explicit release-note and platform validation.

## Minor findings

### m1 — ADR and README describe a different dependency layout than the shipped snapshot

**Files:**
- `vendor/stowage/docs/adr/0002-solver-port.md:21-26,37-40`
- `vendor/stowage/README.md:52-57`
- `vendor/stowage/package.json:19-21`

ADR-0002 says stowage uses `file:vendor/knapsack`, calls the arrangement “dual vendoring,” and says the kernel shims re-export the package root. The shipped kernel snapshot instead rewrites the dependency to sibling `file:../knapsack`, prunes stowage's nested vendor, and has shims importing physical source files rather than the package root. Update the ADR/README to describe the actual deduplicated sibling layout and final shim design.

### m2 — Test-count documentation is stale

**Files:**
- `vendor/stowage/docs/adr/0002-solver-port.md:26-29`
- `vendor/stowage/README.md:54-57`

Both documents call 869 tests the acceptance suite; the reviewed tree runs 871. Update the count or avoid embedding a volatile count.

### m3 — Diff hygiene failure

**File:** `vendor/stowage/src/suffix.ts:53`

`git diff --check origin/main...HEAD` reports `new blank line at EOF`. Remove the extra blank line so the extraction remains byte/hygiene clean at the seam.

## Verification performed

On a clean archive of reviewed commit `f4af2d8` with Bun 1.3.14:

```text
bun install --frozen-lockfile  PASS (43 packages)
bunx tsc --noEmit             PASS (0 diagnostics)
bun test                       PASS (871/871; 6,765 expectations; 31 files)
```

GitHub PR #24 CI was also green at the reviewed head (`32684323198`), and the PR was reported mergeable. The parent workflow currently uses Bun `latest` and `bun install --frozen-lockfile || bun install` (`.github/workflows/ci.yml:13-16`), so it is weaker than the clean pinned local reproduction; nevertheless the current run passed.

Additional checks:

- all eight moved implementation files: byte-identical to `origin/main`
- package root runtime exports: complete
- package root type exports: complete by source inspection
- clean frozen install and runtime package import: pass
- security scan/manual review: no finding
- portability: Bun 1.3.14 local and Bun 1.4.0 Linux CI both pass; package intentionally exports TypeScript source and is therefore Bun/bundler-oriented, consistent with the documented Bun requirement
