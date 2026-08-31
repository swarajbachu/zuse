import type { ConnectionPhase } from "@zuse/client-runtime/resource-state";
import type { CloudChatSummary } from "@zuse/contracts";
import type { CloudChatActivity } from "./cloud-chat-activity.ts";

export type CloudConnectionPresentation =
	| "hidden"
	| "paused"
	| "resuming"
	| "updating"
	| "failed";

export const cloudConnectionPresentation = (
	summary: CloudChatSummary,
	activity: CloudChatActivity,
	connection: ConnectionPhase,
): CloudConnectionPresentation => {
	if (activity === "failed") {
		// A provider failure also puts the session runtime in `failed`, but the
		// workspace connection can still be healthy. The transcript owns those
		// errors (including provider-auth CTAs); this notice is transport-only.
		if (
			summary.state !== "failed" &&
			connection !== "failed" &&
			connection !== "blocked-auth" &&
			connection !== "update-required" &&
			connection !== "revoked"
		)
			return "hidden";
		return "failed";
	}
	if (summary.statusCode.includes("runtime-update")) return "updating";
	if (activity === "resuming") return "resuming";
	// Attaching already-online compute is a passive refresh over cached data,
	// not a user-blocking lifecycle state.
	if (activity === "attaching") return "hidden";
	if (activity === "paused") return "paused";
	return "hidden";
};
