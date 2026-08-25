/**
 * Lens handles — ADR-0007 §2b/§2e. The uniform manipulation protocol
 * every lens family exposes (debugger pattern): expand / focus / release /
 * watch / digest. Handles are frozen coordinator-side envelopes; every
 * method emits a SteeringIntent through the single-writer pipeline — a
 * handle never mutates store state itself ("signals not overrides").
 *
 * Op classes (0007 §2b doctrine):
 *   structural (expand/focus/release) — direct, idempotent
 *   economic   (watch)                — solver-overruled signal
 *   capability (patch/replace/append) — journaled world-writes, granted only
 *
 * Writability is a TYPE-LEVEL capability (0007 §2e): FileHandle carries no
 * mutation methods; WritableFileHandle extends it. The cell gate rejects
 * mutation calls on read-only handles statically.
 */

/** Where handle methods send their intents (the loop's steering queue). */
export type IntentSink = (intent: Record<string, unknown>) => { op: string; ok: boolean; result: string };

/** Uniform protocol — mandatory for every lens family (0007 §2b). */
export abstract class LensHandle {
  constructor(
    public readonly id: string,
    public readonly substrate: string,
    protected sink: IntentSink,
  ) {}

  abstract expand(sel: unknown): { ok: boolean; result: string };
  abstract focus(sel: unknown): { ok: boolean; result: string };
  abstract release(sel: unknown): { ok: boolean; result: string };

  /** Economic op: solver may overrule (churn revocation). */
  watch(mode: "live" | "polled" | "frozen"): { ok: boolean; result: string } {
    return this.sink({ op: "ctx.watch", id: this.id, mode });
  }

  /** Content digest (cache chain). Families override for cheap hashing. */
  digest(): string { return this.id; }
}

/** Read-only file handle (default). No mutation surface exists on it. */
export class FileHandle extends LensHandle {
  constructor(public readonly path: string, sink: IntentSink) {
    super(`lens:${path}`, "files", sink);
  }
  expand(sel: { from: number; to: number }) {
    return this.sink({ op: "files.expand", target: this.path, from: sel.from, to: sel.to });
  }
  focus(sel: { from: number; to: number }) {
    return this.expand(sel);
  }
  release(sel: { from: number; to: number }) {
    return this.sink({ op: "files.release", target: this.path, from: sel.from, to: sel.to });
  }
}

/** Granted rw handle (0007 §2e): patch / replace / append. */
export class WritableFileHandle extends FileHandle {
  /** Structured patch: ordered exact-match replaces, applied atomically. */
  patch(patch: Array<{ from: string; to: string }>) {
    return this.sink({ op: "files.patch", target: this.path, patch });
  }
  /** Exact-match-or-fail single replace (must match exactly once). */
  replace(from: string, to: string) {
    return this.sink({ op: "files.replace", target: this.path, from, to });
  }
  append(text: string) {
    return this.sink({ op: "files.append", target: this.path, text });
  }
}

/** The handle registry — what lenses.ns renders; materialization ledger. */
export class HandleRegistry {
  #handles = new Map<string, LensHandle>();

  materialize(h: LensHandle): LensHandle {
    this.#handles.set(h.id, h);
    return h;
  }
  get(id: string): LensHandle | undefined { return this.#handles.get(id); }
  entries(): Array<{ id: string; substrate: string }> {
    return [...this.#handles.values()].map((h) => ({ id: h.id, substrate: h.substrate }));
  }
  get size(): number { return this.#handles.size; }
}
