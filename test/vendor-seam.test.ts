/**
 * Seam tripwires (PR #24 review M1/M2) — these pin decisions, not
 * behavior. If one fails, the extraction contract has been violated,
 * not the solver.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";

describe("seam tripwires (review M1/M2)", () => {
  it("kernel does not declare @connectotron/stowage as a package dependency", () => {
    // M1: a declared dep installs a second loadable copy; the shims
    // (relative paths) and the package root then fork into two module
    // graphs with incompatible CacheModel identities. The vendored
    // source tree is the ONLY copy.
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps["@connectotron/stowage"]).toBeUndefined();
  });

  it("package specifier must not resolve (single module graph)", async () => {
    // Runtime proof of the above: importing the package name must fail.
    // Non-literal specifier so tsc cannot statically resolve it.
    let resolved = true;
    const spec = "@connectotron/stowage";
    try {
      await import(spec);
    } catch {
      resolved = false;
    }
    expect(resolved).toBe(false);
  });

  it("bun.lock carries no stowage entry (lock untouched by the seam)", () => {
    // M2: the extraction must not ride unrelated resolution changes
    // through a regenerated lockfile. The lock stays byte-identical to
    // the pre-extraction main.
    const lock = readFileSync("bun.lock", "utf8");
    expect(lock.includes("stowage")).toBe(false);
  });
});
