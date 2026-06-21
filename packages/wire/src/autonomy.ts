import { Schema } from "effect";

/**
 * How much an agent is allowed to orchestrate other work on its own — spawn
 * git worktrees, open new chats/sessions ("threads"), and (later phases)
 * drive loops. This gates whether the in-process control-plane MCP tools
 * (`create_worktree`, `create_thread`, `send_to_thread`, …) are registered
 * for a session at start time.
 *
 *   - `off`            → control-plane tools are NOT registered. memoize
 *                        behaves exactly as it did before this feature.
 *                        (Default — opt-in only.)
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

export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = "off";

/**
 * Whether `level` enables the control-plane tools at all. Both gated modes
 * register the tools; only `off` withholds them.
 */
export const autonomyEnablesOrchestration = (level: AutonomyLevel): boolean =>
  level !== "off";
