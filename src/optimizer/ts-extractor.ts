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
    .map((l) => l.replace(/^\s*\/?\*+\/?/, "").replace(/\s*\*\/$/, "").trimEnd())
    .filter((l) => l.trim().length > 0);
}

function harvestDoc(node: ts.Node): DocHarvest | undefined {
  const js = (ts as unknown as { getJSDocCommentsAndTags?: (n: ts.Node) => ts.JSDoc[] })
    .getJSDocCommentsAndTags?.(node) ?? [];
  if (js.length === 0) return undefined;
  const lines = stripLines(js.map((j) => j.getText()).join("\n"));
  if (lines.length === 0) return undefined;
  const params: string[] = [];
  let returns: string | undefined;
  const content: string[] = [];
  for (const line of lines) {
    const pm = /^@param\s+(\S+)\s*(.*)$/.exec(line);
    if (pm !== null) { params.push(pm[2] ? `${pm[1]} — ${pm[2].trim()}` : pm[1]!); continue; }
    const rm = /^@returns?\s+(.*)$/.exec(line);
    if (rm !== null) { returns = rm[1]!.trim(); continue; }
    content.push(line);
  }
  return { summary: content[0], full: content.join("\n"), params, returns };
}

function visibilityOf(mods: readonly ts.Modifier[] | undefined): Visibility {
  if (mods?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)) return "private";
  if (mods?.some((m) => m.kind === ts.SyntaxKind.ProtectedKeyword)) return "protected";
  return "public";
}

export class TsCompilerExtractor implements SymbolExtractor {
  extract(content: string): CodeSymbol[] {
    return this.extractRich(content).map(({ doc: _d, visibility: _v, exported: _e, ...s }) => s);
  }

  extractRich(content: string): TsCodeSymbol[] {
    const sf = ts.createSourceFile("x.ts", content, ts.ScriptTarget.Latest, true);
    const syms: TsCodeSymbol[] = [];
    for (const stmt of sf.statements) {
      const s = this.#decl(stmt);
      if (s !== undefined) syms.push(s);
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
    else if (ts.isEnumDeclaration(stmt)) { d = stmt; kind = "const"; }
    else if (ts.isVariableStatement(stmt)) { d = stmt.declarationList.declarations[0]; kind = "const"; }
    if (d === undefined || kind === undefined || d.name === undefined) return undefined;
    const mods = ts.canHaveModifiers(stmt) ? (ts.getModifiers(stmt) ?? undefined) : undefined;
    const { line } = stmt.getSourceFile().getLineAndCharacterOfPosition(stmt.getStart());
    return {
      name: d.name.getText(), kind, startLine: line + 1, endLine: line + 1,
      visibility: visibilityOf(mods),
      exported: mods?.some((m: ts.Modifier) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false,
      doc: harvestDoc(stmt),
    };
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

function signatureOf(m: ts.ClassElement): string | undefined {
  if (ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m)) {
    const params = m.parameters.map((p) => p.getText()).join(", ");
    const ret = ts.isMethodDeclaration(m) && m.type !== undefined ? `: ${m.type.getText()}` : "";
    const kw = ts.isConstructorDeclaration(m) ? "constructor" : m.name === undefined ? "" : m.name.getText();
    return `${kw}(${params})${ret}`;
  }
  if (ts.isPropertyDeclaration(m)) {
    const type = m.type !== undefined ? `: ${m.type.getText()}` : "";
    const init = m.initializer !== undefined ? ` = ${m.initializer.getText()}` : "";
    return `${m.name.getText()}${type}${init}`;
  }
  if (ts.isGetAccessorDeclaration(m)) return `get ${m.name.getText()}()`;
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
      const text = opts.docs === "full" ? doc.full ?? doc.summary : doc.summary;
      if (text !== undefined && text.length > 0) lines.push(`    /** ${text.split("\n").join(" · ")} */`);
    }
  }
  lines.push("}");
  return lines.join("\n");
}
