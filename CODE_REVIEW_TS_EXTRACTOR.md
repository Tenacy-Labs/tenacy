# Adversarial Merge-Gate Review — feat/ts-compiler-extractor

Gate: fresh-context adversarial review per house protocol.
Scope: `feat/native-tool-calls..feat/ts-compiler-extractor` (commits 303f5be, 6b51bd9) in agent-kernel.
Method: every blocker finding below is PROVEN by a probe run from /tmp (repo left clean); observed output pasted verbatim.

## 0. Scope verification (claim: "ts-extractor.ts is the ONLY changed file")

`git diff feat/native-tool-calls..feat/ts-compiler-extractor --stat` shows 4 files
(ts-extractor.ts, tui.tsx, test/optimizer.test.ts, vendor cache-model.ts) — but per-commit
`--stat` shows each commit touches ONLY src/optimizer/ts-extractor.ts. Explanation (verified
via merge-base): the branches DIVERGED. Merge-base is 8d0db8e; feat/ts-compiler-extractor is
2 ahead / 1 BEHIND — it does not contain fb32f4d (virtual head block). The extra files in the
relative diff are fb32f4d's changes shown in reverse, not out-of-scope edits.
**Finding (topology, MAJOR-adjanged → MINOR): merging this branch into feat/native-tool-calls
is a clean fast-forward-less merge, but the branch is missing fb32f4d. Merge direction and
rebase must be conscious of this. No code conflict expected (disjoint files).**

## 1. Build gates (ACTUAL counts, run by this gate)

- `bun x tsc --noEmit -p tsconfig.json` → exit 0, zero errors. ✅ matches claim.
- `bun test` → **956 pass, 0 fail, 9922 expect() calls, 44 files, 24.46s**. ✅ matches claim (956/956).
- BUT: `grep -rn "ts-extractor" test/` → no references. **The new module ships with ZERO test
  coverage.** "956/956 pass" is true only because nothing exercises the new code. (See M4.)

## 2. Verified positive paths (own probes)

- String-lookalike comments do NOT misattach (probe 6a/6b, probe 1e):
  `console.log("/** fake doc */"); class Q {}` → Q has no doc. `const s = "*/ ..."` before class → no crash, no attach.
- Empty doc `/** */` → `undefined` (probe 1g). ✅
- Nested block comment `/* outer /* inner */ */` → summary "outer /* inner", sane, no crash (probe 1f). ✅
- Diamond hierarchy: no duplicate lines (seen-set works; probe 4B). ✅
- Inheritance cycle `X extends Y, Y extends X`: terminates cleanly in 291ms, no hang (probe 4C). ✅
- Private never inherited; own overrides win by name — property `foo` in subclass correctly
  shadows base method `foo` (probe 4D). ✅
- Missing file / missing class → graceful sentinel strings, no throw (probe 4E). ✅
- Performance: `renderInterfaceResolved` cold (Program over 102 tsconfig files) = **185–285ms**.
  Acceptable for documented on-demand use. ✅
- File-header doc: header + imports + class layout attaches header to first declaration (probe 1c/1d);
  no double-count when the import itself carries a doc — single doc, no crash. ✅
- `#private` excluded, `private` excluded by default and included with `includePrivate` (probe 1k/3). ✅
- Constructor param-properties abbreviated (`constructor(name, age?)`) as claimed. ✅

## 3. NEW FINDINGS

### MAJOR-1 — Inherited members misattributed to the immediate base class
`src/optimizer/ts-extractor.ts:254-270`. Attribution uses `baseSym.getName()` of the collected
base type, but `checker.getPropertiesOfType(base)` returns members declared TRANSITIVELY —
grandparent members get labeled with the child-most base walked.

Probe (chain `C extends B extends A`, `alpha`/`pA` declared in A):
```
interface C {
  gamma(): void;
  ↖ inherited from B: beta(): void;
    /** From B. */
  ↖ inherited from B: alpha(): void;      ← declared in A, doc says "From A."
    /** From A. */
  ↖ inherited from B: pA(): void;         ← declared in A
}
```
Deep chain (L5→…→L0): `↖ inherited from L4: m0(): void;` — m0 is declared in L0, four levels up.
The commit message's proof ("FileLensItem renders 23 inherited Lens members") used a SINGLE-level
chain (CodeLensItem extends Lens), which cannot expose this; actual count on that target is 21, not 23.
Fix sketch (5 lines): attribute from the property's declaring node — walk `decl.parent` to the
enclosing class declaration and use its name, instead of the walked base type's symbol.

### MAJOR-2 — `renderInterfaceResolved` silently degrades when CWD ≠ repo root
`src/optimizer/ts-extractor.ts:212-216`: `ts.readConfigFile("./tsconfig.json", …)` is CWD-relative
and `raw.error` is discarded.

