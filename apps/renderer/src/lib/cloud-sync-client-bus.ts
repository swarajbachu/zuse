import { EnvironmentId } from "@zuse/contracts";
import { Effect } from "effect";
import { useCallback, useSyncExternalStore } from "react";
import { type CloudSyncStatus, getAppBridge } from "./bridge.ts";
import { prepareCloudWorkspaceSsh } from "./cloud-ssh-client-bus.ts";
import {
	CloudSyncLifecycleQueue,
	reconcileAutomaticCloudSyncs,
} from "./cloud-sync-lifecycle.ts";
import {
	cloudSummaryForEnvironment,
	cloudSyncPreferenceEnabled,
	cloudSyncPrefsFor,
	setCloudSyncPrefs,
	useCloudChatCatalogStore,
} from "./cloud-workspace-catalog.ts";
import { errorMessage } from "./error-message.ts";

/**
 * Renderer side of the cloud→local file sync.
 *
 * The desktop main process owns the snapshot worker (cloud-sync-service.ts);
 * this adapter prepares access and reconciles enabled workspaces. The desktop
 * polls Git-selected manifests; filesystem watchers do not control publication.
 * Preferences persist per workspace in the cloud chat catalog.
 */

export const cloudSyncSupported = (): boolean =>
	getAppBridge()?.cloudSyncConfigure !== undefined;

const statuses = new Map<string, CloudSyncStatus>();
const listeners = new Set<() => void>();
const emit = (): void => {
	for (const listener of listeners) listener();
};

const setLocalStatus = (
	workspaceId: string,
	patch: Partial<CloudSyncStatus>,
): void => {
	const previous = statuses.get(workspaceId);
	statuses.set(workspaceId, {
		workspaceId,
		enabled: previous?.enabled ?? false,
		state: previous?.state ?? "idle",
		localPath: previous?.localPath ?? null,
		lastSyncedAt: previous?.lastSyncedAt ?? null,
		error: previous?.error ?? null,
		accessRefreshRequired: previous?.accessRefreshRequired ?? false,
		...patch,
	});
	emit();
};

interface ActiveSync {
	stopped: boolean;
	abort: AbortController;
}
const active = new Map<string, ActiveSync>();
const lifecycleQueue = new CloudSyncLifecycleQueue();
let reconcileSyncs = () => {};
const ACCESS_REFRESH_BACKOFF_MS = 1_000;
const setupRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const accessRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

const cancelAccessRefresh = (workspaceId: string): void => {
	const timer = accessRefreshTimers.get(workspaceId);
	if (timer !== undefined) clearTimeout(timer);
	accessRefreshTimers.delete(workspaceId);
};

const scheduleAccessRefresh = (workspaceId: string): void => {
	if (accessRefreshTimers.has(workspaceId) || !active.has(workspaceId)) return;
	const timer = setTimeout(() => {
		accessRefreshTimers.delete(workspaceId);
		void stopSync(workspaceId)
			.then(() => startSync(workspaceId))
			.catch(() => undefined);
	}, ACCESS_REFRESH_BACKOFF_MS);
	accessRefreshTimers.set(workspaceId, timer);
};

const waitForAccess = (workspaceId: string, signal: AbortSignal) =>
	new Promise<Awaited<ReturnType<typeof prepareCloudWorkspaceSsh>>>(
		(resolve, reject) => {
			const finish = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
			};
			const abort = () => {
				finish();
				reject(new Error("Sync setup cancelled."));
			};
			const timer = setTimeout(() => {
				finish();
				reject(
					new Error(
						"Timed out preparing cloud sync access. Reconnect the workspace and retry.",
					),
				);
			}, 30_000);
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) {
				abort();
				return;
			}
			void prepareCloudWorkspaceSsh(workspaceId).then(
				(value) => {
					finish();
					resolve(value);
				},
				(cause) => {
					finish();
					reject(cause);
				},
			);
		},
	);

const startSyncNow = async (workspaceId: string): Promise<void> => {
	if (active.has(workspaceId) || setupRetryTimers.has(workspaceId)) return;
	const entry: ActiveSync = {
		stopped: false,
		abort: new AbortController(),
	};
	active.set(workspaceId, entry);
	const app = getAppBridge();
	if (app?.cloudSyncConfigure === undefined) {
		active.delete(workspaceId);
		return;
	}
	try {
		const localPath = await cloudSyncLocalPath(workspaceId);
		if (localPath == null)
			throw new Error("Could not resolve the local cloud workspace path.");
		setLocalStatus(workspaceId, {
			enabled: true,
			state: "pending",
			localPath,
			error: null,
		});
		const prepared = await waitForAccess(workspaceId, entry.abort.signal);
		if (entry.stopped) return;

		const status = await app.cloudSyncConfigure({
			workspaceId,
			enabled: true,
			localPath,
			hostAlias: prepared.hostAlias,
			remotePath: prepared.remotePath,
		});
		if (status === null)
			throw new Error("Desktop rejected the cloud sync configuration.");
		statuses.set(workspaceId, status);
		emit();
	} catch (cause) {
		if (entry.stopped) return;
		entry.stopped = true;
		active.delete(workspaceId);
		setupRetryTimers.set(
			workspaceId,
			setTimeout(() => {
				setupRetryTimers.delete(workspaceId);
				const ready =
					cloudSummaryForEnvironment(workspaceId)?.state === "ready";
				if (ready && cloudSyncPreferenceEnabled(cloudSyncPrefsFor(workspaceId)))
					void startSync(workspaceId);
			}, 30_000),
		);
		setLocalStatus(workspaceId, {
			enabled: true,
			state: "error",
			error: errorMessage(cause, "Cloud sync failed."),
		});
	}
};

