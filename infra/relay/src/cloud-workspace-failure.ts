import type { SandboxProviderError } from "@zuse/sandbox-providers";
import type { CloudWorkspaceRecord } from "./cloud-workspace-store.ts";

export const CLOUD_WORKSPACE_RETRY_MS = 5_000;
export const CLOUD_WORKSPACE_START_TIMEOUT_MS = 5 * 60 * 1_000;

export const cloudWorkspaceEnrollmentNeedsRefresh = (
	workspace: CloudWorkspaceRecord,
	nowMs: number,
): boolean =>
	workspace.state === "setup" &&
	workspace.environmentId === undefined &&
	(workspace.enrollmentExpiresAtMs ?? 0) <= nowMs;

export const cloudWorkspaceStartupTimedOut = (
	workspace: CloudWorkspaceRecord,
	nowMs: number,
): boolean =>
	(workspace.state === "queued" ||
		workspace.state === "provisioning" ||
		workspace.state === "setup") &&
	nowMs - workspace.createdAtMs >= CLOUD_WORKSPACE_START_TIMEOUT_MS;

export const cloudWorkspaceReconcileDelay = (
	workspace: CloudWorkspaceRecord,
	nowMs: number,
): number | null => {
	if (
		workspace.state !== "queued" &&
		workspace.state !== "provisioning" &&
		workspace.state !== "setup" &&
		workspace.state !== "resuming" &&
		workspace.state !== "recovering"
	)
		return null;
	const delayMs = Math.max(0, workspace.nextActionAtMs - nowMs);
	return delayMs <= CLOUD_WORKSPACE_RETRY_MS ? delayMs : null;
};

export const cloudWorkspaceAfterProviderFailure = (
	workspace: CloudWorkspaceRecord,
	code: SandboxProviderError["code"],
	nowMs: number,
	rejectedStatusCode = "provider-request-rejected",
): CloudWorkspaceRecord => {
	const timedOut = cloudWorkspaceStartupTimedOut(workspace, nowMs);
	const terminal = code !== "transient" || timedOut;
	const statusCode =
		code === "not-found"
			? "provider-sandbox-missing"
			: code === "rejected"
				? rejectedStatusCode
				: timedOut
					? "provider-unavailable"
					: "provider-retrying";

	return {
		...workspace,
		state: terminal ? "failed" : workspace.state,
		statusCode,
		nextActionAtMs: terminal
			? Number.MAX_SAFE_INTEGER
			: nowMs + CLOUD_WORKSPACE_RETRY_MS,
		revision: workspace.revision + 1,
		updatedAtMs: nowMs,
	};
};

export const cloudWorkspaceAfterSetupFailure = (
	workspace: CloudWorkspaceRecord,
	nowMs: number,
): CloudWorkspaceRecord => ({
	...workspace,
	state: "failed",
	statusCode: "setup-failed",
	nextActionAtMs: Number.MAX_SAFE_INTEGER,
	revision: workspace.revision + 1,
	updatedAtMs: nowMs,
});

export const cloudWorkspaceWithoutProviderSandbox = (
	workspace: CloudWorkspaceRecord,
): CloudWorkspaceRecord => ({
	...workspace,
	providerSandboxId: undefined,
	providerEndpointHttpBaseUrl: undefined,
	providerEndpointWsBaseUrl: undefined,
	environmentId: undefined,
	enrollmentTokenHash: undefined,
	enrollmentExpiresAtMs: undefined,
	enrolledEnvironmentPublicKey: undefined,
});
