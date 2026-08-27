/**
 * TsCompilerExtractor — compiler-backed SymbolExtractor (ADR-0003 T4).
 * Parse-only (no Program/TypeChecker): cheap enough for per-render
 * re-anchoring. Buys real statement detection, doc harvesting, and
 * visibility over HeuristicTsExtractor v1.
 */
import * as ts from "typescript";
import type { CodeSymbol, SymbolExtractor } from "./code-lens.ts";

export type Visibility = "public" | "protected" | "private" | "#private";

export interface DocHarvest {
  summary: string | undefined;
  full: string | undefined;
  params: string[];
  returns: string | undefined;
}

export interface TsCodeSymbol extends CodeSymbol {
  visibility: Visibility;
  exported: boolean;
  doc: DocHarvest | undefined;
}

function stripLines(text: string): string[] {
  return text.split("\n")
    .map((l) => l
      .replace(/^\s*\/?\*+\/?/, "")
      .replace(/^\s*\/\/\s?/, "")            // line comments: strip '// ' (gate MINOR-2)
      .replace(/\s*\*\/$/, "")
      .trimEnd())
    .filter((l) => l.trim().length > 0);
}

/** Parse stripped doc lines into summary/full/params/returns. */
function parseDocLines(lines: string[]): DocHarvest | undefined {
  if (lines.length === 0) return undefined;
  const params: string[] = [];
  let returns: string | undefined;
  const content: string[] = [];
  for (const line of lines) {
    const t = line.trimStart();   // stripLines leaves the space after '*' —
    const pm = /^@[Pp]aram\s+(\S+)\s*(.*)$/.exec(t);
    if (pm !== null) { params.push(pm[2] ? `${pm[1]} — ${pm[2].trim()}` : pm[1]!); continue; }
    const rm = /^@[Rr]eturns?\s+(.*)$/.exec(t);
    if (rm !== null) { returns = rm[1]!.trim(); continue; }
    content.push(t);
  }
  return { summary: content[0], full: content.join("\n"), params, returns };
}

function harvestDoc(node: ts.Node): DocHarvest | undefined {
  const js = (ts as unknown as { getJSDocCommentsAndTags?: (n: ts.Node) => ts.JSDoc[] })
    .getJSDocCommentsAndTags?.(node) ?? [];
  if (js.length === 0) return undefined;
  return parseDocLines(stripLines(js.map((j) => j.getText()).join("\n")));
}

function visibilityOf(mods: readonly ts.Modifier[] | undefined): Visibility {
  if (mods?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)) return "private";
  if (mods?.some((m) => m.kind === ts.SyntaxKind.ProtectedKeyword)) return "protected";
  return "public";
}

/**
 * Harvest a contiguous leading comment block ending at (or shortly before,
 * across blank lines) `pos`. Blank-line separation is allowed on purpose —
 * header + blank + class is a common layout (gate MINOR-1: docstring now
 * matches behavior).
 */
function harvestLeadingComment(sf: ts.SourceFile, pos: number): DocHarvest | undefined {
  // Collect ALL contiguous trailing comment blocks/lines (a multi-line //
  // header is many single-line comments, not one block) — gate MINOR-2 fix.
  let text = sf.text.slice(0, Math.max(0, pos)).trimEnd();
  const blocks: string[] = [];
  for (;;) {
    const m = /(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*)\s*$/.exec(text);
    if (m === null || m[0] === undefined) break;
    blocks.unshift(m[0].trimEnd());
    text = text.slice(0, text.length - m[0].length).trimEnd();
  }
  if (blocks.length === 0) return undefined;
  return parseDocLines(stripLines(blocks.join("\n")));
}

export class TsCompilerExtractor implements SymbolExtractor {
  extract(content: string): CodeSymbol[] {
    return this.extractRich(content).map(({ doc: _d, visibility: _v, exported: _e, ...s }) => s);
  }

