import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { KeyedSerialWorker } from "@zuse/utils/keyed-worker";
import {
	applySnapshot,
	cachedBaseline,
	downloadSnapshot,
	localBaseline,
	readSyncManifest,
	SYNC_MARKER_FILE,
	writeSyncManifest,
} from "./cloud-sync-snapshot.ts";

export { SYNC_MARKER_FILE } from "./cloud-sync-snapshot.ts";

const BATCH_INTERVAL_MS = 15_000;
const RECONCILE_MS = 30_000;
export type CloudSyncState =
	| "idle"
	| "pending"
	| "syncing"
	| "in-sync"
	| "error";

export interface CloudSyncStatus {
	readonly progress?: {
		phase: "scanning" | "downloading" | "applying";
		files: number;
		total: number;
		bytes: number;
	};
	readonly workspaceId: string;
	readonly enabled: boolean;
	readonly state: CloudSyncState;
	readonly localPath: string | null;
	readonly lastSyncedAt: number | null;
	readonly error: string | null;
	/** Access is near expiry or the SSH transport failed and must be refreshed. */
	readonly accessRefreshRequired: boolean;
}

export interface CloudSyncConfigureInput {
	readonly workspaceId: string;
	readonly enabled: boolean;
	readonly localPath: string;
	readonly hostAlias: string;
	readonly remotePath: string;
}

export const cloudSyncDefaultPath = (
	home: string,
	repository: unknown,
	branch: unknown,
): string | null => {
	if (typeof repository !== "string" || typeof branch !== "string") return null;
	const repositoryName = repository
		.split(/[\\/]/u)
		.at(-1)
		?.replace(/\.git$/u, "");
	if (repositoryName === undefined) return null;
	const segments = [repositoryName, ...branch.split("/")];
	return segments.some(
		(segment) => !/^(?!\.{1,2}$)[A-Za-z0-9._-]+$/u.test(segment),
	)
		? null
		: join(home, ".zuse", "cloud", ...segments);
};

interface SyncEntry {
	progress?: CloudSyncStatus["progress"];
	config: CloudSyncConfigureInput;
	state: CloudSyncState;
	lastSyncedAt: number | null;
	error: string | null;
	accessRefreshRequired: boolean;
	generation: number;
	dirty: boolean;
	lastAttemptAt: number;
	retryAt: number;
	backoff: number;
	timer: NodeJS.Timeout | null;
	abort: AbortController | null;
	completion: Promise<void> | null;
	blocked: boolean;
}

