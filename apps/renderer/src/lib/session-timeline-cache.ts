import {
	resourceRefKey,
	type SessionRef,
} from "@zuse/client-runtime/resource-ref";
import {
	decodeSessionTimelineCacheEntry,
	encodeSessionTimelineCacheEntry,
	type SessionTimelineCache,
	type SessionTimelineCacheEntry,
} from "@zuse/client-runtime/session-timeline-cache";
import {
	Message,
	type SessionId,
	type SessionStreamCursor,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { Schema } from "effect";
import { hostedCacheDatabaseName } from "./hosted-connect.ts";
import {
	decodeTimelineReadingPosition,
	encodeTimelineReadingPosition,
	type TimelineReadingPosition,
	type TimelineReadingPositionStore,
} from "./timeline-reading-position.ts";

const DATABASE_NAME = "zuse-session-timelines";
const DATABASE_VERSION = 6;
const HISTORY_STORE_NAME = "cloud-history-pages";
const STORE_NAME = "timelines";
const METADATA_STORE_NAME = "timeline-metadata";
const READING_POSITION_STORE_NAME = "reading-positions";
const CLOUD_CATALOG_STORE_NAME = "cloud-catalog";
const CLOUD_CATALOG_KEY = "catalog";
const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_READING_POSITIONS = 256;

export const environmentSessionCacheKey = (ref: SessionRef): SessionId =>
	resourceRefKey(ref) as SessionId;

export const shouldPersistTimelineCheckpoint = (
	existing: SessionTimelineCacheEntry,
	next: SessionTimelineCacheEntry,
): boolean =>
	existing.cursor.epoch !== next.cursor.epoch ||
	existing.cursor.version <= next.cursor.version;

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

const cloudHeads = new Map<
	string,
	{ epoch: string; firstId: string | undefined; olderSequence: number | null }
>();
export const rememberCloudTimelineHead = (
	ref: SessionRef,
	projection: SessionTimelineProjection,
	cursor: SessionStreamCursor,
): void => {
	cloudHeads.set(environmentSessionCacheKey(ref), {
		epoch: cursor.epoch,
		firstId: projection.messages[0]?.id,
		olderSequence: projection.olderMessageSequence ?? null,
	});
};
const cloudHeadEntry = (
	entry: SessionTimelineCacheEntry,
): SessionTimelineCacheEntry => {
	const head = cloudHeads.get(environmentSessionCacheKey(entry.ref));
	if (!head || head.epoch !== entry.cursor.epoch) return entry;
	const index = entry.projection.messages.findIndex(
		(message) => message.id === head.firstId,
	);
	if (index < 0) return entry;
	return {
		...entry,
		projection: SessionTimelineProjection.make({
			...entry.projection,
			messages: entry.projection.messages.slice(index),
			olderMessageSequence: head.olderSequence,
		}),
	};
};
const HistoryPage = Schema.Struct({
	messages: Schema.Array(Message),
	olderMessageSequence: Schema.NullOr(Schema.Number),
});
type HistoryPage = typeof HistoryPage.Type;
const historyPageKey = (
	ref: SessionRef,
	cursor: SessionStreamCursor,
	before: number,
) =>
	JSON.stringify([
		environmentSessionCacheKey(ref),
		cursor.epoch,
		cursor.version,
		before,
	]);

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
		const request = indexedDB.open(
			hostedCacheDatabaseName(DATABASE_NAME),
			DATABASE_VERSION,
		);
		request.onupgradeneeded = (event) => {
			const database = request.result;
			if (!database.objectStoreNames.contains(HISTORY_STORE_NAME)) {
				const pages = database.createObjectStore(HISTORY_STORE_NAME, {
					keyPath: "key",
				});
				pages.createIndex("resource", "resource");
			}
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
			if (!database.objectStoreNames.contains(CLOUD_CATALOG_STORE_NAME)) {
				database.createObjectStore(CLOUD_CATALOG_STORE_NAME);
			}
			// Versions before 4 used an ambient active-environment value when
			// reading/writing. Those keys cannot be migrated safely because a late
			// async write may have been attributed to the wrong environment.
			if (event.oldVersion > 0 && event.oldVersion < 4) {
				for (const name of [
					STORE_NAME,
					METADATA_STORE_NAME,
					READING_POSITION_STORE_NAME,
				]) {
					request.transaction?.objectStore(name).clear();
				}
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

	async load(ref: SessionRef): Promise<SessionTimelineCacheEntry | null> {
		const storageKey = environmentSessionCacheKey(ref);
		const database = await this.db();
		const transaction = database.transaction(
			[STORE_NAME, METADATA_STORE_NAME, HISTORY_STORE_NAME],
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
			const touched = { ...decoded, ref, accessedAt: Date.now() };
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

	async save(fullEntry: SessionTimelineCacheEntry): Promise<void> {
		const entry = cloudHeadEntry(fullEntry);
		const storageKey = environmentSessionCacheKey(entry.ref);
		const database = await this.db();
		const transaction = database.transaction(
			[STORE_NAME, METADATA_STORE_NAME, HISTORY_STORE_NAME],
			"readwrite",
		);
		const store = transaction.objectStore(STORE_NAME);
		const existingRaw = await requestResult(store.get(storageKey));
		if (existingRaw !== undefined) {
			try {
				const existing = decodeSessionTimelineCacheEntry(existingRaw);
				// Delayed checkpoint writes are serialized by ClientBus, but a second
				// app surface or old process can still race this IndexedDB record. Only
				// an explicit epoch reset may move the durable cursor backwards.
				if (!shouldPersistTimelineCheckpoint(existing, entry)) {
					await transactionComplete(transaction);
					return;
				}
			} catch {
				// Replace malformed cache data with the current validated checkpoint.
			}
		}
		const encoded = encodeSessionTimelineCacheEntry(entry);
		const persisted = {
			...(encoded as Record<string, unknown>),
			estimatedBytes: JSON.stringify(encoded).length,
		};
		store.put(persisted);
		transaction.objectStore(METADATA_STORE_NAME).put({
			sessionId: storageKey,
			accessedAt: entry.accessedAt,
			estimatedBytes: persisted.estimatedBytes,
		});
		await transactionComplete(transaction);
	}

	async loadHistoryPage(
		ref: SessionRef,
		cursor: SessionStreamCursor,
		before: number,
	): Promise<HistoryPage | null> {
		const database = await this.db();
		const transaction = database.transaction(HISTORY_STORE_NAME, "readonly");
		const record = await requestResult(
			transaction
				.objectStore(HISTORY_STORE_NAME)
				.get(historyPageKey(ref, cursor, before)),
		);
		await transactionComplete(transaction);
		if (!record) return null;
		try {
			return Schema.decodeUnknownSync(HistoryPage)(record.page);
		} catch {
			return null;
		}
	}
	async saveHistoryPage(
		ref: SessionRef,
		cursor: SessionStreamCursor,
		before: number,
		page: HistoryPage,
	): Promise<void> {
		const database = await this.db();
		const encoded = Schema.encodeSync(HistoryPage)(page);
		const transaction = database.transaction(
			[HISTORY_STORE_NAME, METADATA_STORE_NAME],
			"readwrite",
		);
		const key = historyPageKey(ref, cursor, before);
		const bytes = JSON.stringify(encoded).length;
		transaction
			.objectStore(HISTORY_STORE_NAME)
			.put({ key, resource: environmentSessionCacheKey(ref), page: encoded });
		transaction.objectStore(METADATA_STORE_NAME).put({
			sessionId: `history:${key}`,
			historyKey: key,
			accessedAt: Date.now(),
			estimatedBytes: bytes,
		});
		await transactionComplete(transaction);
	}

	async remove(ref: SessionRef): Promise<void> {
		const storageKey = environmentSessionCacheKey(ref);
		const database = await this.db();
		const transaction = database.transaction(
			[STORE_NAME, METADATA_STORE_NAME, HISTORY_STORE_NAME],
			"readwrite",
		);
		cloudHeads.delete(storageKey);
		const pages = transaction.objectStore(HISTORY_STORE_NAME);
		const pageKeys = await requestResult(
			pages.index("resource").getAllKeys(storageKey),
		);
		for (const key of pageKeys) {
			pages.delete(key);
			transaction
				.objectStore(METADATA_STORE_NAME)
				.delete(`history:${String(key)}`);
		}
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
			[STORE_NAME, METADATA_STORE_NAME, HISTORY_STORE_NAME],
			"readwrite",
		);
		const store = transaction.objectStore(STORE_NAME);
		const metadataStore = transaction.objectStore(METADATA_STORE_NAME);
		const entries = (await requestResult(metadataStore.getAll())) as Array<{
			readonly sessionId: string;
			readonly historyKey?: string;
			readonly accessedAt: number;
			readonly estimatedBytes: number;
		}>;
		entries.sort((left, right) => right.accessedAt - left.accessedAt);
		let retainedBytes = 0;
		let headCount = 0;
		for (const entry of entries) {
			if (entry.historyKey === undefined) headCount++;
			retainedBytes += entry.estimatedBytes;
			if (
				(entry.historyKey === undefined && headCount > maxEntries) ||
				retainedBytes > maxBytes
			) {
				if (entry.historyKey !== undefined)
					transaction.objectStore(HISTORY_STORE_NAME).delete(entry.historyKey);
				else store.delete(entry.sessionId);
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

	async load(ref: SessionRef): Promise<TimelineReadingPosition | null> {
		const storageKey = environmentSessionCacheKey(ref);
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
		return decoded === null ? null : { ...decoded, sessionId: ref.sessionId };
	}

	async save(
		ref: SessionRef,
		position: TimelineReadingPosition,
	): Promise<void> {
		const storageKey = environmentSessionCacheKey(ref);
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

	async remove(ref: SessionRef): Promise<void> {
		const storageKey = environmentSessionCacheKey(ref);
		const database = await this.db();
		const transaction = database.transaction(
			READING_POSITION_STORE_NAME,
			"readwrite",
		);
		transaction.objectStore(READING_POSITION_STORE_NAME).delete(storageKey);
		await transactionComplete(transaction);
	}
}

export const sessionTimelineCache =
	typeof indexedDB === "undefined" ? null : new IndexedDbSessionTimelineCache();

export const timelineReadingPositionStore: TimelineReadingPositionStore | null =
	typeof indexedDB === "undefined"
		? null
		: new IndexedDbTimelineReadingPositionStore();

export const cloudChatCatalogPersistence =
	typeof indexedDB === "undefined"
		? null
		: {
				load: async (): Promise<unknown | null> => {
					const database = await openDatabase();
					const transaction = database.transaction(
						CLOUD_CATALOG_STORE_NAME,
						"readonly",
					);
					const value = await requestResult(
						transaction
							.objectStore(CLOUD_CATALOG_STORE_NAME)
							.get(CLOUD_CATALOG_KEY),
					);
					await transactionComplete(transaction);
					return value ?? null;
				},
				save: async (value: unknown): Promise<void> => {
					const database = await openDatabase();
					const transaction = database.transaction(
						CLOUD_CATALOG_STORE_NAME,
						"readwrite",
					);
					transaction
						.objectStore(CLOUD_CATALOG_STORE_NAME)
						.put(value, CLOUD_CATALOG_KEY);
					await transactionComplete(transaction);
				},
			};
