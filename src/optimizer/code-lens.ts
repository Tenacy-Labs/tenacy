/**
 * Code-on-disk lens — ADR-0002d §4. Symbol-anchored ranges: selections
 * bind to symbol NAMES, not line numbers. An edit that shifts lines does
 * not invalidate a lens focused on an untouched symbol — source text is
 * re-resolved from current content at render time; unchanged symbols
 * render byte-identical, so their digests and cache survive.
 *
 * The SymbolExtractor is an interface (0003 T4 spirit: buy the commodity
 * later): heuristic v1 is deterministic regex over TS/JS surface syntax;
 * tree-sitter slots in without touching the lens or the solver.
 */
import { Lens } from "./lens.ts";
import { opt } from "./items.ts";
import { estTokens } from "./renderer.ts";

export interface CodeSymbol {
  name: string;
  kind: "function" | "class" | "method" | "const" | "interface" | "type" | "field";
  /** Line range in the CURRENT content, 1-indexed inclusive. */
  startLine: number;
  endLine: number;
}

export interface SymbolExtractor {
  extract(content: string): CodeSymbol[];
}

/**
 * Heuristic TS/JS extractor v1 — deterministic. Top-level declarations
 * anchor a symbol; a symbol extends until the next top-level anchor.
 * Methods/fields anchor at one-indent depth. Good enough to prove the
 * anchoring property; tree-sitter replaces it behind the same interface.
 */
export class HeuristicTsExtractor implements SymbolExtractor {
  extract(content: string): CodeSymbol[] {
    const lines = content.split("\n");
    const syms: CodeSymbol[] = [];
    const topRe =
      /^\s*(?:export\s+)?(?:default\s+)?(async\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/;
    const methodRe = /^ {1,4}(?:async\s+)?(?:get\s+|set\s+|static\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const m = topRe.exec(line);
      if (m !== null) {
        const kw = /function/.test(line) ? "function" : /class/.test(line) ? "class" : /interface/.test(line) ? "interface" : /type/.test(line) ? "type" : "const";
        syms.push({ name: m[2]!, kind: kw as CodeSymbol["kind"], startLine: i + 1, endLine: i + 1 });
        continue;
      }
      const mm = methodRe.exec(line);
      if (mm !== null && syms.length > 0) {
        syms.push({ name: mm[1]!, kind: "method", startLine: i + 1, endLine: i + 1 });
      }
    }
    // close ranges: each symbol extends to the line before the next symbol
    for (let s = 0; s < syms.length; s++) {
      const next = syms[s + 1];
      syms[s]!.endLine = next === undefined ? lines.length : Math.max(syms[s]!.startLine, next.startLine - 1);
    }
    return syms;
  }
}

/**
 * CodeLensItem — selections are symbol NAMES (the anchor). The base-class
 * `ranges` field carries pseudo index-ranges over the symbol listing only
 * for empty-checks and serialization compat; the durable state is
 * `selected` (names), resolved against the CURRENT symbol table on every
 * render. mtime/content change → re-extract → symbol diff: only symbols
 * whose bytes changed render differently.
 */
export class CodeLensItem extends Lens {
  /** Selected symbol names — the durable anchor (ADR-0002d §4). */
  selected: string[] = [];
  private tableCache: { content: string; syms: CodeSymbol[] } | null = null;

  constructor(
    id: string,
    target: string,
    public content: string,                // current source (producer-supplied)
    public extractor: SymbolExtractor = new HeuristicTsExtractor(),
    immutable = false,
    upstreams: readonly string[] = [],
    hazardOverride?: number,
    valueBump?: { amount: number; untilTurn: number },
    watch: "live" | "polled" | "frozen" = "polled",
    lastRender?: { position: number; digest: string },
    lastTouchTurn = 0,
    createdTurn = 0,
  ) {
    super(id, target, immutable, upstreams, hazardOverride, valueBump, watch, lastRender, lastTouchTurn, createdTurn);
  }

  protected substrateTag(): string { return "code"; }

  /** Current symbol table — cached per content identity. */
  symbolTable(): CodeSymbol[] {
    if (this.tableCache === null || this.tableCache.content !== this.content) {
      this.tableCache = { content: this.content, syms: this.extractor.extract(this.content) };
    }
    return this.tableCache.syms;
  }

  /** Structure projection: sorted listing lines, one per symbol. */
  listingLines(): string[] {
    return this.symbolTable().map((s) => `${s.name}  ${s.kind}  ${s.startLine}-${s.endLine}`);
  }

  override extentLines(): number | undefined { return this.symbolTable().length; }

  // ── symbol algebra: listing indices at call time, names durable ────────

  expandSymbol(name: string): boolean {
    if (this.selected.includes(name)) return true;   // idempotent re-expand
    this.selected.push(name);
    this.#syncRanges();
    return true;
  }

  releaseSymbol(name: string): boolean {
    const before = this.selected.length;
    this.selected = this.selected.filter((n) => n !== name);
    this.#syncRanges();
    return this.selected.length < before;
  }

  /** Base-algebra bridge: expand over listing indices resolves to names. */
  override expand(from: number, to: number): void {
    const syms = this.symbolTable();
    for (let i = from - 1; i < to && i < syms.length; i++) {
      const s = syms[i];
      if (s !== undefined) this.expandSymbol(s.name);
    }
    this.#syncRanges();
  }

  override release(from: number, to: number): void {
    const syms = this.symbolTable();
    for (let i = from - 1; i < to && i < syms.length; i++) {
      const s = syms[i];
      if (s !== undefined) this.releaseSymbol(s.name);
    }
    this.#syncRanges();
  }

  #syncRanges(): void {
    // pseudo-ranges [1..n] purely so the base empty-check and session
    // serializer see selection state; names are the truth.
    this.ranges = this.selected.length === 0 ? [] : [[1, this.selected.length]];
  }

  protected sliceRange(_a: number, _b: number): string {
    // Content projection: selected symbols' CURRENT source, name-anchored.
    const lines = this.content.split("\n");
    const table = this.symbolTable();
    const parts: string[] = [];
    for (const name of this.selected) {
      const s = table.find((t) => t.name === name);
      if (s === undefined) {
        parts.push(`${name}| ⟨symbol no longer present⟩`);
        continue;
      }
      const body = lines.slice(s.startLine - 1, s.endLine).join("\n");
      parts.push(`${name}| ${body}`);
    }
    return parts.join("\n...\n");
  }

  override serialize(): string { return this.fullText(); }

  /** Listing projection as a cheap structure option (0002d §3 pattern). */
  structureText(): string {
    return `⟨code ${this.target}: ${this.symbolTable().length} symbol(s)⟩\n` +
      this.listingLines().map((l, i) => `${i + 1}| ${l}`).join("\n");
  }
}
