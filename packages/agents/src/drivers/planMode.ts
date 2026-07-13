import type { PermissionMode } from "@zuse/contracts";

/**
 * Developer-instructions prefix that emulates plan mode for providers that
 * don't have a native equivalent. It is also the compatibility fallback for
 * older app-server releases that predate native collaboration modes. ACP
 * providers currently receive this block when their live session protocols
 * do not expose a mode switch.
 *
 * The model is still free to ignore it, so the permission policy separately
 * allows reads and rejects mutations without prompting. The instruction mainly
 * improves UX by preventing attempted writes.
 */
export const PLAN_MODE_INSTRUCTIONS =
	"PLAN MODE — you are in read-only planning mode. Investigate the " +
	"codebase, ask clarifying questions if needed, then propose a concrete " +
	"plan. DO NOT modify files, run mutating commands, or invoke any tool " +
	"that writes to disk or the network. When you have a complete plan, " +
	"present it for approval and wait for the user to confirm before " +
	"exiting plan mode.";

/**
 * Wrap a user-supplied prompt with the plan-mode developer-instructions
 * prefix iff plan mode is active. No-op for `default` / `acceptEdits`.
 */
export const applyPlanModePrefix = (
	permissionMode: PermissionMode,
	text: string,
): string =>
	permissionMode === "plan"
		? `${PLAN_MODE_INSTRUCTIONS}\n\n---\n\n${text}`
		: text;
