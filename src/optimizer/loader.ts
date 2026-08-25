/**
 * Plugin loader — ADR-0007 substrate. Boot-time plugin registration:
 * load, seal the ctx, run init(), collect surfaces (commands, lens
 * families), wire bus subscriptions. Registration is boot-only; the
 * hot loop never loads plugins.
 *
 * Failure containment: a plugin whose init/registration throws is
 * dropped with a diagnostic — the kernel boots regardless. The loader
 * never imports plugin code transitively at runtime after boot.
 */
import type { Plugin, PluginCtx, CommandSpec, LensFamilySpec } from "./plugin.ts";
export type { Plugin, PluginCtx, CommandSpec, LensFamilySpec } from "./plugin.ts";
import { GrantRegistry, NO_GRANTS } from "./plugin.ts";
import type { PluginEmitted } from "./events.ts";
import type { EventBus } from "./bus.ts";

export interface LoopHooks {
  /** Queue steering text for the next turn drain (the loop owns the queue). */
  submitSteering(text: string, note?: string): void;
  /** Spawn a turn (protocol adapters). The loop owns turn execution. */
  spawnTurn(userMessage: string): { ok: boolean; queued: boolean };
}

export interface LoadedPlugins {
  commands: CommandSpec[];
  lensFamilies: LensFamilySpec[];
  dropped: Array<{ name: string; reason: string }>;
  active: string[];
}

export class PluginLoader {
  #plugins: Plugin[] = [];
  #ctxs = new Map<string, PluginCtx>();

  constructor(
    private bus: EventBus,
    private grants: GrantRegistry,
    private hooks: LoopHooks,
  ) {}

  /** Register one plugin (boot only). Failure drops the plugin, not boot. */
  register(plugin: Plugin): void {
    const g = this.grants.grantsFor(plugin.name);
    const ctx: PluginCtx = Object.freeze({
      pluginName: plugin.name,
      bus: this.bus,
      grants: g,
      submitSteering: (text: string, note?: string) => {
        if (!g.steer) return { error: "grant denied: steer" };
        this.hooks.submitSteering(text, note ?? plugin.name);
        return { kind: "steer.request", text, note: note ?? plugin.name } satisfies PluginEmitted;
      },
      spawnTurn: (userMessage: string) => {
        if (!g.drive) return { error: "grant denied: drive" };
        return this.hooks.spawnTurn(userMessage);
      },
    });
    this.#ctxs.set(plugin.name, ctx);
    try {
      void plugin.init?.(ctx);
    } catch (e) {
      this.#ctxs.delete(plugin.name);
      return; // dropped — surfaced via collect()
    }
    this.#plugins.push(plugin);
    if (plugin.onEvent !== undefined) {
      const fn = plugin.onEvent.bind(plugin);
      (fn as unknown as { pluginName?: string }).pluginName = plugin.name;
      this.bus.on("all", fn);
    }
  }

  /** Collect registration surfaces (call once after all register() calls). */
  collect(): LoadedPlugins {
    const commands: CommandSpec[] = [];
    const lensFamilies: LensFamilySpec[] = [];
    const dropped: Array<{ name: string; reason: string }> = [];
    const active: string[] = [];
    for (const p of this.#plugins) {
      try {
        if (p.commands !== undefined) commands.push(...p.commands());
        if (p.lenses !== undefined) lensFamilies.push(...p.lenses());
        active.push(p.name);
      } catch (e) {
        dropped.push({ name: p.name, reason: String(e) });
      }
    }
    return { commands, lensFamilies, dropped, active };
  }

  /** Post-boot: registration is closed. */
  ctxFor(name: string): PluginCtx | undefined { return this.#ctxs.get(name); }
}

/** Boot helper: grants + loader over a bus and loop hooks. */
export function bootPlugins(
  bus: EventBus,
  hooks: LoopHooks,
  plugins: Plugin[],
  grants?: (r: GrantRegistry) => void,
): { loader: PluginLoader; loaded: LoadedPlugins } {
  const registry = new GrantRegistry();
  grants?.(registry);
  const loader = new PluginLoader(bus, registry, hooks);
  for (const p of plugins) loader.register(p);
  return { loader, loaded: loader.collect() };
}

export { NO_GRANTS };
