/**
 * Namespace mounting — ADR-0007 §2. The curated top-level layout
 * (lenses / ctx / ops / rlm) as non-configurable, non-enumerable
 * globalThis bindings. Curation is the point: a namespace is real
 * estate, and new top-level names are ADR-worthy.
 *
 * The mount does NOT expose coordinator internals to cells. It exposes
 * the handle envelopes: lenses.* gives handle objects whose methods
 * emit intents. The ns lens renders this layout (0002d); lenses.ns is
 * non-deletable (0007 §2) — the RLM must always see what it holds.
 */
import { FileHandle, WritableFileHandle, HandleRegistry, type LensHandle, type IntentSink } from "./handles.ts";
import type { SteeringIntent } from "./intents.ts";

export interface NsMountOptions {
  /** The intent sink (loop's steering executor). */
  sink: IntentSink;
  /** Paths granted writable (prefix match). Empty = no writable handles. */
  writableRoots?: string[];
}

/** The mounted namespace. `lenses` is non-deletable by construction. */
export interface MountedNamespace {
  lenses: { files: { open(path: string, opts?: { mode?: "ro" | "rw" }): LensHandle } };
  registry: HandleRegistry;
}

export function mountNamespace(opts: NsMountOptions): MountedNamespace {
  const registry = new HandleRegistry();
  const writable = opts.writableRoots ?? [];

  const isWritable = (path: string) => writable.some((r) => path.startsWith(r));

  const lenses = {
    files: {
      open(path: string, o?: { mode?: "ro" | "rw" }): LensHandle {
        const h = (o?.mode === "rw" && isWritable(path))
          ? new WritableFileHandle(path, opts.sink)
          : new FileHandle(path, opts.sink);
        return registry.materialize(h);
      },
    },
  };

  // Non-configurable + non-enumerable: no delete, no redefinition.
  const g = globalThis as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries({ lenses })) {
    if (!(k in g)) {
      Object.defineProperty(g, k, { value: v, configurable: false, enumerable: false, writable: false });
    }
  }

  return { lenses, registry };
}
