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
  lenses: {
    files: {
      /** Read-only open (default): the returned handle's type carries NO
       *  mutation methods — the cell gate rejects them statically (C3c). */
      open(path: string, opts?: { mode?: "ro" }): FileHandle;
      /** Granted writable open: returns the mutation-bearing subtype. */
      open(path: string, opts: { mode: "rw" }): WritableFileHandle;
    };
  };
  registry: HandleRegistry;
}

export function mountNamespace(opts: NsMountOptions): MountedNamespace {
  const registry = new HandleRegistry();
  const writable = opts.writableRoots ?? [];

  // C3b fix: lexical path normalization — resolve '.', '..', and redundant
  // separators, then compare resolved component lists. Rejects traversal
  // ('/tmp/../etc') and sibling prefixes ('/tmporary') outright.
  const resolvePath = (p: string): string[] => {
    const parts = p.split("/");
    const out: string[] = [];
    for (const part of parts) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        if (out.length === 0) throw new Error(`path escapes root: ${p}`);
        out.pop();
        continue;
      }
      out.push(part);
    }
    return out;
  };
  const isWritable = (path: string): boolean => {
    try {
      const pc = resolvePath(path);
      if (pc.length === 0) return false;
      return writable.some((r) => {
        const rc = resolvePath(r);
        if (rc.length === 0 || rc.length > pc.length) return false;
        return rc.every((seg, i) => pc[i] === seg);
      });
    } catch {
      return false;
    }
  };

  const filesNs = {
    open(path: string, o?: { mode?: "ro" | "rw" }): FileHandle | WritableFileHandle {
      const h: FileHandle = (o?.mode === "rw" && isWritable(path))
        ? new WritableFileHandle(path, opts.sink)
        : new FileHandle(path, opts.sink);
      registry.materialize(h);
      return h;
    },
  };
  const lenses: MountedNamespace["lenses"] = {
    files: filesNs as unknown as MountedNamespace["lenses"]["files"],
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