const startSync = (workspaceId: string): Promise<void> =>
	lifecycleQueue.run(workspaceId, () => startSyncNow(workspaceId));

export const cloudSyncLocalPath = async (
	workspaceId: string,
): Promise<string | null> => {
	const summary = cloudSummaryForEnvironment(workspaceId);
	return summary === null
		? null
		: ((await getAppBridge()?.cloudSyncDefaultPath?.(
				workspaceId,
				summary.repositoryDisplayName,
				summary.branch,
			)) ?? null);
};

const stopSyncNow = async (workspaceId: string): Promise<void> => {
	cancelAccessRefresh(workspaceId);
	clearTimeout(setupRetryTimers.get(workspaceId));
	setupRetryTimers.delete(workspaceId);
	const entry = active.get(workspaceId);
	active.delete(workspaceId);
	if (entry !== undefined) {
		entry.stopped = true;
		entry.abort.abort();
	}
	const app = getAppBridge();
	const status = await app?.cloudSyncConfigure?.({
		workspaceId,
		enabled: false,
		localPath: "",
		hostAlias: `zuse-${workspaceId}`,
		remotePath: "",
	});
	if (status !== undefined && status !== null) {
		statuses.set(workspaceId, status);
		emit();
	} else {
		setLocalStatus(workspaceId, { enabled: false, state: "idle" });
	}
};

const stopSync = (workspaceId: string): Promise<void> => {
	const entry = active.get(workspaceId);
	if (entry) {
		entry.stopped = true;
		entry.abort.abort();
	}
	return lifecycleQueue
		.run(workspaceId, () => stopSyncNow(workspaceId))
		.finally(() => reconcileSyncs());
};

export const enableCloudSync = async (workspaceId: string): Promise<void> => {
	setCloudSyncPrefs(workspaceId, { enabled: true });
	clearTimeout(setupRetryTimers.get(workspaceId));
	setupRetryTimers.delete(workspaceId);
	await startSync(workspaceId);
};

export const disableCloudSync = async (workspaceId: string): Promise<void> => {
	setCloudSyncPrefs(workspaceId, { enabled: false });
	await stopSync(workspaceId);
};

let wired = false;
const wire = (): void => {
	if (wired || typeof window === "undefined") return;
	wired = true;
	getAppBridge()?.onCloudSyncReadFile?.(async ({ workspaceId, path }) => {
		const { getRendererClientBus } = await import(
			"./session-timeline-client-bus.ts"
		);
		const client = getRendererClientBus().client(
			EnvironmentId.make(workspaceId),
		);
		if (client === null)
			throw new Error("Workspace gateway disconnected during sync.");
		const file = await Effect.runPromise(
			client["fs.readExternalFile"]({ path }).pipe(Effect.timeout(30000)),
		);
		return file.kind === "binary"
			? file.bytes
			: new TextEncoder().encode(file.content);
	});
	getAppBridge()?.onCloudSyncStatus?.((status) => {
		statuses.set(status.workspaceId, status);
		emit();
		if (
			status.enabled &&
			status.accessRefreshRequired &&
			active.has(status.workspaceId)
		)
			scheduleAccessRefresh(status.workspaceId);
	});
	const startAutomaticSyncs = () => {
		const summaries = useCloudChatCatalogStore.getState().summaries;

		reconcileAutomaticCloudSyncs({
			summaries,
			activeWorkspaceIds: new Set([
				...active.keys(),
				...setupRetryTimers.keys(),
			]),
			enabled: (workspaceId) =>
				cloudSyncPreferenceEnabled(cloudSyncPrefsFor(workspaceId)),
			start: (workspaceId) => void startSync(workspaceId),
			stop: (workspaceId) => void stopSync(workspaceId),
		});
	};
	reconcileSyncs = startAutomaticSyncs;
	useCloudChatCatalogStore.subscribe(startAutomaticSyncs);
	startAutomaticSyncs();
};
wire();

const EMPTY_STATUS: CloudSyncStatus | null = null;

export const useCloudSyncStatus = (
	workspaceId: string | null,
): CloudSyncStatus | null => {
	const subscribe = useCallback((listener: () => void) => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	}, []);
	const snapshot = useCallback(
		() =>
			workspaceId === null
				? EMPTY_STATUS
				: (statuses.get(workspaceId) ?? EMPTY_STATUS),
		[workspaceId],
	);
	return useSyncExternalStore(subscribe, snapshot, snapshot);
};
