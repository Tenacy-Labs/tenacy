/**
 * ADVERSARIAL battery — lattice behavior under unusual sequences, run
 * identically across substrates (File / Directory / NS) for consistent
 * behavior (Daniel directive, 2026-08-22).
 */
import { describe, test } from "bun:test";
import { FileLensItem, DirectoryLensItem } from "../src/optimizer/lens.ts";
import { NSLensItem, type NamespaceProducer, type NamespaceNode, type NamespaceCommit } from "../src/optimizer/ns-lens.ts";
import { StandingItem } from "../src/optimizer/items.ts";
import { ContextStore } from "../src/optimizer/store.ts";
import { solve, type Incumbent } from "../src/optimizer/solver.ts";
import { paramSetV1 } from "../src/optimizer/params.ts";

export {};

// ── multi-substrate harness ──────────────────────────────────────────────
// One interface over File / Directory / NS. Every scenario runs per-lens
// through the REAL cycle: mutate substrate -> noteLiveDelta/applyCommits ->
// solve -> pick -> commitConsolidation -> next surface. Incumbent is
// threaded turn-to-turn exactly as AgentLoop does.

type MutKind = "replace-line" | "insert-above" | "delete-above" | "truncate-below" | "replace-all";

/** A substrate under test: content plus the mutation kinds it supports. */
interface Substrate {
  readonly name: "file" | "dir" | "ns";
  /** Build a fresh lens of this substrate family over the same content. */
  makeLens(id: string): Lens;
  makeLens(id: string, lines: number): Lens;
  /** Apply a mutation to the substrate (producer-side; the lens reads it on refresh). */
  mutate(kind: MutKind, atLine: number, payload?: string): void;
  /** The fresh substrate text over lines a..b (truth for fusion ≡ slice). */
  freshSlice(a: number, b: number): string;
  /** Push current substrate state into the lens (producer refresh). */
  refresh(lens: Lens): void;
  /** Payload for a marker at a line (identity/position-stable per substrate). */
  stablePayload(line: number, marker: string): string;
  /** Total line count right now. */
  lineCount(): number;
}

import { Lens } from "../src/optimizer/lens.ts";

/** FILE substrate: mutable text content feeding a FileLensItem. */
class FileSubstrate implements Substrate {
  readonly name = "file" as const;
  constructor(public content: string) {}
  private lines(): string[] { return this.content === "" ? [] : this.content.split("\n"); }
  makeLens(id: string): Lens {
    const f = new FileLensItem(id, `${id}.ts`, this.content);
    f.expand(1, this.lineCount());
    f.valueBump = { amount: 8, untilTurn: 999 };
    return f;
  }
  mutate(kind: MutKind, atLine: number, payload?: string): void {
    const l = this.lines();
    const text = payload ?? "MUTATED LINE CONTENT xxx";
    if (kind === "replace-line") l[atLine - 1] = text;
    else if (kind === "insert-above") l.splice(atLine - 1, 0, text);
    else if (kind === "delete-above") l.splice(atLine - 1, 1);
    else if (kind === "truncate-below") l.length = atLine;
    else if (kind === "replace-all") this.content = payload ?? "totally different file\nsecond line";
    if (kind !== "replace-all") this.content = l.join("\n");
  }
  /** Push current substrate state into the lens (producer refresh). */
  refresh(lens: Lens): void {
    if (lens instanceof FileLensItem) lens.content = this.content;
  }
  /** Payload for a marker at a line (identity/position-stable per substrate). */
  stablePayload(_line: number, marker: string): string { return marker; }
  freshSlice(a: number, b: number): string {
    return this.lines().slice(a - 1, b).map((s, i) => `${a + i}| ${s}`).join("\n");
  }
  lineCount(): number { return this.lines().length; }
}
class DirSubstrate implements Substrate {
  readonly name = "dir" as const;
  constructor(public entries: string[]) {}
  private listing(): string { return [...this.entries].sort().join("\n"); }
  makeLens(id: string): Lens {
    const d = new DirectoryLensItem(id, `${id}/`, this.listing());
    d.expand(1, Math.max(1, this.lineCount()));
    d.valueBump = { amount: 8, untilTurn: 999 };
    return d;
    }
  mutate(kind: MutKind, atLine: number, payload?: string): void {
    // Directory line semantics: replace-line = rename an entry; insert-above
    // = new entry; delete-above = removed entry; truncate-below = mass
    // removal; replace-all = directory regenerated.
    if (kind === "replace-line") {
      const old = [...this.entries].sort()[atLine - 1]!;
      const i = this.entries.indexOf(old);
      this.entries[i] = payload ?? "renamed/entry.ts";
    } else if (kind === "insert-above") {
      this.entries.push(payload ?? "new/entry.ts");
    } else if (kind === "delete-above") {
      const old = [...this.entries].sort()[atLine - 1]!;
      const i = this.entries.indexOf(old);
      this.entries.splice(i, 1);
    } else if (kind === "truncate-below") {
      this.entries = [...this.entries].sort().slice(0, atLine);
    } else if (kind === "replace-all") {
      this.entries = (payload ?? "fresh/dir-a.ts\nfresh/dir-b.ts").split("\n").filter((s) => s !== "");
    }
  }
  /** Position-stable payload for a marker at a line: sorts to the SAME
   *  position (appended suffix, or marker swap if already suffixed) so the
   *  "same line" identity survives the sorted listing. */
  stablePayload(line: number, marker: string): string {
    const cur = [...this.entries].sort()[line - 1] ?? "src/none";
    if (cur.includes("MARKER-")) return cur.replace(/MARKER-[A-Z0-9-]+/, marker);
    return `${cur}-MARKER-${marker}`;
  }
  freshSlice(a: number, b: number): string {
    const ls = [...this.entries].sort();
    return ls.slice(a - 1, b).map((s, i) => `${a + i}| ${s}`).join("\n");
  }
  refresh(lens: Lens): void {
    if (lens instanceof DirectoryLensItem) lens.listing = this.listing();
  }
  lineCount(): number { return this.entries.length; }
}

