import type { CloudWorkspaceRecord } from "./cloud-workspace-store.ts";
import type { WorkspaceStartupOutcome } from "./workspace-startup.ts";

/** Runtime callbacks may advance lifecycle work, but cannot defer its owner to idle. */
export const ACTIVE_RUNTIME_ACTIVATION_PHASES = [
	"preparing",
	"launching",
	"confirming",
	"rolling-back",
] as const;

export const workspaceStartupOutcome = (
	workspace: CloudWorkspaceRecord | null,
	nowMs: number,
): WorkspaceStartupOutcome => {
	if (workspace === null || workspace.state === "deleted")
		return { kind: "complete" };
	const operation = workspace.requestConfig.runtimeActivation;
	if (
		typeof operation === "object" &&
		operation !== null &&
		"phase" in operation &&
		operation.phase === "verification-needed"
	) {
		return {
			kind: "blocked",
			prerequisite: "runtime-update-verification-needed",
			wakeSource: "workspace-request",
		};
	}
	const activeOperation =
		typeof operation === "object" &&
		operation !== null &&
		"phase" in operation &&
		ACTIVE_RUNTIME_ACTIVATION_PHASES.some((phase) => phase === operation.phase);
	const pending =
		activeOperation ||
		workspace.requestConfig.runtimeReleaseChangeRequested === true ||
		workspace.requestConfig.cloudMailboxWakePending === true ||
		(workspace.desiredState === "ready" &&
			(workspace.state !== "ready" ||
				workspace.runtimeState !== "online" ||
				workspace.requestConfig.runtimeSessionRecoveryPending === true)) ||
		(workspace.desiredState === "paused" && workspace.state !== "paused") ||
		(workspace.desiredState === "archived" && workspace.state !== "archived") ||
		workspace.desiredState === "deleted";
	if (!pending) return { kind: "complete" };
	if (
		workspace.nextActionAtMs === Number.MAX_SAFE_INTEGER ||
		workspace.state === "failed"
	) {
		return {
			kind: "blocked",
			prerequisite: workspace.statusCode,
			wakeSource: "workspace-request",
		};
	}
	return {
		kind: "due",
		dueAtMs: Math.max(nowMs + 1_000, workspace.nextActionAtMs),
	};
};

export const preserveRuntimeOperationDeadline = (
	workspace: {
		readonly requestConfig: Readonly<Record<string, unknown>>;
		readonly nextActionAtMs: number;
	},
	proposedAtMs: number,
): number => {
	const operation = workspace.requestConfig.runtimeActivation;
	const pending =
		workspace.requestConfig.runtimeReleaseChangeRequested === true ||
		(typeof operation === "object" &&
			operation !== null &&
			"phase" in operation &&
			ACTIVE_RUNTIME_ACTIVATION_PHASES.some(
				(phase) => phase === operation.phase,
			));
	return pending
		? Math.min(workspace.nextActionAtMs, proposedAtMs)
		: proposedAtMs;
};
