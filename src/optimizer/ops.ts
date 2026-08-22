/**
 * ops.* host surface — roadmap item (docs/design.md): "ops.rlm_spawn,
 * ops.goal_set, ops.memory_search — credentials and providers stay host-side
 * (prime-agent's trust boundary)".
 *
 * This module is the HOST side of the boundary: a registry the boot process
 * (REPL/TUI) binds the MemoryStore and RLMSupervisor into. The model
 * proposes ops intents through the normal SteeringIntent surface
 * (intents.ts implements the cases); execution lands here on host-owned
 * objects. The model receives strings and ids — never host handles, never
 * credentials. The solver stays single writer of render (signals not
 * overrides — ADR-0002g K7).
 *
 * ops.goal_set is already served by the goals.* family (ADR-0002f); the ops
 * surface deliberately does not duplicate it.
 *
 * Import-cycle note: this module imports ONLY TYPES from memory.ts and
 * rlm.ts (erased at runtime), so intents.ts may import opsCaps() from here
 * without creating a runtime cycle through loop.ts.
 */
import type { MemoryStore } from "./memory.ts";
import type { RLMSupervisor } from "./rlm.ts";

/** Host capabilities for the ops intent family (bound at boot, never model-held). */
export interface OpsCaps {
  memory: MemoryStore | null;
  rlm: RLMSupervisor | null;
}

let caps: OpsCaps | null = null;

/** Bind (or rebind/clear with null) host capabilities. Called by boot only. */
export function bindOps(c: OpsCaps | null): void { caps = c; }

/** The currently bound capabilities, or null before boot binds them. */
export function opsCaps(): OpsCaps | null { return caps; }
