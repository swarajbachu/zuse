import { scopedCacheKey } from "@zuse/client-runtime/environment-scope";
import {
	decodeSessionTimelineCacheEntry,
	encodeSessionTimelineCacheEntry,
	type SessionTimelineCache,
	type SessionTimelineCacheEntry,
} from "@zuse/client-runtime/session-timeline-cache";
import type { SessionId } from "@zuse/contracts";
import { getActiveEnvironmentStorageScope } from "./renderer-environment-scope.ts";
import {
	decodeTimelineReadingPosition,
	encodeTimelineReadingPosition,
	type TimelineReadingPosition,
	type TimelineReadingPositionStore,
} from "./timeline-reading-position.ts";

const DATABASE_NAME = "zuse-session-timelines";
const DATABASE_VERSION = 3;
const STORE_NAME = "timelines";
const METADATA_STORE_NAME = "timeline-metadata";
const READING_POSITION_STORE_NAME = "reading-positions";
const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_READING_POSITIONS = 256;

export const environmentSessionCacheKey = (
	sessionId: SessionId,
	environmentId = getActiveEnvironmentStorageScope(),
): SessionId =>
	scopedCacheKey(environmentId, "session", sessionId) as SessionId;

export function resolveReadingPositionKeysToPrune(
	values: ReadonlyArray<unknown>,
	maxEntries = DEFAULT_MAX_READING_POSITIONS,
): SessionId[] {
	const valid: TimelineReadingPosition[] = [];
	const invalidKeys: SessionId[] = [];
	for (const value of values) {
		const decoded = decodeTimelineReadingPosition(value);
		if (decoded !== null) {
			valid.push(decoded);
			continue;
		}
		if (
			typeof value === "object" &&
			value !== null &&
			"sessionId" in value &&
			typeof value.sessionId === "string"
		) {
			invalidKeys.push(value.sessionId as SessionId);
		}
	}
	valid.sort(
		(left, right) =>
			right.updatedAt - left.updatedAt ||
			left.sessionId.localeCompare(right.sessionId),
	);
	return [
		...invalidKeys,
		...valid
			.slice(Math.max(0, maxEntries))
			.map((position) => position.sessionId),
	];
}

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
	new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("IndexedDB request failed"));
	});

const transactionComplete = (transaction: IDBTransaction): Promise<void> =>
	new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
		transaction.onerror = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction failed"));
	});

