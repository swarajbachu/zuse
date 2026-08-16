import { Cause, Effect, Fiber, Stream } from "effect";
import { useCallback, useSyncExternalStore } from "react";

import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import { type CloudSyncStatus, getAppBridge } from "./bridge.ts";
import { prepareCloudWorkspaceSsh } from "./cloud-ssh-client-bus.ts";
import {
	cloudSummaryForEnvironment,
	cloudSyncPrefsFor,
	setCloudSyncPrefs,
	useCloudChatCatalogStore,
} from "./cloud-workspace-catalog.ts";
import { errorMessage } from "./error-message.ts";
import { getRendererClientBus } from "./session-timeline-client-bus.ts";

/**
 * Renderer side of the cloud→local file sync.
 *
 * The desktop main process owns the rsync mirror (cloud-sync-service.ts);
 * this adapter owns the change signal: while sync is enabled and the cloud
 * environment is connected, it holds an `fs.watchTree` subscription over the
 * existing gateway RPC connection and forwards change frames to the desktop.
 * Preferences persist per workspace in the cloud chat catalog.
 */

const CLOUD_WORKSPACE_ROOT = "/home/zuse/workspace";

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
		ticketStale: previous?.ticketStale ?? false,
		...patch,
	});
	emit();
};

interface ActiveSync {
	fiber: Fiber.Fiber<unknown, unknown> | null;
	stopped: boolean;
}
const active = new Map<string, ActiveSync>();

const resolveWorkspaceFolderId = async (
	workspaceId: string,
): Promise<string | null> => {
	const client = getRendererClientBus().client(workspaceId as never);
	if (client === null) return null;
	const folders = await Effect.runPromise(client["workspace.list"]({}));
	return (
		folders.find((folder) => folder.path === CLOUD_WORKSPACE_ROOT)?.id ??
		folders[0]?.id ??
		null
	);
};

const startWatcher = (workspaceId: string, entry: ActiveSync): void => {
	const client = getRendererClientBus().client(workspaceId as never);
	const app = getAppBridge();
	if (client === null || app?.cloudSyncRequest === undefined) return;
	const program = Effect.gen(function* () {
		const folderId = yield* Effect.promise(() =>
			resolveWorkspaceFolderId(workspaceId),
		);
		if (folderId === null) return;
		yield* Stream.runForEach(
			client["fs.watchTree"]({ folderId: folderId as never }),
			(event) =>
				Effect.sync(() => {
					if (event._tag !== "ready") void app.cloudSyncRequest?.(workspaceId);
				}),
		);
	}).pipe(
		Effect.catchCause((cause) =>
			Effect.sync(() => {
				if (entry.stopped || Cause.hasInterruptsOnly(cause)) return;
				// The periodic fallback in the desktop service keeps the mirror
				// converging even without change events; just drop the watcher.
				active.delete(workspaceId);
			}),
		),
	);
	entry.fiber = Effect.runFork(program);
};

const startSync = async (workspaceId: string): Promise<void> => {
	if (active.has(workspaceId)) return;
	const entry: ActiveSync = { fiber: null, stopped: false };
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
			state: "syncing",
			localPath,
			error: null,
		});
		const prepared = await prepareCloudWorkspaceSsh(workspaceId);
		const status = await app.cloudSyncConfigure({
			workspaceId,
			enabled: true,
			localPath,
			hostAlias: prepared.hostAlias,
			remotePath: prepared.remotePath,
		});
		if (status !== null) {
			statuses.set(workspaceId, status);
			emit();
		}
		if (!entry.stopped) startWatcher(workspaceId, entry);
	} catch (cause) {
		active.delete(workspaceId);
		setLocalStatus(workspaceId, {
			enabled: true,
			state: "error",
			error: errorMessage(cause, "Cloud sync failed."),
		});
	}
};

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

const stopSync = async (workspaceId: string): Promise<void> => {
	const entry = active.get(workspaceId);
	active.delete(workspaceId);
	if (entry !== undefined) {
		entry.stopped = true;
		const fiber = entry.fiber;
		entry.fiber = null;
		if (fiber !== null) await Effect.runPromise(Fiber.interrupt(fiber));
	}
	const app = getAppBridge();
	const status = await app?.cloudSyncConfigure?.({
		workspaceId,
		enabled: false,
		localPath: "",
		hostAlias: `zuse-${workspaceId}`,
		remotePath: CLOUD_WORKSPACE_ROOT,
	});
	if (status !== undefined && status !== null) {
		statuses.set(workspaceId, status);
		emit();
	} else {
		setLocalStatus(workspaceId, { enabled: false, state: "idle" });
	}
};

export const enableCloudSync = async (workspaceId: string): Promise<void> => {
	setCloudSyncPrefs(workspaceId, { enabled: true });
	await startSync(workspaceId);
};

export const disableCloudSync = async (workspaceId: string): Promise<void> => {
	const prefs = cloudSyncPrefsFor(workspaceId);
	setCloudSyncPrefs(workspaceId, prefs === null ? null : { enabled: false });
	await stopSync(workspaceId);
};

let wired = false;
const wire = (): void => {
	if (wired || typeof window === "undefined") return;
	wired = true;
	getAppBridge()?.onCloudSyncStatus?.((status) => {
		statuses.set(status.workspaceId, status);
		emit();
		// A stale ticket means rsync will soon fail auth: refresh it through the
		// normal prepare flow, which re-stages the ticket file for the bridge.
		if (status.enabled && status.ticketStale && active.has(status.workspaceId))
			void prepareCloudWorkspaceSsh(status.workspaceId).catch(() => undefined);
	});
	const startAutomaticSyncs = () => {
		const summaries = useCloudChatCatalogStore.getState().summaries;
		for (const workspaceId of active.keys()) {
			if (
				!summaries.some(
					(summary) =>
						summary.workspaceId === workspaceId && summary.state !== "archived",
				)
			)
				void stopSync(workspaceId);
		}
		const connected = new Set(
			useEnvironmentCatalogStore
				.getState()
				.entries.filter(
					(entry) =>
						entry.connectionKind === "relay" && entry.status === "connected",
				)
				.map((entry) => entry.environmentId),
		);
		for (const summary of summaries) {
			if (
				summary.state !== "archived" &&
				connected.has(summary.workspaceId) &&
				cloudSyncPrefsFor(summary.workspaceId)?.enabled !== false &&
				!active.has(summary.workspaceId)
			)
				void startSync(summary.workspaceId);
		}
	};
	useEnvironmentCatalogStore.subscribe(startAutomaticSyncs);
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
