import * as ts from "typescript";

export interface CellDiagnostic {
  code: number;
  category: "error" | "warning" | "suggestion" | "message";
  message: string;
  line: number;
  column: number;
}

export interface CompiledCell {
  ok: boolean;
  js?: string;
  diagnostics: CellDiagnostic[];
  typeCheckMs: number;
  transpileMs: number;
}

// Unique per agent: the shared registry caches SourceFiles by path, so two
// agents must never present different text under the same virtual path.
let virtualFileCounter = 0;

// One document registry shared by every per-agent LanguageService: lib.d.ts
// and standard library snapshots are parsed once per process, not per agent.
const sharedRegistry = ts.createDocumentRegistry();

/**
 * Persistent in-memory TypeScript gate for agent-authored cells.
 *
 * Successful source cells remain in one virtual script, so declarations and
 * inferred types survive between turns. Recovery rebuilds this static model
 * from audit source only; it never executes historical cells.
 */
export class CellCompiler {
  private history: string[] = [];
  private candidate = "";
  private version = 0;
  private readonly virtualFile: string;
  private readonly service: ts.LanguageService;

  constructor(history: string[] = []) {
    this.history = [...history];
    this.virtualFile = `/agent-kernel/cells-${++virtualFileCounter}.ts`;
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.None,
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      noEmit: true,
      skipLibCheck: true,
      lib: ["lib.esnext.d.ts", "lib.dom.d.ts"],
    };
    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => options,
      getScriptFileNames: () => [this.virtualFile],
      getScriptVersion: () => String(this.version),
      getScriptSnapshot: (file) => {
        if (file === this.virtualFile) return ts.ScriptSnapshot.fromString(this.virtualSource());
        const text = ts.sys.readFile(file);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => "/agent-kernel",
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
    };
    this.service = ts.createLanguageService(host, sharedRegistry);
  }

  private sourcePrefix(): string {
    // Host capabilities are explicit and narrow. Replace `any` with generated
    // declarations as ops.* and memory.* acquire their final interfaces.
    const prelude = [
      "declare const ops: any;",
      "declare const memory: any;",
      "declare function appendLine(s: string): void;",
      "declare var swarmMail: any[];",
      "declare const process: { exit(code?: number): never };",
    ].join(" ") + "\n";
    return prelude + this.history.join(";\n") + (this.history.length ? ";\n" : "");
  }

  private virtualSource(): string {
    return this.sourcePrefix() + this.candidate;
  }

  checkAndTranspile(source: string): CompiledCell {
    this.candidate = source;
    this.version++;
    const t0 = performance.now();
    const raw = [
      ...this.service.getSyntacticDiagnostics(this.virtualFile),
      ...this.service.getSemanticDiagnostics(this.virtualFile),
    ];
    const typeCheckMs = performance.now() - t0;
    const prefixLines = this.sourcePrefix().split("\n").length - 1;
    const diagnostics = raw
      .filter((d) => d.category === ts.DiagnosticCategory.Error)
      .map((d): CellDiagnostic => {
        const pos = d.file?.getLineAndCharacterOfPosition(d.start ?? 0) ?? { line: 0, character: 0 };
        return {
          code: d.code,
          category: "error",
          message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
          line: Math.max(1, pos.line - prefixLines + 1),
          column: pos.character + 1,
        };
      });
    if (diagnostics.length) return { ok: false, diagnostics, typeCheckMs, transpileMs: 0 };

    const t1 = performance.now();
    const emitted = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.None,
        removeComments: false,
      },
      reportDiagnostics: true,
    });
    const transpileMs = performance.now() - t1;
    const emitErrors = (emitted.diagnostics ?? [])
      .filter((d) => d.category === ts.DiagnosticCategory.Error)
      .map((d): CellDiagnostic => ({
        code: d.code,
        category: "error",
        message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
        line: 1,
        column: 1,
      }));
    if (emitErrors.length) {
      return { ok: false, diagnostics: emitErrors, typeCheckMs, transpileMs };
    }
    return { ok: true, js: emitted.outputText, diagnostics: [], typeCheckMs, transpileMs };
  }

  /** Admit a statically valid cell into the persistent type environment. */
  accept(source: string): void {
    this.history.push(source);
    this.candidate = "";
    this.version++;
  }

  dispose(): void {
    this.service.dispose();
  }
}
