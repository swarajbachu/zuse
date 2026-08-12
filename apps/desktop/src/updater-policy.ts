import type { UpdateStatus } from "@zuse/contracts";

export function shouldAutoInstallUpdateOnQuit(
	platform: NodeJS.Platform,
): boolean {
	return platform !== "darwin";
}

export function shouldInstallPendingUpdateOnQuit(options: {
	platform: NodeJS.Platform;
	status: UpdateStatus;
	installing: boolean;
}): boolean {
	return (
		options.platform === "darwin" &&
		options.status.kind === "ready" &&
		!options.installing
	);
}
