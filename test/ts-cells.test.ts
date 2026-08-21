import { describe, test, expect, beforeAll } from "bun:test";
import { Kernel } from "../src/kernel.ts";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "agent-kernel-ts-cells-")); });

function kernel(name: string): Kernel {
  return new Kernel(join(dir, `${name}.journal`), join(dir, `${name}.snap`));
}

describe("Kernel: TypeScript cell gate", () => {
  test("type-checks, transpiles, and executes a typed cell", () => {
    const k = kernel("typed");
    const first = k.eval("var typedN: number = 21");
    const second = k.eval("typedN * 2");
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.value).toBe(42);
  });

  test("rejects a semantic type error before any code executes", () => {
    const k = kernel("reject");
    (globalThis as any).typeGateEffects = 0;
    const result = k.eval("typeGateEffects++; const typedBad: string = 42");
    expect(result.ok).toBe(false);
    expect(result.phase).toBe("typecheck");
    expect(result.diagnostics?.some((d) => d.code === 2322)).toBe(true);
    expect((globalThis as any).typeGateEffects).toBe(0);
  });

  test("preserves declarations across cells and catches stale incompatible writes", () => {
    const k = kernel("history");
    expect(k.eval("var typedLabel: string = 'ready'").ok).toBe(true);
    const result = k.eval("typedLabel = 99");
    expect(result.ok).toBe(false);
    expect(result.phase).toBe("typecheck");
    expect(result.diagnostics?.some((d) => d.code === 2322)).toBe(true);
    expect(k.ns.typedLabel).toBe("ready");
  });

  test("reports diagnostics in current-cell coordinates, not hidden history coordinates", () => {
    const k = kernel("coordinates");
    expect(k.eval("var coordinateSeed: number = 1").ok).toBe(true);
    const result = k.eval("const coordinateOk = 1;\nconst coordinateBad: string = 2");
    expect(result.ok).toBe(false);
    const typeError = result.diagnostics?.find((d) => d.code === 2322);
    expect(typeError?.line).toBe(2);
    expect(typeError?.column).toBeGreaterThan(1);
  });

  test("journal audits original TypeScript, never generated JavaScript", () => {
    const k = kernel("audit");
    const source = "var typedAudit: Map<string, number> = new Map([['answer', 42]])";
    expect(k.eval(source).ok).toBe(true);
    const line = JSON.parse(readFileSync(k.journalPath, "utf8").trim());
    expect(line.src).toBe(source);
    expect(line.js).toBeUndefined();
  });

  test("recovery rebuilds type history from audit source without replay", () => {
    const k = kernel("recover-types");
    expect(k.eval("var typedRecovered: number = 7").ok).toBe(true);
    const recovered = Kernel.recover(k.journalPath, k.snapPath);
    expect(recovered.replayed).toBe(0);
    const result = recovered.k.eval("typedRecovered = 'wrong'");
    expect(result.ok).toBe(false);
    expect(result.phase).toBe("typecheck");
    expect(recovered.k.ns.typedRecovered).toBe(7);
  });
});