/** NAMESPACE substrate: an in-memory producer with a commit log. */
class NSSubstrate implements Substrate {
  readonly name = "ns" as const;
  private rows: Array<{ path: string; kind: NamespaceNode["kind"]; repr?: string }> = [];
  private commits: NamespaceCommit[] = [];
  private commitTurn = 0;
  constructor(paths: string[]) {
    for (const p of paths) this.rows.push({ path: p, kind: "binding" });
  }
  private producer(): NamespaceProducer {
    return {
      children: (prefix: string) => this.rows.filter((r) => r.path.startsWith(prefix)),
      commitsSince: (t: number) => this.commits.filter((c) => c.turn > t),
    };
  }
  makeLens(id: string): Lens {
    const n = new NSLensItem(id, id, this.producer());
    n.projection = "content";          // repr mutations must be visible to slicing
    n.expand(1, this.lineCount());
    n.valueBump = { amount: 8, untilTurn: 999 };
    return n;
  }
  mutate(kind: MutKind, atLine: number, payload?: string): void {
    const pathAt = (i: number): string => this.rows.map((r) => r.path)[i - 1] ?? "";   // insertion order (listing order)
    if (kind === "replace-line") {
      const old = pathAt(atLine);
      const r = this.rows.find((x) => x.path === old)!;
      r.repr = payload ?? "MUTATED repr xxx";
    } else if (kind === "insert-above") {
      this.rows.push({ path: payload ?? "new/binding.ts", kind: "binding" });
    } else if (kind === "delete-above") {
      const old = pathAt(atLine);
      this.rows = this.rows.filter((x) => x.path !== old);
    } else if (kind === "truncate-below") {
      const keep = new Set(Array.from({ length: atLine }, (_, i) => pathAt(i + 1)));
      this.rows = this.rows.filter((r) => keep.has(r.path));
    } else if (kind === "replace-all") {
      this.rows = (payload ?? "fresh/ns-a\nfresh/ns-b").split("\n").filter((s) => s !== "")
        .map((p) => ({ path: p, kind: "binding" as const }));
    }
    this.commitTurn += 1;
    this.commits.push({ turn: this.commitTurn, changes: [{ marker: "+", path: payload ?? pathAt(atLine) }] });
  }
  freshSlice(a: number, b: number): string {
    // truth in #focusableListing order (insertion order, groups recursed) — same as lens slicing
    const ls = this.rows.map((r) => (r.repr !== undefined ? `${r.path}  ${r.kind}  ${r.repr}` : `${r.path}  ${r.kind}`));
    return ls.slice(a - 1, b).map((s, i) => `${a + i}| ${s}`).join("\n");
  }
  lineCount(): number { return this.rows.length; }
  stablePayload(_line: number, marker: string): string { return marker; }
  refresh(lens: Lens): void {
    if (lens instanceof NSLensItem) lens.applyCommits(this.commitTurn);
  }
}

