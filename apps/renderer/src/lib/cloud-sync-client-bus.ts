import { Cause, Effect, Fiber, Stream } from "effect";
import { useCallback, useSyncExternalStore } from "react";

import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import type { CloudSyncStatus } from "./bridge.ts";
import { prepareCloudWorkspaceSsh } from "./cloud-ssh-client-bus.ts";
import {
	cloudSyncPrefsFor,
	setCloudSyncPrefs,
} from "./cloud-workspace-catalog.ts";
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

const appBridge = () =>
	(globalThis.window?.zuse ?? globalThis.window?.memoize)?.app;

export const cloudSyncSupported = (): boolean =>
	appBridge()?.cloudSyncConfigure !== undefined;

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
	const app = appBridge();
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

const startSync = async (
	workspaceId: string,
	localPath: string,
): Promise<void> => {
	if (active.has(workspaceId)) return;
	const entry: ActiveSync = { fiber: null, stopped: false };
	active.set(workspaceId, entry);
	const app = appBridge();
	if (app?.cloudSyncConfigure === undefined) {
		active.delete(workspaceId);
		return;
	}
	try {
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
			error: cause instanceof Error ? cause.message : String(cause),
		});
	}
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
	const app = appBridge();
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

export const enableCloudSync = async (
	workspaceId: string,
	localPath: string,
): Promise<void> => {
	setCloudSyncPrefs(workspaceId, { enabled: true, localPath });
	await startSync(workspaceId, localPath);
};

export const disableCloudSync = async (workspaceId: string): Promise<void> => {
	const prefs = cloudSyncPrefsFor(workspaceId);
	// Remember the chosen folder so re-enabling doesn't re-prompt.
	setCloudSyncPrefs(
		workspaceId,
		prefs === null ? null : { ...prefs, enabled: false },
	);
	await stopSync(workspaceId);
};

export const pickCloudSyncFolder = (): Promise<string | null> =>
	appBridge()?.cloudSyncPickFolder?.() ?? Promise.resolve(null);

let wired = false;
const wire = (): void => {
	if (wired || typeof window === "undefined") return;
	wired = true;
	appBridge()?.onCloudSyncStatus?.((status) => {
		statuses.set(status.workspaceId, status);
		emit();
		// A stale ticket means rsync will soon fail auth: refresh it through the
		// normal prepare flow, which re-stages the ticket file for the bridge.
		if (status.enabled && status.ticketStale && active.has(status.workspaceId))
			void prepareCloudWorkspaceSsh(status.workspaceId).catch(() => undefined);
	});
	// Resume enabled syncs whenever their cloud environment (re)connects.
	useEnvironmentCatalogStore.subscribe((state) => {
		for (const entry of state.entries) {
			if (entry.connectionKind !== "relay" || entry.status !== "connected")
				continue;
			const prefs = cloudSyncPrefsFor(entry.environmentId);
			if (prefs?.enabled === true && !active.has(entry.environmentId)) {
				void startSync(entry.environmentId, prefs.localPath);
			}
		}
	});
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
