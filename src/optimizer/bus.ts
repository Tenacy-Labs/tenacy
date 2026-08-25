/**
 * Kernel event bus — ADR-0007 substrate. The loop's emission surface:
 * typed events at the seams (steering drain, turn boundary, model call,
 * render), consumed by plugins (OTel exporter, ACP/OpenCode adapters,
 * DAP facade) and nothing else. The loop stays ignorant of consumers.
 *
 * Design constraints (ADR-0001 + ADR-0007):
 *   - No-op cost when empty: `bus.emit` with zero subscribers does an
 *     object lookup and a short loop — nothing more.
 *   - Consumer errors NEVER propagate into the loop: a throwing plugin
 *     logs and is skipped (the agent must not die because telemetry
 *     went down). Errors surface through the diagnostics event.
 *   - No async emission on the hot path: consumers receive events at
 *     the turn boundary via their own drain, or synchronously if they
 *     registered sync. v1: synchronous dispatch, ordered, in-process.
 *   - One stream, typed variants. Filtered subscriptions by event kind
 *     are a map lookup, not a scan.
 */
import type { PluginEvent } from "./events.ts";

export type Listener = (ev: PluginEvent) => void;

export class EventBus {
  #listeners = new Map<PluginEvent["kind"], Set<Listener>>();
  #all: Set<Listener> = new Set();
  #emitted = 0;

  /** Subscribe to one kind (or "all"). Returns an unsubscribe function. */
  on(kind: PluginEvent["kind"] | "all", fn: Listener): () => void {
    if (kind === "all") {
      this.#all.add(fn);
      return () => { this.#all.delete(fn); };
    }
    let set = this.#listeners.get(kind);
    if (set === undefined) { set = new Set(); this.#listeners.set(kind, set); }
    set.add(fn);
    return () => { set.delete(fn); };
  }

  /** Ordered synchronous dispatch. Listener errors are contained. */
  emit(ev: PluginEvent): void {
    this.#emitted++;
    for (const fn of this.#all) {
      try { fn(ev); } catch (e) { this.#diag(fn, e); }
    }
    const set = this.#listeners.get(ev.kind);
    if (set !== undefined) {
      for (const fn of set) {
        try { fn(ev); } catch (e) { this.#diag(fn, e); }
      }
    }
  }

  /** Total events emitted (diagnostics). */
  get emitted(): number { return this.#emitted; }

  #diag(fn: Listener, e: unknown): void {
    // Containment logging — never throw from emit itself.
    const name = (fn as { pluginName?: string }).pluginName ?? "listener";
    console.error(`[bus] listener ${name} threw: ${String(e)}`);
  }
}

/** Singleton-free wiring: the loop owns its bus; plugins receive it via ctx. */
export function makeEventBus(): EventBus { return new EventBus(); }

/** The subscribe-only facade handed to plugins. No emit. */
export interface ReadOnlyBus {
  on(kind: PluginEvent["kind"] | "all", fn: Listener): () => void;
}

/** N1 fix: `on` is grant-gated — plugins without the events grant subscribe to
 *  nothing (the unsubscribe function is a no-op). */
export function asReadOnlyBus(bus: EventBus, eventsGranted: () => boolean): ReadOnlyBus {
  return Object.freeze({
    on: (k: PluginEvent["kind"] | "all", f: Listener) => {
      if (!eventsGranted()) return () => {};
      return bus.on(k, f);
    },
  });
}
