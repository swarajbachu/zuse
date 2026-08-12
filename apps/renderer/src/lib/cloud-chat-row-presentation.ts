import type { CloudChatSummary } from "@zuse/contracts";
import {
	isSessionRuntimeBusy,
	type SessionRuntimeState,
} from "./session-runtime-state.ts";

export type CloudChatRowPresentation = {
	readonly label: string;
	readonly busy: boolean;
};

/** One presentation for the durable workspace lifecycle and its current turn. */
export const cloudChatRowPresentation = (
	summary: CloudChatSummary,
	runtimeState: SessionRuntimeState,
): CloudChatRowPresentation => {
	const archivePending =
		summary.desiredState === "archived" && summary.state !== "failed";
	if (summary.desiredState === "archived" && summary.state === "failed")
		return { label: "Archive failed", busy: false };
	if (archivePending) return { label: "Archiving…", busy: true };
	if (summary.state === "failed")
		return { label: "Needs attention", busy: false };

	const turnBusy = isSessionRuntimeBusy(runtimeState);
	const computeUnavailable =
		summary.state !== "ready" || summary.runtimeState !== "online";
	if (turnBusy) {
		if (computeUnavailable) return { label: "Resuming", busy: true };
		return {
			label: runtimeState === "stopping" ? "Stopping" : "Working",
			busy: true,
		};
	}

	if (summary.state === "paused") return { label: "Paused", busy: false };
	if (summary.state === "resuming" || summary.statusCode.startsWith("resume-"))
		return { label: "Resuming", busy: true };
	if (summary.state === "ready" && summary.runtimeState === "online")
		return { label: "Active", busy: false };

	const workspaceBusy =
		summary.state === "queued" ||
		summary.state === "provisioning" ||
		summary.state === "setup" ||
		summary.state === "pausing" ||
		summary.state === "recovering" ||
		summary.runtimeState === "connecting";
	return { label: "Cloud starting", busy: workspaceBusy };
};