const openDatabase = (): Promise<IDBDatabase> =>
	new Promise((resolve, reject) => {
		const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
		request.onupgradeneeded = () => {
			const database = request.result;
			if (!database.objectStoreNames.contains(STORE_NAME)) {
				database.createObjectStore(STORE_NAME, { keyPath: "sessionId" });
			}
			if (!database.objectStoreNames.contains(METADATA_STORE_NAME)) {
				database.createObjectStore(METADATA_STORE_NAME, {
					keyPath: "sessionId",
				});
			}
			if (!database.objectStoreNames.contains(READING_POSITION_STORE_NAME)) {
				database.createObjectStore(READING_POSITION_STORE_NAME, {
					keyPath: "sessionId",
				});
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("Unable to open timeline cache"));
	});

class IndexedDbSessionTimelineCache implements SessionTimelineCache {
	private database: Promise<IDBDatabase> | null = null;

	private db(): Promise<IDBDatabase> {
		this.database ??= openDatabase();
		return this.database;
	}

	async load(sessionId: SessionId): Promise<SessionTimelineCacheEntry | null> {
		const storageKey = environmentSessionCacheKey(sessionId);
		const database = await this.db();
		const transaction = database.transaction(
			[STORE_NAME, METADATA_STORE_NAME],
			"readwrite",
		);
		const store = transaction.objectStore(STORE_NAME);
		const raw = await requestResult(store.get(storageKey));
		if (raw === undefined) {
			await transactionComplete(transaction);
			return null;
		}
		try {
			const decoded = decodeSessionTimelineCacheEntry(raw);
			const touched = { ...decoded, sessionId, accessedAt: Date.now() };
			store.put(
				encodeSessionTimelineCacheEntry({ ...touched, sessionId: storageKey }),
			);
			transaction.objectStore(METADATA_STORE_NAME).put({
				sessionId: storageKey,
				accessedAt: touched.accessedAt,
				estimatedBytes: touched.estimatedBytes,
			});
			await transactionComplete(transaction);
			return touched;
		} catch {
			store.delete(storageKey);
			transaction.objectStore(METADATA_STORE_NAME).delete(storageKey);
			await transactionComplete(transaction);
			return null;
		}
	}

	async save(entry: SessionTimelineCacheEntry): Promise<void> {
		const storageKey = environmentSessionCacheKey(entry.sessionId);
		const database = await this.db();
		const transaction = database.transaction(
			[STORE_NAME, METADATA_STORE_NAME],
			"readwrite",
		);
		const encoded = encodeSessionTimelineCacheEntry({
			...entry,
			sessionId: storageKey,
		});
		const persisted = {
			...(encoded as Record<string, unknown>),
			estimatedBytes: JSON.stringify(encoded).length,
		};
		transaction.objectStore(STORE_NAME).put(persisted);
		transaction.objectStore(METADATA_STORE_NAME).put({
			sessionId: storageKey,
			accessedAt: entry.accessedAt,
			estimatedBytes: persisted.estimatedBytes,
		});
		await transactionComplete(transaction);
	}

	async remove(sessionId: SessionId): Promise<void> {
		const storageKey = environmentSessionCacheKey(sessionId);
		const database = await this.db();
		const transaction = database.transaction(
			[STORE_NAME, METADATA_STORE_NAME],
			"readwrite",
		);
		transaction.objectStore(STORE_NAME).delete(storageKey);
		transaction.objectStore(METADATA_STORE_NAME).delete(storageKey);
		await transactionComplete(transaction);
	}

	async prune(
		limits: { readonly maxEntries?: number; readonly maxBytes?: number } = {},
	): Promise<void> {
		const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
		const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
		const database = await this.db();
		const transaction = database.transaction(
			[STORE_NAME, METADATA_STORE_NAME],
			"readwrite",
		);
		const store = transaction.objectStore(STORE_NAME);
		const metadataStore = transaction.objectStore(METADATA_STORE_NAME);
		const entries = (await requestResult(metadataStore.getAll())) as Array<{
			readonly sessionId: string;
			readonly accessedAt: number;
			readonly estimatedBytes: number;
		}>;
		entries.sort((left, right) => right.accessedAt - left.accessedAt);
		let retainedBytes = 0;
		for (const [index, entry] of entries.entries()) {
			retainedBytes += entry.estimatedBytes;
			if (index >= maxEntries || retainedBytes > maxBytes) {
				store.delete(entry.sessionId);
				metadataStore.delete(entry.sessionId);
			}
		}
		await transactionComplete(transaction);
	}
}

class IndexedDbTimelineReadingPositionStore
	implements TimelineReadingPositionStore
{
	private database: Promise<IDBDatabase> | null = null;

	private db(): Promise<IDBDatabase> {
		this.database ??= openDatabase();
		return this.database;
	}

	async load(sessionId: SessionId): Promise<TimelineReadingPosition | null> {
		const storageKey = environmentSessionCacheKey(sessionId);
		const database = await this.db();
		const transaction = database.transaction(
			READING_POSITION_STORE_NAME,
			"readwrite",
		);
		const store = transaction.objectStore(READING_POSITION_STORE_NAME);
		const raw = await requestResult(store.get(storageKey));
		const decoded = decodeTimelineReadingPosition(raw);
		if (raw !== undefined && decoded === null) store.delete(storageKey);
		await transactionComplete(transaction);
		return decoded === null ? null : { ...decoded, sessionId };
	}

	async save(position: TimelineReadingPosition): Promise<void> {
		const storageKey = environmentSessionCacheKey(position.sessionId);
		const database = await this.db();
		const transaction = database.transaction(
			READING_POSITION_STORE_NAME,
			"readwrite",
		);
		const store = transaction.objectStore(READING_POSITION_STORE_NAME);
		store.put(
			encodeTimelineReadingPosition({ ...position, sessionId: storageKey }),
		);
		const values = await requestResult(store.getAll());
		for (const sessionId of resolveReadingPositionKeysToPrune(values)) {
			store.delete(sessionId);
		}
		await transactionComplete(transaction);
	}

	async remove(sessionId: SessionId): Promise<void> {
		const storageKey = environmentSessionCacheKey(sessionId);
		const database = await this.db();
		const transaction = database.transaction(
			READING_POSITION_STORE_NAME,
			"readwrite",
		);
		transaction.objectStore(READING_POSITION_STORE_NAME).delete(storageKey);
		await transactionComplete(transaction);
	}
}

export const sessionTimelineCache: SessionTimelineCache | null =
	typeof indexedDB === "undefined" ? null : new IndexedDbSessionTimelineCache();

export const timelineReadingPositionStore: TimelineReadingPositionStore | null =
	typeof indexedDB === "undefined"
		? null
		: new IndexedDbTimelineReadingPositionStore();
