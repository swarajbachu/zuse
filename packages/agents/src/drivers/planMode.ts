import type { PermissionMode } from "@zuse/contracts";

/**
 * Developer-instructions prefix that emulates plan mode for providers that
 * don't have a native equivalent. The Claude Agent SDK has `permissionMode:
 * "plan"`, Cursor's ACP has `setSessionMode("plan")`, but Codex/Grok/Gemini
 * don't expose a runtime read-only switch — so we prepend this block to the
 * user's prompt while plan mode is active.
 *
 * The model is still free to ignore it, which is why we ALSO keep
 * `RuntimeMode: "approval-required"` as the safety net for any tool call
 * that wants to mutate state.
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
