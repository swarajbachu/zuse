import {
	type PtyOpenToken,
	type PtyOwnerId,
	PtyOwnership,
} from "@zuse/contracts";

export const mobileTerminalOpenOwnership = (
	ownerId: PtyOwnerId,
	openToken: PtyOpenToken,
	label: string,
	sessionScoped: boolean | undefined,
) =>
	PtyOwnership.make({
		ownerId,
		openToken,
		label,
		scope: sessionScoped === false ? "environment" : "session",
	});
