.PHONY: help install test typecheck check bench repl tui task \
        maxsuite postanalysis gauges corpus-run corpus-run-live \
        cli-corpus cli-reports cli-refit cli-synthetic clean

export PATH := $(HOME)/.bun/bin:$(PATH)

# Absolute path: survive shells whose PATH lacks ~/.bun/bin
BUN := $(shell command -v bun 2>/dev/null || echo "$(HOME)/.bun/bin/bun")

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies (bun)
	$(BUN) install

typecheck: ## tsc --noEmit (CI gate)
	$(BUN) x tsc --noEmit

test: ## Run test suite
	$(BUN) test

check: typecheck test ## Typecheck + tests (local CI parity)

bench: ## Runtime benchmark
	$(BUN) bench/bench.ts

# ── interactive surfaces ────────────────────────────────────────────────

repl: ## Interactive REPL (offline mock provider)
	$(BUN) src/ui/repl.ts

repl-live: ## Interactive REPL, live provider: make repl-live P=zai M=glm-5.2
	$(BUN) src/ui/repl.ts $(P) $(M)

tui: ## OpenTUI pane interface
	$(BUN) src/ui/tui.tsx

task: ## One live agentic task, coordinator-verified: make task P=zai M=glm-5.2
	$(BUN) src/analysis/task.ts $(if $(P),$(P),zai) $(M)

# ── corpus / optimizer benchmarks ─────────────────────────────────────

maxsuite: ## Run max bench suite -> dumps/maxsuite.json
	$(BUN) bench/corpus/maxsuite.ts

postanalysis: ## Post-analyze maxsuite -> console + maxsuite-report.md
	$(BUN) bench/corpus/postanalysis.ts

gauges: ## Gauges baseline runner
	$(BUN) bench/corpus/gauges-baseline.ts

corpus-run: ## Scripted/mock corpus run (CI, deterministic)
	$(BUN) bench/corpus/run.ts

corpus-run-live: ## Live corpus run: make corpus-run-live P=zai
	$(BUN) bench/corpus/run.ts --live $(P)

# ── analysis CLI (ADR-0003 offline mirror) ─────────────────────────────

LEDGER ?= /tmp/agent-kernel-live-task.jsonl

cli-corpus: ## Corpus card: make cli-corpus L=<ledger.jsonl...>
	$(BUN) src/analysis/cli.ts corpus $(L)

cli-reports: ## All six reports: make cli-reports L=<ledger.jsonl...>
	$(BUN) src/analysis/cli.ts reports $(L)

cli-refit: ## Refit diagnostics: make cli-refit L=<ledger.jsonl...>
	$(BUN) src/analysis/cli.ts refit $(L)

cli-synthetic: ## Synthetic generator validation
	$(BUN) src/analysis/cli.ts synthetic

clean: ## Remove transient artifacts (dumps kept)
	rm -f /tmp/agent-kernel-live-task.jsonl
