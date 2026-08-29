/**
 * Seam tripwires — these pin decisions, not behavior. If one fails,
 * the dependency doctrine has been violated, not the solver.
 *
 * Lineage: file:copy era (M1/M2, PR #24 — no declared dep, two module
 * graphs) → workspace-symlink era (owner ruling 2026-08-24 — vendor/*
 * linked, one graph enforced by the package manager) → git-dependency
 * era (2026-08-29): the vendored tree is gone. stowage arrives as a
 * git dependency pinned to a tag; knapsack only transitively, through
 * stowage's own manifest. One copy, one graph, owned entirely by the
 * package manager — now from upstream tags instead of local checkouts.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

describe("seam tripwires (dependency doctrine, git-dep era 2026-08-29)", () => {
  it("kernel declares stowage as a tagged git dep (and never knapsack directly)", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.dependencies?.["@tenacy-labs/stowage"]).toMatch(
      /^github:Tenacy-Labs\/stowage#v\d+\.\d+\.\d+$/,
    );
    // Topology: knapsack is reached ONLY through stowage.
    expect(pkg.dependencies?.["@tenacy-labs/knapsack"]).toBeUndefined();
    expect(pkg.devDependencies?.["@tenacy-labs/knapsack"]).toBeUndefined();
    // No workspaces: there is nothing vendored to link anymore.
    expect(pkg.workspaces).toBeUndefined();
  });

  it("no vendored tree exists (the vendor era is over)", () => {
    expect(existsSync("vendor")).toBe(false);
  });

  it("package specifier resolves into the package-manager tree (single module graph)", () => {
    const url = import.meta.resolve("@tenacy-labs/stowage");
    expect(url).toContain("node_modules/@tenacy-labs/stowage");
  });

  it("kernel consumes stowage via the package root only (no deep paths, no subpaths)", () => {
    // Upstream doctrine (stowage src/index.ts): consumers import from the
    // package root; module paths are internal. The kernel's shims enumerate
    // their symbols from the barrel — a subpath import would couple us to
    // stowage's internal layout.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name)) {
          const src = readFileSync(p, "utf8");
          if (src.includes("vendor/") || src.includes("@tenacy-labs/stowage/")) {
            offenders.push(p);
          }
        }
      }
    };
    walk("src");
    expect(offenders).toEqual([]);
  });

  it("lock records the manifest's git pin, not workspace links or registry copies", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const pin = pkg.dependencies?.["@tenacy-labs/stowage"];
    const lock = readFileSync("bun.lock", "utf8");
    // The lock must freeze exactly what the manifest pins (tag → commit).
    expect(lock).toContain(`"@tenacy-labs/stowage": "${pin}"`);
    // knapsack arrives transitively, pinned by the lock to its resolved commit.
    expect(lock).toMatch(/@tenacy-labs\/knapsack@github:Tenacy-Labs\/knapsack#/);
    // The workspace era must never return.
    expect(lock).not.toContain("workspace:vendor/");
  });
});
