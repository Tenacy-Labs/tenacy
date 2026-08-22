/**
 * Harness local configuration — provider keys the harness can read.
 *
 * File: agents/config.json (gitignored; chmod 600) or AGENT_KERNEL_CONFIG
 * env override. Resolution order for a provider credential:
 *   explicit opts > env var > harness config file.
 * Keys never enter code, ledgers, or chat.
 */
import type { ParamSet } from "./params.ts";
import { paramSetV1 } from "./params.ts";

export interface HarnessProviderConfig {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
}

export interface HarnessConfig {
  version: number;
  providers: Record<string, HarnessProviderConfig>;
  /**
   * Optional context-window override (rendered-token budget Λ), in tokens.
   * When set to a positive number it replaces the paramSet default (24,000)
   * for every provider — the stress-test lever that forces the solver to
   * actively manage context (compact/purge instead of accumulate).
   */
  contextWindow?: number | undefined;
}

export function harnessConfigPath(): string {
  const override = process.env.AGENT_KERNEL_CONFIG;
  if (override !== undefined && override !== "") return override;
  return "agents/config.json";
}

export function loadHarnessConfig(path?: string | undefined): HarnessConfig | null {
  const p = path ?? harnessConfigPath();
  try {
    const raw = require("node:fs").readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as HarnessConfig;
    // Guard honestly: null passes typeof "object" (review finding B2) and
    // arrays are not provider maps. Both malformed shapes -> null, the
    // same honest answer as unreadable files.
    if (
      parsed?.providers === undefined || parsed?.providers === null ||
      Array.isArray(parsed.providers) || typeof parsed.providers !== "object"
    ) return null;
    // contextWindow: honest guard — only positive finite numbers survive.
    if (
      parsed.contextWindow !== undefined &&
      parsed.contextWindow !== null &&
      (typeof parsed.contextWindow !== "number" ||
       !Number.isFinite(parsed.contextWindow) ||
       !Number.isInteger(parsed.contextWindow) ||
       parsed.contextWindow <= 0)
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Build the ParamSet for a model with the harness config's context-window
 * override applied (if any). The single choke point every surface uses so
 * the override behaves identically in REPL, TUI, and task runner.
 */
export function paramSetFor(
  modelId: string,
  cfg: HarnessConfig | null,
): ParamSet {
  const ps = paramSetV1(modelId);
  if (cfg?.contextWindow !== undefined && cfg.contextWindow !== null && cfg.contextWindow > 0) {
    ps.budgetLambda = Math.floor(cfg.contextWindow);
  }
  return ps;
}