/** Git-selected, content-verified incremental snapshots. Events are hints, not gates. */
export class CloudSyncManager {
	private readonly entries = new Map<string, SyncEntry>();
	private readonly configurations = new KeyedSerialWorker<string>();
	private disposed = false;
	constructor(
		private readonly notify: (status: CloudSyncStatus) => void,
		private readonly download: typeof downloadSnapshot = downloadSnapshot,
		private readonly apply: typeof applySnapshot = applySnapshot,
		private readonly readRemoteFile?: (
			workspaceId: string,
			path: string,
			signal: AbortSignal,
		) => Promise<Uint8Array>,
	) {}
	status(workspaceId: string): CloudSyncStatus {
		const entry = this.entries.get(workspaceId);
		return {
			workspaceId,
			enabled: entry?.config.enabled ?? false,
			state: entry?.state ?? "idle",
			localPath: entry?.config.localPath ?? null,
			lastSyncedAt: entry?.lastSyncedAt ?? null,
			error: entry?.error ?? null,
			accessRefreshRequired: entry?.accessRefreshRequired ?? false,
			progress: entry?.progress,
		};
	}
	private publish(id: string) {
		this.notify(this.status(id));
	}
	configure(input: CloudSyncConfigureInput): Promise<CloudSyncStatus> {
		return this.configurations.run(input.workspaceId, async () => {
			const old = this.entries.get(input.workspaceId);
			if (old) {
				clearTimeout(old.timer ?? undefined);
				old.blocked = true;
				old.abort?.abort();
				await old.completion;
			}
			if (this.disposed) return this.status(input.workspaceId);
			const entry: SyncEntry = {
				config: input.enabled
					? input
					: { ...input, localPath: old?.config.localPath ?? input.localPath },
				state: input.enabled ? "pending" : "idle",
				lastSyncedAt: old?.lastSyncedAt ?? null,
				error: null,
				accessRefreshRequired: false,
				generation: 0,
				dirty: true,
				lastAttemptAt: old?.lastAttemptAt ?? -Infinity,
				retryAt: old?.retryAt ?? 0,
				backoff: old?.backoff ?? BATCH_INTERVAL_MS,
				timer: null,
				abort: null,
				completion: null,
				blocked: !input.enabled,
			};
			this.entries.set(input.workspaceId, entry);
			if (input.enabled) {
				try {
					await mkdir(input.localPath, { recursive: true });
					const contents = await readdir(input.localPath);
					if (contents.length === 0)
						await writeSyncManifest(input.localPath, {
							version: 1,
							workspaceId: input.workspaceId,
							files: [],
						});
					else if (!contents.includes(SYNC_MARKER_FILE))
						throw new Error(
							"The chosen folder is not empty. Pick an empty folder or a previous sync target.",
						);
					await readSyncManifest(input.localPath, input.workspaceId);
					this.schedule(input.workspaceId, entry, 0);
				} catch (cause) {
					entry.blocked = true;
					entry.state = "error";
					entry.error = cause instanceof Error ? cause.message : String(cause);
				}
			}
			this.publish(input.workspaceId);
			return this.status(input.workspaceId);
		});
	}
	requestSync(id: string): void {
		const entry = this.entries.get(id);
		if (!entry || entry.blocked || this.disposed) return;
		entry.generation++;
		entry.dirty = true;
		// A stream of hints can accelerate a periodic scan, never postpone one.
		if (!entry.completion) this.schedule(id, entry, BATCH_INTERVAL_MS);
	}
	private schedule(id: string, entry: SyncEntry, delay: number): void {
		if (entry.blocked || this.disposed || entry.completion) return;
		clearTimeout(entry.timer ?? undefined);
		const due = Math.max(
			Date.now() + (entry.dirty ? 0 : delay),
			entry.lastAttemptAt + BATCH_INTERVAL_MS,
			entry.retryAt,
		);
		entry.timer = setTimeout(
			() => {
				entry.timer = null;
				if (entry.blocked || this.disposed || this.entries.get(id) !== entry)
					return;
				const operation = this.scan(id, entry).finally(() => {
					entry.completion = null;
					this.schedule(id, entry, RECONCILE_MS);
				});
				entry.completion = operation;
			},
			Math.max(0, due - Date.now()),
		);
		entry.timer.unref?.();
	}
	private async scan(id: string, entry: SyncEntry): Promise<void> {
		const generation = entry.generation;
		const controller = new AbortController();
		entry.abort = controller;
		entry.lastAttemptAt = Date.now();
		entry.state = "syncing";
		entry.error = null;
		entry.progress = { phase: "scanning", files: 0, total: 0, bytes: 0 };
		this.publish(id);
		const staging = `${resolve(entry.config.localPath)}.zuse-sync-cache`;
		try {
			const previous = await readSyncManifest(entry.config.localPath, id);
			const local = await localBaseline(entry.config.localPath, previous.files);
			if (controller.signal.aborted) return;
			await mkdir(staging, { recursive: true });
			if ((await readdir(staging)).length === 0)
				await writeSyncManifest(staging, {
					version: 1,
					workspaceId: id,
					files: [],
				});
			await readSyncManifest(staging, id);
			const cached = await cachedBaseline(staging);
			const baseline = [
				...new Map(
					[...local, ...cached].map((file) => [file.path, file]),
				).values(),
			];
			let lastProgressAt = 0;
			const readRemoteFile = this.readRemoteFile;
			const files = await this.download(
				{
					...entry.config,
					readRemoteFile: readRemoteFile
						? (path, signal) => readRemoteFile(id, path, signal)
						: undefined,
				},
				staging,
				baseline,
				controller.signal,
				(progress) => {
					entry.progress = { ...progress, phase: "downloading" };
					if (
						Date.now() - lastProgressAt >= 250 &&
						!controller.signal.aborted
					) {
						lastProgressAt = Date.now();
						this.publish(id);
					}
				},
			);
			if (controller.signal.aborted) return;
			entry.progress = {
				files: files.length,
				total: files.length,
				bytes: entry.progress?.bytes ?? 0,
				phase: "applying",
			};
			this.publish(id);
			await this.apply(
				entry.config.localPath,
				staging,
				previous,
				files,
				controller.signal,
			);
			if (controller.signal.aborted) return;
			entry.lastSyncedAt = Date.now();
			entry.lastAttemptAt = Date.now();
			entry.dirty = generation !== entry.generation;
			entry.state = "in-sync";
			entry.progress = undefined;
			entry.error = null;
			entry.accessRefreshRequired = false;
			entry.retryAt = 0;
			entry.backoff = BATCH_INTERVAL_MS;
		} catch (cause) {
			if (!controller.signal.aborted) {
				entry.state = "error";
				entry.error = cause instanceof Error ? cause.message : String(cause);
				entry.accessRefreshRequired = sshTransportFailed(entry.error);
				entry.dirty = true;
				entry.retryAt = Date.now() + entry.backoff;
				entry.backoff = Math.min(entry.backoff * 2, 60_000);
			}
		} finally {
			entry.abort = null;
			if (!entry.blocked && !this.disposed) this.publish(id);
		}
	}
	async dispose(): Promise<void> {
		this.disposed = true;
		for (const entry of this.entries.values()) {
			clearTimeout(entry.timer ?? undefined);
			entry.abort?.abort();
		}
		await this.configurations.close();
		await Promise.all([...this.entries.values()].map((e) => e.completion));
		this.entries.clear();
	}
}
export const sshTransportFailed = (stderr: string): boolean =>
	/(?:zuse ssh bridge:|permission denied|connection (?:unexpectedly )?(?:closed|reset|timed out)|kex_exchange_identification|broken pipe|no route to host|could not resolve hostname)/iu.test(
		stderr,
	);
