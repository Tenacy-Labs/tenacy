/**
 * Seam tripwires — these pin decisions, not behavior. If one fails,
 * the dependency doctrine has been violated, not the solver.
 *
 * Lineage: originally M1/M2 from the PR #24 review (kernel declares NO
 * stowage package dep; specifier unresolvable; lock untouched) — the
 * doctrine of the file:copy era, where a declared dep meant a second
 * physical copy and two module graphs with incompatible CacheModel
 * identities. Superseded by the owner ruling of 2026-08-24: the kernel
 * depends on stowage, stowage on knapsack. Workspaces make this safe:
 * the package link is a SYMLINK to vendor/stowage, and Bun resolves
 * through symlinks to the canonical path — the specifier and the
 * shims' relative imports load the SAME physical module. One copy,
 * one graph, now enforced by the package manager instead of by
 * avoidance.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";

describe("seam tripwires (dependency doctrine, ruling 2026-08-24)", () => {
  it("kernel declares stowage via workspace protocol (and never knapsack directly)", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.dependencies?.["@connectotron/stowage"]).toBe("workspace:*");
    // Topology: knapsack is reached ONLY through stowage.
    expect(pkg.dependencies?.["@connectotron/knapsack"]).toBeUndefined();
    expect(pkg.devDependencies?.["@connectotron/knapsack"]).toBeUndefined();
    expect(JSON.stringify(pkg.workspaces)).toContain("vendor/stowage");
  });

  it("package specifier resolves INTO the vendored tree (single module graph)", () => {
    // M1's successor: the specifier may resolve now — but only to the
    // vendored source, never to a second copy from a registry.
    const url = import.meta.resolve("@connectotron/stowage");
    expect(url).toContain("vendor/stowage");
  });

  it("lock records workspace links, not registry copies", () => {
    const lock = readFileSync("bun.lock", "utf8");
    expect(lock).toContain("@connectotron/stowage@workspace:vendor/stowage");
    // No registry version of either package may ever appear.
    expect(lock).not.toMatch(/@connectotron\/(stowage|knapsack)@\^?\d/);
  });
});
