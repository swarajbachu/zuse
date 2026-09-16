import { terminalOwnerLimitMessage } from "@zuse/client-runtime/terminal-catalog";
import type { EnvironmentId, PtyOwnerId } from "@zuse/contracts";
import {
	type TerminalInstance,
	terminalOwnerLiveLimit,
	terminalOwnerOccupancy,
} from "../store/terminals.ts";

/** Conservative UI gate; the server remains authoritative after hydration. */
export const terminalOwnerLimitReached = (
	terminals: ReadonlyArray<TerminalInstance>,
	environmentId: EnvironmentId,
	ownerId: PtyOwnerId,
): boolean => {
	const { liveLimit, occupied } = terminalOwnerOccupancy(
		terminals,
		environmentId,
		ownerId,
	);
	return liveLimit !== null && occupied >= liveLimit;
};

export const terminalOwnerLimitMessageFor = (
	environmentId: EnvironmentId,
	ownerId: PtyOwnerId,
): string =>
	terminalOwnerLimitMessage(terminalOwnerLiveLimit(environmentId, ownerId));
