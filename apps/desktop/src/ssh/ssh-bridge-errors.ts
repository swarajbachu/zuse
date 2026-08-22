export interface SshBridgeFailure {
	readonly detail?: string;
	readonly closeCode?: number;
	readonly timedOut?: boolean;
}

/** Convert transport failures into actionable messages without leaking URLs/tickets. */
export const sanitizedSshBridgeFailure = ({
	detail = "",
	closeCode,
	timedOut = false,
}: SshBridgeFailure): string => {
	const normalized = detail.toLowerCase();
	if (timedOut || normalized.includes("timed out")) {
		return "zuse ssh bridge: connection timed out. Check the network and resume the workspace in Zuse.";
	}
	if (
		normalized.includes("401") ||
		normalized.includes("unauthorized") ||
		normalized.includes("invalid ticket")
	) {
		return "zuse ssh bridge: SSH access was rejected. Refresh workspace access in Zuse.";
	}
	if (normalized.includes("403") || normalized.includes("forbidden")) {
		return "zuse ssh bridge: this device is not authorized for the cloud workspace. Refresh access in Zuse.";
	}
	if (
		normalized.includes("sandbox was not found") ||
		normalized.includes("sandbox not found") ||
		normalized.includes("workspace was not found")
	) {
		return "zuse ssh bridge: the cloud workspace is not running. Resume it in Zuse and try again.";
	}
	if (closeCode !== undefined && closeCode !== 1000) {
		return `zuse ssh bridge: the cloud connection closed unexpectedly (code ${closeCode}). Resume the workspace in Zuse or refresh access.`;
	}
	return "zuse ssh bridge: could not reach the cloud workspace. Check the network and workspace status in Zuse.";
};
