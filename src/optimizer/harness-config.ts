/**
 * Harness local configuration — provider keys the harness can read.
 *
 * File: agents/config.json (gitignored; chmod 600) or AGENT_KERNEL_CONFIG
 * env override. Resolution order for a provider credential:
 *   explicit opts > env var > harness config file.
 * Keys never enter code, ledgers, or chat.
 */
export interface HarnessProviderConfig {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
}

export interface HarnessConfig {
  version: number;
  providers: Record<string, HarnessProviderConfig>;
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
    return parsed;
  } catch {
    return null;
  }
}
