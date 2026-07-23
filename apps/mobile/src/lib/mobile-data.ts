import { Effect } from "effect";

import { clearDeviceKey } from "../auth/dpop";
import { signOut as clearAccountSession } from "../auth/workos";
import { clearPushRegistration } from "../notifications/push";
import { clearDownloadedCache, clearOfflineCache } from "../offline/cache";
import { disposeConnection } from "../rpc/connection";
import { resetRelayAccessToken } from "../rpc/relay-client";
import { resetAvailabilityRuntime } from "../store/availability";
import { resetConnectionRuntimeState } from "../store/connection-runtime";
import { clearConnections, currentConnections } from "../store/connections";
import { resetEnvironmentsRuntime } from "../store/environments";
import { resetGoalsRuntime } from "../store/goals";
import { resetMessagesRuntime } from "../store/messages";
import { resetOutboxRuntime } from "../store/outbox";
import { resetPermissionsRuntime } from "../store/permissions";
import { clearPinnedChats } from "../store/pinned-chats";
import { resetPrStateRuntime } from "../store/pr-state";
import { resetProjectOriginRuntime } from "../store/project-origins";
import { resetSessionsRuntime } from "../store/sessions";
import { resetMobileAnalyticsIdentity } from "./analytics";
import { optionsForConnection } from "./connection-params";
import { clearLastCrashReport } from "./crash-reporting";

const resetDownloadedMemory = async (): Promise<void> => {
	await Promise.all([
		resetSessionsRuntime(),
		resetMessagesRuntime(),
		resetGoalsRuntime(),
		resetPermissionsRuntime(),
	]);
	resetAvailabilityRuntime();
	resetPrStateRuntime();
	resetProjectOriginRuntime();
};

export const clearDownloadedMobileData = async (): Promise<void> => {
	await resetDownloadedMemory();
	await Effect.runPromise(clearDownloadedCache());
};

export const resetLocalMobileData = async (): Promise<void> => {
	const connections = currentConnections();
	await resetOutboxRuntime();
	await Promise.all(
		connections.flatMap((connection) => {
			const options = optionsForConnection(connection.key, connections);
			return options === null
				? []
				: [disposeConnection(options).catch(() => {})];
		}),
	);
	await resetDownloadedMemory();
	resetConnectionRuntimeState();
	resetEnvironmentsRuntime();

	const cleanup = await Promise.allSettled([
		clearAccountSession(),
		clearDeviceKey(),
		clearPushRegistration(),
		Effect.runPromise(clearOfflineCache()),
		clearConnections(),
		clearPinnedChats(),
		clearLastCrashReport(),
		resetMobileAnalyticsIdentity(),
	]);
	resetRelayAccessToken();
	if (cleanup.some((result) => result.status === "rejected")) {
		throw new Error(
			"Some local files could not be cleared. Restart the app and try again.",
		);
	}
};