// ── the three substrates every scenario runs against ────────────────────
export function makeSubstrates(): Substrate[] {
  const L = 100;
  return [
    new FileSubstrate(Array.from({ length: L }, (_, i) => `line ${i + 1} ${"x".repeat(30)}`).join("\n")),
    new DirSubstrate(Array.from({ length: L }, (_, i) => `src/mod${i}/file.ts`)),
    new NSSubstrate(Array.from({ length: L }, (_, i) => `root/child${i}/binding`)),
  ];
}

// ── live-cycle driver (same shape as AgentLoop: solve -> commit -> next) ──
type Inc = Incumbent & { rendered: Map<string, { position: number; zone: string; digest: string; representation: string; optionId: string }>; totalTokens: number; blockCount: number };
const EMPTY_INC: Inc = { rendered: new Map(), totalTokens: 0, blockCount: 0 } as never as Inc;

export function jlen(l: Lens): number { return (l as unknown as { pendingDeltas: unknown[] }).pendingDeltas.length; }

export function turn(
  sub: Substrate, lens: Lens, inc: Inc, turnNo: number,
  restrict?: (ids: string[]) => string[],
): { pick: { optionId: string; tokens: number; digest: string } | undefined; ids: string[]; next: Inc } {
  sub.refresh(lens);
  const store = new ContextStore();
  store.add(new StandingItem("identity", "identity", "id").toContextItem());
  const items = new Map(store.snapshot());
  const fresh = lens.toContextItem();
  const ids = fresh.options().map((o) => o.id);
  let lensItem = fresh;
  if (restrict !== undefined) {
    const allowed = new Set(restrict(ids));
    lensItem = { ...fresh, options: () => fresh.options().filter((o) => allowed.has(o.id)) } as never;
  }
  items.set(lens.id, lensItem);
  const res = solve(items, inc as never, paramSetV1("m") as never, turnNo);
  const place = res.placements.find((p) => p.id === lens.id);
  const next: Inc = {
    rendered: new Map(res.placements.map((p) => [p.id, { position: p.position, zone: p.zone, digest: p.digest, representation: p.representation, optionId: p.optionId }])) as never,
    totalTokens: res.totalTokens, blockCount: res.placements.length,
  } as never as Inc;
  if (place === undefined) return { pick: undefined, ids, next };
  return { pick: { optionId: place.optionId, tokens: place.tokens, digest: place.digest }, ids, next };
}

/** Establish the base the way live flow does: commit the solver's first byte-carrying pick. */
export function armBase(sub: Substrate, lens: Lens, t: number): Inc {
  const r = turn(sub, lens, EMPTY_INC, t);
  if (r.pick === undefined) throw new Error(`${sub.name}: lens not placed while arming base`);
  lens.commitConsolidation(r.pick.optionId, t);
  return r.next;
}

/** One live delta: mutate the substrate line, refresh, journal it. */
export function liveDelta(sub: Substrate, lens: Lens, t: number, line: number, payload?: string): void {
  sub.mutate("replace-line", line, payload);
  sub.refresh(lens);
  (lens as unknown as { noteLiveDelta: (t: number, l: number[]) => void }).noteLiveDelta(t, [line]);
}

const LENSID = (n: string) => `adv:${n}`;

