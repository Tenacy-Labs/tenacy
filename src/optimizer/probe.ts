/**
 * Startup cache probe — measures, once per runtime, whether the provider
 * includes tool-definition tokens in the cached prefix (owner ruling
 * 2026-08-26: "build a startup probe into the app, once per runtime").
 *
 * Procedure (4 tiny calls):
 *   leg A: with tools    — call 1 (cold), call 2 (identical → warm hit)
 *   leg B: without tools — call 3 (cold), call 4 (identical → warm hit)
 * If warmA.cacheRead − warmB.cacheRead ≈ serialized tool tokens,
 * tools sit inside the cached prefix. The TUI consumes this to give the
 * tools entry a green/yellow chevron with measured backing.
 *
 * Honesty rules (A3): unreported counters → "inconclusive", never a guess.
 */
import type { ProviderWire } from "./registry.ts";

export interface CacheProbeResult {
  provider: string;
  /** measured: tools tokens are inside the cached prefix */
  toolsCached: boolean | null;   // null = inconclusive
  toolTokens: number;            // est. serialized tool-definition tokens
  hitWithTools: number | null;   // warm-leg cacheRead, with tools
  hitWithout: number | null;     // warm-leg cacheRead, without tools
  delta: number | null;          // hitWithTools - hitWithout
  note: string;
}

const PROBE_SYSTEM = "You are a cache calibration probe. Reply with the single word: ok";
const PROBE_USER = "ping";

export function toolTokensEstimate(serializedToolsChars: number): number {
  return Math.ceil(serializedToolsChars / 4);
}

/**
 * Run the probe against both wire legs. Memoized per runtime by the caller.
 */
export async function probeToolsCache(
  providerName: string,
  withTools: ProviderWire,
  bare: ProviderWire,
  opts: { toolTokens: number } = { toolTokens: 0 },
): Promise<CacheProbeResult> {
  const r: CacheProbeResult = {
    provider: providerName, toolsCached: null, toolTokens: opts.toolTokens,
    hitWithTools: null, hitWithout: null, delta: null, note: "",
  };
  try {
    await withTools(PROBE_SYSTEM, PROBE_USER);          // A1 cold
    const warmA = await withTools(PROBE_SYSTEM, PROBE_USER);  // A2 warm
    r.hitWithTools = warmA.usage.cacheRead ?? null;
  } catch (e) {
    r.note = `with-tools leg failed: ${String(e).slice(0, 120)}`;
    return r;
  }
  try {
    await bare(PROBE_SYSTEM, PROBE_USER);               // B1 cold
    const warmB = await bare(PROBE_SYSTEM, PROBE_USER); // B2 warm
    r.hitWithout = warmB.usage.cacheRead ?? null;
  } catch (e) {
    r.note = `bare leg failed: ${String(e).slice(0, 120)}`;
    return r;
  }
  if (r.hitWithTools === null || r.hitWithout === null) {
    r.note = "provider does not report cacheRead on both legs — inconclusive";
    return r;
  }
  r.delta = r.hitWithTools - r.hitWithout;
  // Tools are in the cached prefix when the with-tools warm hit exceeds the
  // bare warm hit by a meaningful margin (at least half the tool tokens —
  // providers may cache in coarse blocks).
  r.toolsCached = r.delta >= Math.max(64, r.toolTokens / 2);
  r.note = r.toolsCached
    ? `delta ${r.delta} ≥ tool tokens ${r.toolTokens}/2 — tools measured inside cached prefix`
    : `delta ${r.delta} < tool tokens ${r.toolTokens}/2 — tools not in cached prefix (or sub-block granularity)`;
  return r;
}