  extractRich(content: string): TsCodeSymbol[] {
    const sf = ts.createSourceFile("x.ts", content, ts.ScriptTarget.Latest, true);
    // File-header doc: a leading comment block before ANY statement attaches
    // to the first declaration, even across import statements (the common
    // header → imports → class layout). If the block is adjacent to a
    // statement that is not a declaration (e.g. imports), defer it.
    const first = sf.statements[0];
    const headerDoc = first === undefined
      ? undefined
      : harvestLeadingComment(sf, first.getStart(sf) - 1);
    const syms: TsCodeSymbol[] = [];
    for (const stmt of sf.statements) {
      const s = this.#decl(stmt);
      if (s === undefined) continue;
      if (headerDoc !== undefined && s.doc === undefined && syms.length === 0) {
        // attaches across import statements (header → imports → class is the
        // common layout); the first DECLARATION owns the file header
        s.doc = headerDoc;
      }
      syms.push(s);
      if (ts.isClassDeclaration(stmt)) syms.push(...this.#members(stmt));
    }
    const total = content === "" ? 0 : content.split("\n").length;
    for (let i = 0; i < syms.length; i++) {
      const next = syms[i + 1];
      syms[i]!.endLine = next === undefined ? total : Math.max(syms[i]!.startLine, next.startLine - 1);
    }
    return syms;
  }

  #decl(stmt: ts.Statement): TsCodeSymbol | undefined {
    let d: ts.Declaration & { name?: ts.DeclarationName | undefined } | undefined;
    let kind: CodeSymbol["kind"] | undefined;
    if (ts.isFunctionDeclaration(stmt)) { d = stmt; kind = "function"; }
    else if (ts.isClassDeclaration(stmt)) { d = stmt; kind = "class"; }
    else if (ts.isInterfaceDeclaration(stmt)) { d = stmt; kind = "interface"; }
    else if (ts.isTypeAliasDeclaration(stmt)) { d = stmt; kind = "type"; }
    else if (ts.isVariableStatement(stmt)) { d = stmt.declarationList.declarations[0]; kind = "const"; }
    // enums and binding-pattern names are deliberately skipped: v1
    // (HeuristicTsExtractor) never emitted them — emitting them would shift
    // anchoring tables on an extractor swap (gate M3).
    if (d === undefined || kind === undefined || d.name === undefined) return undefined;
    if (!ts.isIdentifier(d.name)) return undefined;
    const mods = ts.canHaveModifiers(stmt) ? (ts.getModifiers(stmt) ?? undefined) : undefined;
    const { line } = stmt.getSourceFile().getLineAndCharacterOfPosition(stmt.getStart());
    return {
      name: d.name.getText(), kind, startLine: line + 1, endLine: line + 1,
      visibility: visibilityOf(mods),
      exported: mods?.some((m: ts.Modifier) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false,
      doc: harvestDoc(stmt),
    };
  }

  /** Class members as symbols — v1 parity: methods/accessors only, identifier names. */
  #members(cls: ts.ClassDeclaration): TsCodeSymbol[] {
    const out: TsCodeSymbol[] = [];
    for (const m of cls.members) {
      if (m.name === undefined || !ts.isIdentifier(m.name)) continue;
      if (!ts.isMethodDeclaration(m) && !ts.isGetAccessorDeclaration(m) && !ts.isSetAccessorDeclaration(m)) continue;
      const mods = ts.canHaveModifiers(m) ? (ts.getModifiers(m) ?? undefined) : undefined;
      const { line } = m.getSourceFile().getLineAndCharacterOfPosition(m.getStart());
      out.push({
        name: m.name.getText(), kind: "method", startLine: line + 1, endLine: line + 1,
        visibility: visibilityOf(mods),
        exported: false,
        doc: harvestDoc(m),
      });
    }
    return out;
  }
}

export interface InterfaceViewOptions {
  /** Include protected members (the subclass contract). Default true. */
  includeProtected: boolean;
  /** Include private members. Default false. */
  includePrivate: boolean;
  /** "none" | "summary" | "full" doc depth. Default "summary". */
  docs: "none" | "summary" | "full";
}

const defaultView: InterfaceViewOptions = { includeProtected: true, includePrivate: false, docs: "summary" };

