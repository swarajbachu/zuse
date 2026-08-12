import {
	CloudChatHistory,
	CloudChatSummary,
	FolderId,
	Message,
} from "@zuse/contracts";
import { Schema } from "effect";

const DATABASE_NAME = "zuse-cloud-chat-snapshots";
const DATABASE_VERSION = 1;
const STORE_NAME = "snapshots";
const SNAPSHOT_VERSION = 1 as const;

const CloudChatSnapshotSchema = Schema.Struct({
	schemaVersion: Schema.Literal(SNAPSHOT_VERSION),
	workspaceId: Schema.String,
	projectId: FolderId,
	summary: CloudChatSummary,
	history: CloudChatHistory,
	messages: Schema.Array(Message),
	updatedAt: Schema.Number,
});

export type CloudChatSnapshot = typeof CloudChatSnapshotSchema.Type;

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
	new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("Cloud chat snapshot request failed"));
	});

const transactionComplete = (transaction: IDBTransaction): Promise<void> =>
	new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () =>
			reject(
				transaction.error ??
					new Error("Cloud chat snapshot transaction aborted"),
			);
		transaction.onerror = () =>
			reject(
				transaction.error ??
					new Error("Cloud chat snapshot transaction failed"),
			);
	});

const openDatabase = (): Promise<IDBDatabase> =>
	new Promise((resolve, reject) => {
		const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
		request.onupgradeneeded = () => {
			const database = request.result;
			if (!database.objectStoreNames.contains(STORE_NAME))
				database.createObjectStore(STORE_NAME, { keyPath: "workspaceId" });
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("Unable to open cloud chat snapshots"));
	});

export interface CloudChatSnapshotStore {
	readonly list: () => Promise<ReadonlyArray<CloudChatSnapshot>>;
	readonly load: (workspaceId: string) => Promise<CloudChatSnapshot | null>;
	readonly save: (snapshot: CloudChatSnapshot) => Promise<void>;
	readonly remove: (workspaceId: string) => Promise<void>;
}

class IndexedDbCloudChatSnapshotStore implements CloudChatSnapshotStore {
	private database: Promise<IDBDatabase> | null = null;

	private db(): Promise<IDBDatabase> {
		this.database ??= openDatabase();
		return this.database;
	}

	private decode(raw: unknown): CloudChatSnapshot | null {
		const decoded = Schema.decodeUnknownOption(CloudChatSnapshotSchema)(raw);
		return decoded._tag === "Some" ? decoded.value : null;
	}

	async list(): Promise<ReadonlyArray<CloudChatSnapshot>> {
		const database = await this.db();
		const transaction = database.transaction(STORE_NAME, "readwrite");
		const store = transaction.objectStore(STORE_NAME);
		const values = await requestResult(store.getAll());
		const snapshots: CloudChatSnapshot[] = [];
		for (const value of values) {
			const decoded = this.decode(value);
			if (decoded === null) {
				if (
					typeof value === "object" &&
					value !== null &&
					"workspaceId" in value &&
					typeof value.workspaceId === "string"
				)
					store.delete(value.workspaceId);
				continue;
			}
			snapshots.push(decoded);
		}
		await transactionComplete(transaction);
		return snapshots;
	}

	async load(workspaceId: string): Promise<CloudChatSnapshot | null> {
		const database = await this.db();
		const transaction = database.transaction(STORE_NAME, "readwrite");
		const store = transaction.objectStore(STORE_NAME);
		const value = await requestResult(store.get(workspaceId));
		const decoded = this.decode(value);
		if (value !== undefined && decoded === null) store.delete(workspaceId);
		await transactionComplete(transaction);
		return decoded;
	}

	async save(snapshot: CloudChatSnapshot): Promise<void> {
		const database = await this.db();
		const transaction = database.transaction(STORE_NAME, "readwrite");
		transaction.objectStore(STORE_NAME).put(
			Schema.encodeSync(CloudChatSnapshotSchema)({
				...snapshot,
				schemaVersion: SNAPSHOT_VERSION,
			}),
		);
		await transactionComplete(transaction);
	}

	async remove(workspaceId: string): Promise<void> {
		const database = await this.db();
		const transaction = database.transaction(STORE_NAME, "readwrite");
		transaction.objectStore(STORE_NAME).delete(workspaceId);
		await transactionComplete(transaction);
	}
}

export const cloudChatSnapshotStore: CloudChatSnapshotStore | null =
	typeof indexedDB === "undefined"
		? null
		: new IndexedDbCloudChatSnapshotStore();

export const makeCloudChatSnapshot = (input: {
	readonly projectId: FolderId;
	readonly summary: CloudChatSummary;
	readonly history: CloudChatHistory;
	readonly messages: ReadonlyArray<Message>;
}): CloudChatSnapshot => ({
	schemaVersion: SNAPSHOT_VERSION,
	workspaceId: input.summary.workspaceId,
	projectId: input.projectId,
	summary: input.summary,
	history: input.history,
	messages: input.messages,
	updatedAt: Date.now(),
});
