# AGENTS.md

Working instructions for coding agents (and humans) in this repository.

## Toolchain

- **Bun** (>= 1.1) — runtime, test runner, package manager. Lives at `~/.bun/bin` (export it if `bun` is not on PATH).
- **make** — task runner; `make help` lists all targets.
- **TypeScript strict mode.** `tsc --noEmit` is THE static-analysis gate. ESLint is deliberately absent (see `docs/design.md`).
- Dependencies: `@tenacy-labs/stowage` is a git dependency pinned to an upstream tag (`github:Tenacy-Labs/stowage#vX.Y.Z`); `@tenacy-labs/knapsack` is reached only transitively through stowage. Consume both by package specifier, package root only — never subpaths or deep paths (pinned by `test/vendor-seam.test.ts`).

## One-time setup

```sh
bun install   # resolves deps incl. the @tenacy-labs git pins; creates node_modules at root only
```

## Git hooks — install before your first commit

Quality gates run as local git hooks. CI runs the same commands, so a blocked
commit/push locally is a saved red build remotely.

| Hook | Gate | Runs | Blocks |
|---|---|---|---|
| `pre-commit` | static type check | `make typecheck` (`tsc --noEmit`) | commits that introduce type errors |
| `pre-push` | unit + integration tests | `make test` (`bun test` — full offline suite) | pushes with failing tests |

Install both (idempotent — safe to re-run):

```sh
HOOKS="$(git rev-parse --git-path hooks)"

cat > "$HOOKS/pre-commit" <<'EOF'
#!/bin/sh
# Static type check before every commit: tsc --noEmit (repo's only linter).
export PATH="$HOME/.bun/bin:$PATH"
exec make typecheck
EOF

cat > "$HOOKS/pre-push" <<'EOF'
#!/bin/sh
# Unit + integration tests before every push: full offline bun suite.
export PATH="$HOME/.bun/bin:$PATH"
exec make test
EOF

chmod +x "$HOOKS/pre-commit" "$HOOKS/pre-push"
```

Hooks live under `.git`, so they are per clone — re-run this block in every
fresh clone or linked worktree.

### Verify the install

```sh
sh "$(git rev-parse --git-path hooks)/pre-commit"          # exit 0 — clean typecheck
printf '\nconst _hookCheck: string = 1;\n' >> src/optimizer/items.ts
sh "$(git rev-parse --git-path hooks)/pre-commit"          # exit 2 — error caught
git checkout -- src/optimizer/items.ts                     # revert the probe
```

### Operating notes

- Emergency bypass: `git commit --no-verify` / `git push --no-verify`. Use
  sparingly — CI (`bunx tsc --noEmit` + `bun test`) runs the same gates.
- Known toolchain quirk: Bun 1.2.5/darwin ignores the `timeout` option of
 `Bun.spawn`/`Bun.spawnSync`, and worker `process.exit` is asynchronous. Both
 are worked around in-repo (`shellRunner`'s shell-side watchdog; the swarm
 worker's exit interception) — no tests are exempt from the gates.
- Live-provider surfaces (`make task`, `make corpus-run-live`) are manual and
  never part of hooks or CI.
