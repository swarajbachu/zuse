import { Effect } from "effect";

import { clearDeviceKey } from "../auth/dpop";
import { signOut as clearAccountSession } from "../auth/workos";
import { clearPushRegistration } from "../notifications/push";
import { clearDownloadedCache, clearOfflineCache } from "../offline/cache";
import { disposeConnection } from "../rpc/connection";
import { resetRelayAccessToken } from "../rpc/relay-client";
import { useAvailabilityStore } from "../store/availability";
import { resetConnectionRuntimeState } from "../store/connection-runtime";
import { useConnectionsStore } from "../store/connections";
import { useEnvironmentsStore } from "../store/environments";
import { resetGoalsRuntime } from "../store/goals";
import { resetMessagesRuntime } from "../store/messages";
import { resetOutboxRuntime } from "../store/outbox";
import { resetPermissionsRuntime } from "../store/permissions";
import { usePinnedChatsStore } from "../store/pinned-chats";
import { usePrStateStore } from "../store/pr-state";
import { useProjectOriginStore } from "../store/project-origins";
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
	useAvailabilityStore.setState({
		availabilityByConnection: {},
		loadingByConnection: {},
	});
	usePrStateStore.setState({ byKey: {}, loadingByKey: {} });
	useProjectOriginStore.setState({ byKey: {}, loadingByKey: {} });
};

export const clearDownloadedMobileData = async (): Promise<void> => {
	await resetDownloadedMemory();
	await Effect.runPromise(clearDownloadedCache());
};

export const resetLocalMobileData = async (): Promise<void> => {
	const connections = useConnectionsStore.getState().connections;
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
	useEnvironmentsStore.setState({
		environments: [],
		loading: false,
		error: null,
	});

	const cleanup = await Promise.allSettled([
		clearAccountSession(),
		clearDeviceKey(),
		clearPushRegistration(),
		Effect.runPromise(clearOfflineCache()),
		useConnectionsStore.getState().clear(),
		usePinnedChatsStore.getState().clear(),
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