/** Modifiers that change interface-view meaning — rendered as markers. */
function memberModifiers(m: ts.ClassElement): string {
  const mods = ts.canHaveModifiers(m) ? (ts.getModifiers(m) ?? []) : [];
  const parts: string[] = [];
  if (mods.some((x) => x.kind === ts.SyntaxKind.AbstractKeyword)) parts.push("abstract");
  if (mods.some((x) => x.kind === ts.SyntaxKind.StaticKeyword)) parts.push("static");
  if (mods.some((x) => x.kind === ts.SyntaxKind.AsyncKeyword)) parts.push("async");
  if (ts.isPropertyDeclaration(m) && mods.some((x) => x.kind === ts.SyntaxKind.ReadonlyKeyword)) parts.push("readonly");
  return parts.length > 0 ? parts.join(" ") + " " : "";
}

function signatureOf(m: ts.ClassElement): string | undefined {
  if (ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m)) {
    const params = m.parameters.map((p) => {
      if (ts.isConstructorDeclaration(m)) {
        // param-properties: abbreviate to bare names (+ modifiers elided)
        const opt = p.questionToken !== undefined || (p.type !== undefined && /\bundefined\b/.test(p.type.getText())) ? "?" : "";
        return `${p.name.getText()}${opt}`;
      }
      return p.getText();
    }).join(", ");
    const ret = ts.isMethodDeclaration(m) && m.type !== undefined ? `: ${m.type.getText()}` : "";
    const kw = ts.isConstructorDeclaration(m) ? "constructor" : m.name === undefined ? "" : m.name.getText();
    return `${memberModifiers(m)}${kw}(${params})${ret}`;
  }
  if (ts.isPropertyDeclaration(m)) {
    const type = m.type !== undefined ? `: ${m.type.getText()}` : "";
    const init = m.initializer !== undefined ? ` = ${m.initializer.getText()}` : "";
    return `${memberModifiers(m)}${m.name.getText()}${type}${init}`;
  }
  if (ts.isGetAccessorDeclaration(m)) return `${memberModifiers(m)}get ${m.name.getText()}()`;
  if (ts.isSetAccessorDeclaration(m)) return `${memberModifiers(m)}set ${m.name.getText()}(${m.parameters.map((p) => p.getText()).join(", ")})`;
  return undefined;
}

/**
 * Render the interface view of a named class in `content`: members with
 * visibility, signatures, and harvested docs. Parse-only — inherited
 * members from a base class are NOT resolved (that needs the TypeChecker;
 * reserved for the checker-backed projection slice).
 */
export function renderInterface(content: string, className: string, optsIn?: Partial<InterfaceViewOptions>): string {
  const opts = { ...defaultView, ...optsIn };
  const sf = ts.createSourceFile("x.ts", content, ts.ScriptTarget.Latest, true);
  const cls = sf.statements.find(
    (s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.getText() === className,
  );
  if (cls === undefined) return `⟨class ${className} not found⟩`;
  const lines: string[] = [`interface ${className} {`];
  for (const m of cls.members) {
    const mods = ts.canHaveModifiers(m) ? (ts.getModifiers(m) ?? undefined) : undefined;
    const vis = visibilityOf(mods);
    if (m.name !== undefined && m.name.getText().startsWith("#")) continue; // runtime wall
    if (vis === "private" && !opts.includePrivate) continue;
    if (vis === "protected" && !opts.includeProtected) continue;
    const sig = signatureOf(m);
    if (sig === undefined) continue;
    const marker = vis === "protected" ? "protected " : "";
    lines.push(`  ${marker}${sig};`);
    const doc = harvestDoc(m);
    if (doc !== undefined && opts.docs !== "none") {
      the_doc_render(doc, opts, lines);
    }
  }
  lines.push("}");
  return lines.join("\n");
}

function the_doc_render(doc: DocHarvest, opts: InterfaceViewOptions, lines: string[]): void {
  const text = opts.docs === "full" ? doc.full ?? doc.summary : doc.summary;
  if (text !== undefined && text.length > 0) lines.push(`    /** ${text.split("\n").join(" · ")} */`);
}

/**
 * Checker-backed interface view: includes members INHERITED from base
 * classes, marked `↖ inherited from <Base>`. Requires a real ts.Program
 * (whole-project type resolution), so it takes a file PATH, not content.
 * This is the on-demand, digest-cacheable projection — do not call it
 * per-render; the parse-only renderInterface is the cheap path.
 */
/** Cross-safe dirname (ts.sys.getDirectoryPath is untyped). */
function dirName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i <= 0 ? "." : p.slice(0, i);
}

