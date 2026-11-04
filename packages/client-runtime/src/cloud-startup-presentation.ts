import type { CloudChatSummary } from "@zuse/contracts";
import { cloudFailurePresentation } from "./cloud-failure-presentation.ts";

type CloudStartupPhase = CloudChatSummary["startupPhase"];

/** Whether the durable cloud lifecycle still owns the initial chat setup UI. */
export const cloudWorkspaceIsStarting = (summary: CloudChatSummary): boolean =>
	summary.startupPhase === "allocating" ||
	summary.startupPhase === "booting" ||
	summary.startupPhase === "authenticating-runtime" ||
	summary.startupPhase === "syncing-repository";

/** The durable lifecycle is still replacing this workspace's runtime. */
export const cloudRuntimeUpdateInProgress = (statusCode: string): boolean =>
	statusCode === "update-queued" ||
	statusCode === "runtime-update-preparing" ||
	statusCode === "runtime-update-rolling-back" ||
	statusCode === "resume-runtime-restarting";

/** Setup step index (0 workspace, 1 runtime, 2 repository, 3 agent). */
export const cloudPhaseRank: Record<CloudStartupPhase, number> = {
	allocating: 0,
	booting: 1,
	"authenticating-runtime": 1,
	"syncing-repository": 2,
	"starting-agent": 3,
	running: 3,
	failed: -1,
};

/** The setup step a startup failure belongs to. */
export const cloudFailureRank = (statusCode: string): number => {
	if (/agent/u.test(statusCode)) return 3;
	if (/git|repository|branch/u.test(statusCode)) return 2;
	if (/runtime|enroll|credential|auth/u.test(statusCode)) return 1;
	return 0;
};

export const cloudFailureMessage = (statusCode: string): string => {
	const failure = cloudFailurePresentation({ category: statusCode });
	if (failure?.kind === "workspace-storage-unavailable") return failure.message;
	switch (statusCode) {
		case "archive-restore-failed":
			return "Your saved workspace could not be restored. Its recovery backup is still retained. Retry to continue restoring it.";
		case "archive-restore-image-required":
			return "Prepare a current managed cloud image to restore this saved workspace. Your recovery backup is retained.";
		case "updating-runtime-failed":
			return "The secure runtime is incompatible with the cloud control plane. Retry after the cloud service finishes updating.";
		case "starting-runtime-failed":
			return "The secure runtime could not start. Retry will create a clean sandbox.";
		case "syncing-repository-failed":
			return "The sandbox started, but the repository could not be prepared. Retry will create a clean sandbox.";
		case "runtime-connection-timeout":
			return "The sandbox started, but its secure runtime did not connect in time.";
		case "provider-sandbox-missing":
			return "The saved sandbox no longer exists. Retry will restore this workspace in a new sandbox.";
		case "provider-unavailable":
			return "The cloud provider is temporarily unavailable.";
		case "provider-quota-exceeded":
			return "Your cloud provider's machine limit is reached. Remove an unused machine or increase the limit, then retry.";
		case "workspace-credential-install-failed":
		case "credential-install-failed":
			return "The workspace could not install your connected account credentials.";
		default:
			return `Startup stopped during ${statusCode}.`;
	}
};

/** One line describing where a cloud workspace is in its startup. */
export const cloudPhaseLabel = (
	phase: CloudStartupPhase,
	statusCode: string,
): string => {
	if (phase === "failed") return cloudFailureMessage(statusCode);
	if (
		statusCode === "archive-restore-queued" ||
		statusCode === "archive-restoring"
	)
		return "Restoring saved chat and workspace files…";
	switch (phase) {
		case "allocating":
			return "Preparing cloud workspace…";
		case "booting":
		case "authenticating-runtime":
			return "Starting secure cloud runtime…";
		case "syncing-repository":
			switch (statusCode) {
				case "claude-auth-reconnect-required":
					return "Reconnect Claude in Cloud Workspaces to continue.";
				case "codex-auth-reconnect-required":
					return "Reconnect Codex in Cloud Workspaces to continue.";
				case "cursor-auth-reconnect-required":
					return "Reconnect Cursor in Cloud Workspaces to continue.";
				case "grok-auth-reconnect-required":
					return "Reconnect Grok in Cloud Workspaces to continue.";
				case "preparing-credentials":
					return "Preparing connected accounts…";
				case "checking-repository":
					return "Checking repository…";
				case "switching-branch":
					return "Switching branch…";
				case "fetching-repository":
					return "Fetching repository…";
				default:
					return "Preparing repository…";
			}
		case "starting-agent":
		case "running":
			return "Cloud workspace ready";
	}
};