Probe run from /tmp (importing repo code by absolute path):
```
CWD is: /private/tmp
readConfigFile error: {"messageText":"Cannot read file './tsconfig.json'.","category":1,"code":5083}
config: {}
parsed fileNames: 13          ← 13 scratch /tmp files, default compiler options
renderInterfaceResolved inherited count from /tmp: 21   ← worked BY LUCK
```
No throw, no sentinel — the function silently builds a Program over whatever `.ts` files happen
to be in the CWD with DEFAULT options (strict flags, paths, aliases all gone). It produced correct
output here only because code-lens.ts's imports resolve without project config. Any file relying on
`paths`/importsNotUsedAsValues/target-specific syntax will resolve differently or fail from a
non-repo CWD — a landmine for tests and REPL use, exactly as suspected.
Fix sketch: `ts.findConfigFile(path.dirname(path.resolve(entryPath)), ts.sys.fileExists)` with a
fallback to CWD, and return the `⟨…⟩` sentinel when no config is found rather than proceeding on `{}`.

### MAJOR-3 — `extract()` symbol-table semantics massively diverge from HeuristicTsExtractor
`src/optimizer/ts-extractor.ts:73-75, 106-124`. `#decl` never descends into class members, so the
compiler extractor emits top-level declarations only, while the heuristic extractor anchors
methods/fields at one-indent depth. Same file, both extractors (probe 2):
```
code-lens.ts     — heuristic 39 syms, compiler 4 syms   (35 only-in-heuristic)
lens.ts          — heuristic 59 syms, compiler 4 syms   (56 only-in-heuristic)
ts-extractor.ts  — heuristic 110 syms, compiler 15 syms (95 only-in-heuristic)
```
`CodeLensItem` anchoring probe (6c): with the compiler extractor, `expandSymbol("alpha")` on a
class method resolves to NOTHING (`selected resolvable — alpha: false`), and the structure digest
changes (114 → 71 chars) — swapping extractors invalidates every code-lens digest and silently
drops method-level selections. Nothing in src/ or test/ wires TsCompilerExtractor in yet, so this
is latent, not live — but the module's stated purpose is drop-in behind `SymbolExtractor`. Also:
the compiler extractor adds destructured binding names (`[a]`, `{ x }`) as symbols the heuristic
never had, and tags enums as `const`. Either extract class members (matching v1 semantics) or
document loudly that the swap is anchoring-breaking.

### MAJOR-4 — Zero test coverage for the new module
`grep -rn "ts-extractor" test/` → no matches. All 277 lines — the regex doc harvest, header
attachment, interface projection, and checker walk — ship untested; "956/956" exercises none of
it. Every finding in this review was found by probes that would have been one-line `test()`
blocks. This is the branch's quality gate hole, and MAJOR-1 proves it bit.

### MINOR-1 — `harvestLeadingComment` docstring contradicts behavior (blank-line adjacency)
`src/optimizer/ts-extractor.ts:60-64` claims "Returns undefined when … the block is not
immediately adjacent (blank line between comment and code)". Probe 1b:
`/** doc for B */\n\nclass B {}` → doc **attaches** (`summary: "doc for B"`). The regex
`/(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*)\s*$/` happily crosses blank lines. The behavior is arguably
desirable (header + blank + class is common) — fix the docstring, or tighten the regex if
strict adjacency is intended.

### MINOR-2 — Line comments harvested as docs with `//` prefixes left in the text
`stripLines` (ts-extractor.ts:25-29) strips `*` decorations but not `//`. Probe 1c:
```
// Copyright 2026 ACME
// Do not redistribute
```
harvests as `summary: "// Do not redistribute"`. `@license` headers likewise leak the raw tag
(probe 1h: `summary: "@license MIT"`). Cosmetic, but the doc text rendered into interface views
will contain literal `//`.

### MINOR-3 — `static` and `abstract` members render as plain instance members
`signatureOf` (ts-extractor.ts:138-159) ignores static/abstract/async/readonly modifiers.
Probe 3: `abstract speak(): void;` → rendered `speak(): void;` (concrete); `static kind = "animal"`
and `static factory(): Animal` render as instance members of the interface. Misleading surface
for the "subclass contract" view. (Setter accessors are also silently dropped — `set legs(n)` —
only `get` is handled; and all overload signatures render as duplicate lines.)

### MINOR-4 — Claim drift in commit message
"full 23-member inherited Lens surface" — observed 21 inherited lines for CodeLensItem.
Consistent with MAJOR-1 (single-level proof).

## 4. Verdict

The positive paths genuinely work and the adversarial regex inputs (strings containing `*/`,
nested comments, prose `@param`, empty docs, license banners) produce no crashes and no wrong
attachments. But the flagship feature of commit 2 — inherited-member projection — misattributes
every member declared above the immediate base (M1, proven), the checker path silently degrades
outside the repo CWD (M2, proven), the drop-in claim for `SymbolExtractor` is anchoring-breaking
as shipped (M3, proven), and none of it is covered by a single test (M4). All fixes are small
and localized.

**VERDICT: REQUEST_CHANGES**

Required before merge:
1. Fix M1 (declare-site attribution) — 5-line fix.
2. Fix M2 (findConfigFile from entryPath dir; sentinel on missing config; don't swallow raw.error).
3. Add tests for ts-extractor.ts covering at minimum: M1's chain case, M2's CWD case, header
   attachment, and the regex adversarial inputs from §2.
4. Resolve M3 either by extracting class members in `extract()` or by documenting the swap as
   anchoring-breaking (doc-only acceptable if the extractor stays unwired).

— adversarial gate, 2026-08-26. Probes: /tmp/tsprobe1.ts … /tmp/tsprobe6.ts (+ tsprobe4-setup.ts, tsprobe5.ts).