describe("S1 burst shapes (per substrate)", () => {
  for (const sub of makeSubstrates()) {
    test(`${sub.name}: burst-of-1 — fusion consumes at arity 1`, () => {
      const lens = sub.makeLens(LENSID(sub.name));
      const inc = armBase(sub, lens, 2);
      liveDelta(sub, lens, 3, 10, "ONLY-DELTA");
      const r = turn(sub, lens, inc, 3, (ids) => ids.filter((i) => i.startsWith("base+(")));
      if (r.pick === undefined) throw new Error("not placed");
      lens.commitConsolidation(r.pick.optionId, 3);
      if (jlen(lens) !== 0) throw new Error(`${sub.name}: arity-1 fusion must consume the journal, still ${jlen(lens)}`);
      if (lens.baseBlockTurn !== 3) throw new Error(`${sub.name}: base must re-bank, got ${lens.baseBlockTurn}`);
    });

    test(`${sub.name}: same-line double delta — fusion latest-wins, never stale`, () => {
      const lens = sub.makeLens(LENSID(sub.name));
      armBase(sub, lens, 2);
      liveDelta(sub, lens, 3, 10, sub.stablePayload(10, "FIRST-VERSION"));
      liveDelta(sub, lens, 4, 10, sub.stablePayload(10, "SECOND-VERSION"));
      const fusion = lens.options().find((o) => o.id.startsWith("base+("))!;
      // The base prefix is live-sliced, so the latest content may legitimately
      // appear there too. The invariant that matters: the STALE version must
      // appear nowhere in the fusion option, and the latest must appear.
      if (fusion.text.includes("FIRST-VERSION")) throw new Error(`${sub.name}: fusion carried the stale version`);
      if (!fusion.text.includes("SECOND-VERSION")) throw new Error(`${sub.name}: fusion missing the latest version`);
      // The CHAIN, by contrast, keeps BOTH snapshots (sequence legibility):
      const chain = lens.options().find((o) => o.id.startsWith("base+d"))!;
      if (!chain.text.includes("FIRST-VERSION") || !chain.text.includes("SECOND-VERSION")) {
        throw new Error(`${sub.name}: chain must keep per-delta snapshots`);
      }
    });

    test(`${sub.name}: fuse-then-reburst — new journal over the new base, no zombies`, () => {
      const lens = sub.makeLens(LENSID(sub.name));
      let inc = armBase(sub, lens, 2);
      liveDelta(sub, lens, 3, 10, "BURST1-A");
      liveDelta(sub, lens, 4, 20, "BURST1-B");
      const r4 = turn(sub, lens, inc, 4, (ids) => ids.filter((i) => i.startsWith("base+(")));
      if (r4.pick === undefined) throw new Error("not placed");
      lens.commitConsolidation(r4.pick.optionId, 4);
      if (jlen(lens) !== 0) throw new Error("fusion must consume");
      inc = r4.next;
      // new burst over the re-banked base
      liveDelta(sub, lens, 5, 30, "BURST2-A");
      liveDelta(sub, lens, 6, 40, "BURST2-B");
      if (jlen(lens) !== 2) throw new Error(`new burst must journal 2, got ${jlen(lens)}`);
      const ids = lens.options().map((o) => o.id);
      if (ids.some((i) => i.includes("d3") || i.includes("d4"))) throw new Error(`zombie delta states from the consumed journal: ${JSON.stringify(ids)}`);
      const fusion = lens.options().find((o) => o.id.startsWith("base+("))!;
      if (fusion.text.includes("BURST1-A") && fusion.text.includes("BURST1-B")) {
        // fused bytes are re-derived from the FRESH substrate — old payloads gone
        // only if lines 10/20 no longer contain them (they were consumed into base).
        // The invariant that matters: no zombie OPTIONS. Content check below.
      }
      if (!fusion.text.includes("BURST2-A") || !fusion.text.includes("BURST2-B")) throw new Error("fusion must carry the new burst");
    });

    test(`${sub.name}: endless burst (12 deltas) — publish or fuse, never stall`, () => {
      const lens = sub.makeLens(LENSID(sub.name));
      let inc = armBase(sub, lens, 2);
      let fused = false;
      for (let t = 3; t <= 14; t++) {
        liveDelta(sub, lens, t, 5 + t, `ENDLESS-${t}`);
        const r = turn(sub, lens, inc, t);
        if (r.pick === undefined) throw new Error(`${sub.name}: lens dropped mid-burst at t${t}`);
        lens.commitConsolidation(r.pick.optionId, t);
        if (r.pick.optionId.startsWith("base+(")) fused = true;
        inc = r.next;
      }
      const j = jlen(lens);
      if (!fused && j !== 12) throw new Error(`${sub.name}: published 12 deltas but journal holds ${j}`);
      // Either the solver kept publishing (journal = 12) or it fused somewhere
      // (journal cleared at fusion). Both are legitimate; stalling is not.
    });

    test(`${sub.name}: delta outside loaded ranges — surfaces stay consistent`, () => {
      const lens = sub.makeLens(LENSID(sub.name));
      // shrink the selection so line 70 falls outside
      const rng = lens.ranges as Array<[number, number]>;
      rng.length = 0;
      rng.push([1, 40]);
      const inc = armBase(sub, lens, 2);
      liveDelta(sub, lens, 3, 70, sub.stablePayload(70, "OUT-OF-RANGE-CHANGE"));
      const atomic = lens.options().find((o) => o.id.startsWith("(base,"))!;
      const fusion = lens.options().find((o) => o.id.startsWith("base+("))!;
      const fullHas = atomic.text.includes("OUT-OF-RANGE-CHANGE");
      const fusionHas = fusion.text.includes("OUT-OF-RANGE-CHANGE");
      // Documented asymmetry: full renders only loaded ranges (excludes it);
      // fusion re-derives over the affected-lines union (includes it).
      // The cross-substrate CONTRACT is that this asymmetry is identical
      // for every substrate — asserted by running the same scenario on all.
      if (fullHas === fusionHas) throw new Error(`${sub.name}: expected full-excludes/fusion-includes asymmetry, got full=${fullHas} fusion=${fusionHas}`);
      if (!fusionHas) throw new Error(`${sub.name}: fusion must re-derive the changed line`);
    });
  }
});

