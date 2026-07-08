import { Schema } from "effect";

/**
 * How much an agent is allowed to orchestrate other work on its own — spawn
 * git worktrees, open new chats/sessions ("threads"), and (later phases)
 * drive loops. The orchestration tools are built in; mutating calls are still
 * routed through the normal permission system.
 *
 *   - `off`            → legacy persisted value. Treated like
 *                        `approval-gated` by current runtimes.
 *   - `approval-gated` → tools registered; every spawn routes through the
 *                        normal permission prompt, so the user approves each
 *                        one. "Always allow for session/folder" still
 *                        persists via the existing permission broker.
 *   - `autonomous`     → tools registered; spawns may auto-approve, bounded
 *                        by per-loop budgets + the global kill switch. The
 *                        unattended auto-approve path is unsafe without the
 *                        kill switch, which ships with the loop engine, so
 *                        until then `autonomous` behaves like `approval-gated`.
 */
export const AutonomyLevel = Schema.Literal(
  "off",
  "approval-gated",
  "autonomous",
);
export type AutonomyLevel = typeof AutonomyLevel.Type;

export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = "approval-gated";

/**
 * Whether `level` enables the control-plane tools at all. Kept for old callers;
 * current runtimes expose the built-in tools for every managed session.
 */
export const autonomyEnablesOrchestration = (_level: AutonomyLevel): boolean =>
  true;
