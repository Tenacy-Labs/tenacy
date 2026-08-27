/**
 * Tests for ts-extractor.ts (gate M4 — the module previously shipped with
 * zero coverage; each test here encodes a finding the adversarial gate
 * proved by probe). Run: bun test test/ts-extractor.test.ts
 */
import { describe, expect, test } from "bun:test";
import {
  TsCompilerExtractor, renderInterface, renderInterfaceResolved,
} from "../src/optimizer/ts-extractor.ts";

const ex = new TsCompilerExtractor();

describe("TsCompilerExtractor.extractRich", () => {
  test("top-level declarations with kind and visibility", () => {
    const syms = ex.extractRich(`export class A {}\nfunction f() {}\ninterface I { x: number }\n`);
    expect(syms.find((s) => s.name === "A")?.kind).toBe("class");
    expect(syms.find((s) => s.name === "A")?.exported).toBe(true);
    expect(syms.find((s) => s.name === "f")?.kind).toBe("function");
    expect(syms.find((s) => s.name === "f")?.exported).toBe(false);
    expect(syms.find((s) => s.name === "I")?.kind).toBe("interface");
  });

  test("class members extracted — v1 anchoring parity (gate M3)", () => {
    const syms = ex.extractRich(`class A {\n  alpha(): void {}\n}\n`);
    const alpha = syms.find((s) => s.name === "alpha");
    expect(alpha?.kind).toBe("method");
    expect(alpha?.startLine).toBe(2);
  });

  test("binding-pattern names skipped (gate M3)", () => {
    const syms = ex.extractRich(`const { x } = y;\n`);
    expect(syms.length).toBe(0);
  });

  test("enums skipped — v1 never emitted them (gate M3)", () => {
    const syms = ex.extractRich(`enum E { A, B }\n`);
    expect(syms.length).toBe(0);
  });

  test("file-header doc attaches to first declaration across imports (limitation 2)", () => {
    const syms = ex.extractRich(`/** File header doc. */\nimport { x } from "y";\nclass A {}\n`);
    const a = syms.find((s) => s.name === "A");
    expect(a?.doc?.summary).toBe("File header doc.");
  });

  test("string lookalikes do not misattach", () => {
    const syms = ex.extractRich(`const s = "*/ not a doc";\nclass Q {}\n`);
    expect(syms.find((s) => s.name === "Q")?.doc).toBeUndefined();
  });

  test("empty doc block yields undefined", () => {
    const syms = ex.extractRich(`/** */\nclass E {}\n`);
    expect(syms.find((s) => s.name === "E")?.doc).toBeUndefined();
  });

  test("line-comment headers collected fully, // stripped (gate MINOR-2)", () => {
    const syms = ex.extractRich(`// Copyright 2026 ACME\n// Do not redistribute\nclass L {}\n`);
    const l = syms.find((s) => s.name === "L");
    expect(l?.doc?.summary).toBe("Copyright 2026 ACME");
    expect(l?.doc?.summary?.startsWith("//")).toBe(false);
  });

  test("@param and @returns harvested structurally", () => {
    const syms = ex.extractRich(`/** Does x.\n * @param a first\n * @param b second\n * @returns number\n */\nfunction g(a: number, b: number): number { return 0; }\n`);
    const g = syms.find((s) => s.name === "g");
    expect(g?.doc?.summary).toBe("Does x.");
    expect(g?.doc?.params).toEqual(["a — first", "b — second"]);
    expect(g?.doc?.returns).toBe("number");
  });
});

describe("renderInterface", () => {
  test("protected members marked, #private excluded", () => {
    const v = renderInterface(`class A {\n  protected slice(): string { return ""; }\n  #hidden(): void {}\n  pub(): void {}\n}\n`, "A", { docs: "none" });
    expect(v).toContain("protected slice(): string;");
    expect(v).not.toContain("#hidden");
    expect(v).toContain("pub(): void;");
  });

  test("static/abstract members carry markers (gate MINOR-3)", () => {
    const v = renderInterface(`class A {\n  static kind = "animal";\n  abstract speak(): void;\n  set legs(n: number) {}\n}\n`, "A", { docs: "none" });
    expect(v).toContain("static kind");
    expect(v).toContain("abstract speak");
    expect(v).toContain("set legs(n: number)");
  });

  test("missing class returns sentinel", () => {
    expect(renderInterface("class B {}", "Nope")).toContain("not found");
  });
});

describe("renderInterfaceResolved (checker path)", () => {
  test("grandparent members attributed to the DECLARING class (gate M1)", () => {
    // chain C extends B extends A, alpha declared in A — must say "from A"
    const src = `class A { /** From A. */ alpha(): void {} }\nclass B extends A { beta(): void {} }\nclass C extends B { gamma(): void {} }\n`;
    // write to a temp dir WITH a tsconfig so M2 discovery works from any CWD
    const dir = `/tmp/tsprobe-m1-${process.pid}`;
    require("node:fs").mkdirSync(dir, { recursive: true });
    require("node:fs").writeFileSync(`${dir}/chain.ts`, src);
    require("node:fs").writeFileSync(`${dir}/tsconfig.json`, `{"compilerOptions":{"strict":true}}`);
    const r = renderInterfaceResolved(`${dir}/chain.ts`, "C", { docs: "summary" });
    expect(r).toContain("↖ inherited from A: alpha(): void;");
    expect(r).not.toContain("↖ inherited from B: alpha");
  });

  test("missing tsconfig returns sentinel, not a default-options Program (gate M2)", () => {
    const dir = `/tmp/tsprobe-m2-${process.pid}`;
    require("node:fs").mkdirSync(dir, { recursive: true });
    require("node:fs").writeFileSync(`${dir}/bare.ts`, `class X { m(): void {} }\n`);
    const r = renderInterfaceResolved(`${dir}/bare.ts`, "X");
    expect(r).toContain("⟨no tsconfig.json found");
  });

  test("own members + inherited on the real repo class (regression)", () => {
    const r = renderInterfaceResolved("src/optimizer/lens.ts", "FileLensItem", { docs: "none" });
    expect(r).toContain("interface FileLensItem {");
    expect(r).toContain("↖ inherited from Lens: expand(from: number, to: number): void;");
    expect(r).toContain("↖ inherited from Lens: options(): RenderOption[];");
  });
});