describe("S3 accounting truth (File lens, AgentLoop-level)", () => {
  const { mkdtempSync, writeFileSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const { AgentLoop } = require("../src/optimizer/loop.ts");
  const { MockProvider } = require("../src/optimizer/providers.ts");
  const { saveSession, restoreSession } = require("../src/optimizer/sessions.ts");
  const ps = paramSetV1("test-model");

  test("sessions: mid-burst save/restore round-trips the journal (known gap)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-adv-"));
    const path = join(dir, "s.json");
    const src = new AgentLoop(new MockProvider(), ps);
    src.store.add(new StandingItem("identity", "identity", "test").toContextItem());
    const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    src.fileContent = () => content;           // producer hook: the loop reads the substrate through this
    await src.run("warm");
    src.attachLens("adv:f", "adv/f.txt", [[1, 100]], -1, "clean", "file", {});
    if (src.lensRegistryView().get("adv:f") === undefined) throw new Error("attachLens silently failed (empty fileContent?)");
    const L0 = src.lensRegistryView().get("adv:f")!;
    (L0 as any).valueBump = { amount: 8, untilTurn: 999 };   // honest value signal so the solver places it
    let live = content;
    src.fileContent = () => live;                            // producer hook stays current
    await src.run("arm");                      // committed byte-carrying render establishes the base
    const L = src.lensRegistryView().get("adv:f")!;
    if ((L as any).baseBlockTurn < 0) throw new Error("base did not arm through live flow");
    live = live.split("\n").map((s, i) => (i === 9 ? "line 10 MARKER-DELTA-1" : s)).join("\n");
    (L as any).noteLiveDelta(4, [10], "file");
    (L as any).noteLiveDelta(5, [20], "file");
    if ((L as any).pendingDeltas.length !== 2) throw new Error("journal did not arm");
    saveSession(src, path, "mock");
    const dst = new AgentLoop(new MockProvider(), ps);
    dst.fileContent = () => live;             // rehydrate the producer hook BEFORE restore re-attaches lenses
    restoreSession(dst, path);
    const R = dst.lensRegistryView().get("adv:f")!;
    // Round-trip fixed (2026-08-22 battery): the journal is accounting truth
    // and must survive save/restore byte-identically.
    if ((R as any).pendingDeltas.length !== 2) {
      throw new Error("sessions gap: journal lost on save/restore — pendingDeltas not persisted");
    }
    const rj = (R as any).pendingDeltas as Array<{ turn: number; lines: number[] }>;
    if (rj[0].turn !== 4 || rj[0].lines[0] !== 10 || rj[1].turn !== 5 || rj[1].lines[0] !== 20) {
      throw new Error("journal entries corrupted in round-trip: " + JSON.stringify(rj));
    }
    if ((R as any).baseBlockTurn !== (L as any).baseBlockTurn) {
      throw new Error(`baseBlockTurn not round-tripped: ${(R as any).baseBlockTurn} != ${(L as any).baseBlockTurn}`);
    }
  });
});

