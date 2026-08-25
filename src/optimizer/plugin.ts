/**
 * Plugin contract + grant registry — ADR-0007 substrate (extends the
 * ADR-0001 draft with the surfaces the 9-item capability list demands).
 *
 * Surfaces:
 *   onEvent(ev)   — general observer stream (bus)
 *   commands()    — slash-command registration (/goal, /advisor, …)
 *   lenses()      — lens-family registration (ADR-0007 §2c)
 *   ops()/types() — op stubs + ambient declarations (MCP class)
 *
 * Inbound (grant-scoped, PluginCtx): submitSteering, spawnTurn. A plugin
 * that bypasses its ctx to touch kernel internals is unsupported AND
 * detected (the loader seals the ctx; internals are module-private).
 * "Mediation bypass is theater" (ADR-0001 §4).
 */
import type { PluginEvent, PluginEmitted } from "./events.ts";
import type { EventBus } from "./bus.ts";
import type { ReadOnlyBus } from "./bus.ts";

/** Capability grants. Everything not granted is denied. */
export interface PluginGrants {
  /** Observe the event stream. */
  events: boolean;
  /** Submit steering (text into the next turn's drain). */
  steer: boolean;
  /** Spawn agent turns (protocol adapters: ACP, OpenCode). */
  drive: boolean;
  /** Register commands/lens families/ops — boot-time only. */
  register: boolean;
}

/** Frozen shared default. grantsFor() NEVER returns this instance — copy-on-read. */
export const NO_GRANTS: Readonly<PluginGrants> = Object.freeze({ events: false, steer: false, drive: false, register: false });

export interface CommandSpec {
  name: string;               // "goal" → /goal
  description: string;
  run: (args: string, ctx: PluginCtx) => Promise<string>;
}

export interface LensFamilySpec {
  readonly family: string;    // mounts as lenses.<family>
  readonly dts: string;       // ambient declaration for the cell gate (review-gated)
}

export interface Plugin {
  readonly name: string;
  /** Boot-time registration. Throwing here fails the plugin, not the kernel. */
  init?(ctx: PluginCtx): void | Promise<void>;
  onEvent?(ev: PluginEvent): void;
  commands?(): CommandSpec[];
  lenses?(): LensFamilySpec[];
}

/** The sealed inbound surface. Handle-shaped, never kernel-shaped. */
export interface PluginCtx {
  readonly pluginName: string;
  readonly bus: ReadOnlyBus;
  readonly grants: Readonly<PluginGrants>;
  /** Inbound: queue steering text for the next turn drain. Requires `steer`. */
  submitSteering(text: string, note?: string): PluginEmitted | { error: string };
  /** Inbound: spawn a turn (protocol adapters). Requires `drive`. */
  spawnTurn(userMessage: string): { ok: boolean; queued: boolean } | { error: string };
}

/** Grant registry — plugins are known by name; grants are explicit. */
export class GrantRegistry {
  #grants = new Map<string, PluginGrants>();
  grant(name: string, g: Partial<PluginGrants>): void {
    this.#grants.set(name, Object.freeze({ ...NO_GRANTS, ...g }));
  }
  /** Copy-on-read frozen grants (gate C1: the live object must never reach a plugin). */
  grantsFor(name: string): Readonly<PluginGrants> {
    const g = this.#grants.get(name);
    return g === undefined ? NO_GRANTS : Object.freeze({ ...g });
  }
}
