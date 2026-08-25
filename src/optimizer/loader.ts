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
import { asReadOnlyBus } from "./bus.ts";

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
    const g = this.grants.grantsFor(plugin.name);  // frozen copy (C1)
    const ctx: PluginCtx = Object.freeze({
      pluginName: plugin.name,
      bus: asReadOnlyBus(this.bus),
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
    // C2 fix: the tracked promise NEVER rejects (no unhandled rejection can
    // crash the kernel); failure is captured in state and read at collect().
    const state = { failed: false, reason: undefined as unknown };
    const initPromise = (async () => {
      try {
        await plugin.init?.(ctx);
      } catch (e) {
        state.failed = true;
        state.reason = e;
      }
    })();
    this.#pending.push({ plugin, ctx, initPromise, state });
  }

  #pending: Array<{ plugin: Plugin; ctx: PluginCtx; initPromise: Promise<void>; state: { failed: boolean; reason: unknown } }> = [];

  /** Post-init wiring: bus subscription (M1: only when events granted). */
  #wire(plugin: Plugin): void {
    if (plugin.onEvent !== undefined && this.grants.grantsFor(plugin.name).events) {
      const fn = plugin.onEvent.bind(plugin);
      (fn as unknown as { pluginName?: string }).pluginName = plugin.name;
      this.bus.on("all", fn);
    }
  }

  /** Await all inits; failure drops the plugin (contained), never the kernel. */
  async collect(): Promise<LoadedPlugins> {
    const pending = this.#pending;
    this.#pending = [];
    await Promise.all(pending.map((p) => p.initPromise));
    const commands: CommandSpec[] = [];
    const lensFamilies: LensFamilySpec[] = [];
    const dropped: Array<{ name: string; reason: string }> = [];
    const active: string[] = [];
    for (const p of pending) {
      if (p.state.failed) {
        this.#ctxs.delete(p.plugin.name);
        dropped.push({ name: p.plugin.name, reason: `init failed: ${String(p.state.reason)}` });
        continue;
      }
      this.#wire(p.plugin);
      this.#plugins.push(p.plugin);
      try {
        if (p.plugin.commands !== undefined) commands.push(...p.plugin.commands());
        if (p.plugin.lenses !== undefined) lensFamilies.push(...p.plugin.lenses());
        active.push(p.plugin.name);
      } catch (e) {
        dropped.push({ name: p.plugin.name, reason: String(e) });
      }
    }
    return { commands, lensFamilies, dropped, active };
  }

  /** Post-boot: registration is closed. */
  ctxFor(name: string): PluginCtx | undefined { return this.#ctxs.get(name); }
}

/** Boot helper: grants + loader over a bus and loop hooks. */
export async function bootPlugins(
  bus: EventBus,
  hooks: LoopHooks,
  plugins: Plugin[],
  grants?: (r: GrantRegistry) => void,
): Promise<{ loader: PluginLoader; loaded: LoadedPlugins }> {
  const registry = new GrantRegistry();
  grants?.(registry);
  const loader = new PluginLoader(bus, registry, hooks);
  for (const p of plugins) loader.register(p);
  const loaded = await loader.collect();
  return { loader, loaded };
}

export { NO_GRANTS };