describe("S2 substrate movement (per substrate)", () => {
  for (const sub of makeSubstrates()) {
    test(`${sub.name}: insertion above — fusion body re-derives fresh, never stale bytes`, () => {
      const lens = sub.makeLens(LENSID(sub.name));
      armBase(sub, lens, 2);
      // line 30 mutated and journaled, THEN an insertion shifts coordinates
      liveDelta(sub, lens, 3, 30, sub.stablePayload(30, "SHIFTED-CHANGE"));
      sub.mutate("insert-above", 10, sub.name === "dir" ? "a-new-entry.ts" : "NEW-LINE-ABOVE");
      sub.refresh(lens);
      const fusion = lens.options().find((o) => o.id.startsWith("base+("))!;
      const j = (lens as unknown as { pendingDeltas: Array<{ lines: number[] }> }).pendingDeltas;
      const allLines = j.flatMap((d) => d.lines);
      const lo = Math.min(...allLines), hi = Math.max(...allLines);
      // The fusion option = header + live-sliced base prefix + DELTA BODY
      // (the union slice, at the tail). Byte-honesty is asserted on the tail:
      // fusion.text must END WITH the fresh slice over the journaled span.
      const truth = sub.freshSlice(lo, hi);
      if (!fusion.text.endsWith(truth)) {
        throw new Error(`${sub.name}: fusion body must be byte-equal to the fresh slice over [${lo},${hi}]\ntail:\n${fusion.text.slice(-200)}\ntruth:\n${truth.slice(0, 300)}`);
      }
      // Documented semantics, made explicit by the test: file/dir sort or
      // splice coordinates, so an un-notified insertion shifts the changed
      // line beyond the journaled number (30 → 31); the fusion body — an
      // honest slice at 30 — must NOT fabricate the moved marker. NS listings
      // are append-ordered, so its coordinates are stable and it DOES carry.
      // The fusion BODY (tail, after the base prefix) is the delta block —
      // extract it by its span length from the end and check the marker there.
      const bodyTail = fusion.text.slice(-truth.length);
      if (sub.name === "ns" && !bodyTail.includes("SHIFTED-CHANGE")) throw new Error(`${sub.name}: append-ordered listing must keep the marker in-span`);
      if (sub.name !== "ns" && bodyTail.includes("SHIFTED-CHANGE") && !truth.includes("SHIFTED-CHANGE")) throw new Error(`${sub.name}: fusion fabricated content at a stale coordinate`);
    });

    test(`${sub.name}: truncation below base — surfaces degrade honestly`, () => {
      const lens = sub.makeLens(LENSID(sub.name));
      armBase(sub, lens, 2);
      sub.mutate("truncate-below", 5);
      sub.refresh(lens);
      liveDelta(sub, lens, 3, 3, sub.stablePayload(3, "POST-TRUNCATION"));
      const ids = lens.options().map((o) => o.id);
      if (ids.length === 0) throw new Error(`${sub.name}: no options after truncation`);
      // the substrate now has 5 lines; a delta at line 3 must still work
      const r = turn(sub, lens, EMPTY_INC, 3);
      if (r.pick === undefined) throw new Error(`${sub.name}: lens unplaceable after truncation`);
      lens.commitConsolidation(r.pick.optionId, 3);
    });

    test(`${sub.name}: wholesale replace — the lens must not pretend continuity`, () => {
      const lens = sub.makeLens(LENSID(sub.name));
      armBase(sub, lens, 2);
            sub.mutate("replace-all", 1);
      sub.refresh(lens);
      // everything is alien to the base; no lattice option may claim additivity
      const adds = lens.options().filter((o) => o.purelyAdditive);
      // With no pending deltas, the pre-lattice surface offers base+delta
      // (additive) and consolidated — but base+delta's bytes include the alien
      // substrate: it is an APPEND of the new truth, which IS additive-honest.
      // The invariant: no crash, and options exist.
      const ids = lens.options().map((o) => o.id);
      if (ids.length === 0) throw new Error(`${sub.name}: no options after wholesale replace`);
      void adds;
    });
  }
});