export function renderInterfaceResolved(
  entryPath: string,
  className: string,
  optsIn?: Partial<InterfaceViewOptions>,
): string {
  const opts = { ...defaultView, ...optsIn };
  // Discover tsconfig from the ENTRY FILE's directory (upward), never CWD —
  // CWD-relative discovery silently built a Program over scratch files with
  // default options when invoked from elsewhere (gate M2).
  const configPath = ts.findConfigFile(dirName(require("node:path").resolve(entryPath)), ts.sys.fileExists, "tsconfig.json");
  if (configPath === undefined) return `⟨no tsconfig.json found above ${entryPath}⟩`;
  const raw = ts.readConfigFile(configPath, ts.sys.readFile);
  if (raw.error !== undefined) return `⟨tsconfig parse error: ${ts.flattenDiagnosticMessageText(raw.error.messageText, " ")}⟩`;
  const cfg = ts.parseJsonConfigFileContent(raw.config ?? {}, ts.sys, dirName(configPath));
  const program = ts.createProgram([entryPath, ...cfg.fileNames.filter((f) => f !== entryPath)], cfg.options);
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(entryPath);
  if (sf === undefined) return `⟨file ${entryPath} not in program⟩`;
  const cls = sf.statements.find(
    (s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.getText() === className,
  );
  if (cls === undefined) return `⟨class ${className} not found in ${entryPath}⟩`;

  const lines: string[] = [`interface ${className} {`];
  // own members first (source order), then inherited (base-declaration order)
  for (const m of cls.members) {
    const mods = ts.canHaveModifiers(m) ? (ts.getModifiers(m) ?? undefined) : undefined;
    const vis = visibilityOf(mods);
    if (m.name === undefined || m.name.getText().startsWith("#")) continue;
    if (vis === "private" && !opts.includePrivate) continue;
    if (vis === "protected" && !opts.includeProtected) continue;
    const sig = signatureOf(m);
    if (sig === undefined) continue;
    lines.push(`  ${vis === "protected" ? "protected " : ""}${sig};`);
    const doc = harvestDoc(m);
    if (doc !== undefined && opts.docs !== "none") the_doc_render(doc, opts, lines);
  }

  // inherited surface: walk base types transitively
  const seen = new Set(cls.members.map((m) => m.name?.getText()).filter((n): n is string => n !== undefined));
  const classType = checker.getTypeAtLocation(cls);
  const baseTypes: ts.Type[] = [];
  const collect = (t: ts.Type, depth: number): void => {
    if (depth > 4) return;
    for (const b of checker.getBaseTypes(t as ts.InterfaceType)) {
      baseTypes.push(b);
      collect(b, depth + 1);
    }
  };
  collect(classType, 0);

  for (const base of baseTypes) {
    for (const prop of checker.getPropertiesOfType(base)) {
      if (seen.has(prop.getName())) continue;
      const decl = prop.getDeclarations()?.[0];
      if (decl === undefined || !ts.isClassElement(decl)) continue;
      // Attribute from the DECLARING class (walk decl.parent up), not the
      // walked base type — getPropertiesOfType returns transitively-declared
      // members, so the walked base mislabels grandparent members (gate M1).
      let declParent = decl.parent;
      while (declParent !== undefined && !ts.isClassLike(declParent)) declParent = declParent.parent;
      const baseName = declParent !== undefined && ts.isClassDeclaration(declParent) && declParent.name !== undefined
        ? declParent.name.getText()
        : base.getSymbol()?.getName() ?? "?";
      const mods = ts.canHaveModifiers(decl) ? (ts.getModifiers(decl) ?? undefined) : undefined;
      const vis = visibilityOf(mods);
      if (vis === "private") continue;              // never crosses the class boundary
      if (decl.name !== undefined && decl.name.getText().startsWith("#")) continue;
      if (vis === "protected" && !opts.includeProtected) continue;
      const sig = signatureOf(decl);
      if (sig === undefined) continue;
      seen.add(prop.getName());
      lines.push(`  ${sig};`.replace(/^  /, `  ↖ inherited from ${baseName}: `));
      const doc = harvestDoc(decl);
      if (doc !== undefined && opts.docs !== "none") the_doc_render(doc, opts, lines);
    }
  }
  lines.push("}");
  return lines.join("\n");
}
