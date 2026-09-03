import type {
	ClientCommand,
	CommandFingerprint,
	CommandOutbox,
	CommandReceipt,
	OutboxEntry,
} from "@zuse/client-runtime/client-persistence";
import {
	assertCommandFingerprint,
	commandFingerprint,
} from "@zuse/client-runtime/client-persistence";
import type { CommandId, EnvironmentId } from "@zuse/contracts";

const DATABASE_NAME = "zuse-client-runtime";
const DATABASE_VERSION = 3;
const OUTBOX_STORE = "command-outbox";
const RECEIPT_STORE = "command-receipts";
const MAX_RECEIPTS = 512;

const requestResult = <Value>(request: IDBRequest<Value>): Promise<Value> =>
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
		request.onupgradeneeded = (event) => {
			const database = request.result;
			if (!database.objectStoreNames.contains(OUTBOX_STORE)) {
				const store = database.createObjectStore(OUTBOX_STORE, {
					keyPath: "commandId",
				});
				store.createIndex("environmentId", "environmentId", {
					unique: false,
				});
				store.createIndex("createdAt", "createdAt", { unique: false });
				store.createIndex("acceptanceRevision", "acceptanceRevision", {
					unique: false,
				});
			}
			if (!database.objectStoreNames.contains(RECEIPT_STORE)) {
				const receipts = database.createObjectStore(RECEIPT_STORE, {
					keyPath: "commandId",
				});
				receipts.createIndex("receivedAt", "receivedAt", { unique: false });
			}
			if (event.oldVersion < 2) {
				// Legacy pending commands still contain their full identity, so preserve
				// them by deriving the new fingerprint in the upgrade transaction.
				// Legacy receipts contain only commandId/result and cannot be bound to a
				// payload safely; invalidate them so the stable command ID is replayed.
				const transaction = request.transaction;
				if (transaction !== null) {
					const outbox = transaction.objectStore(OUTBOX_STORE);
					const cursorRequest = outbox.openCursor();
					cursorRequest.onsuccess = () => {
						const cursor = cursorRequest.result;
						if (cursor === null) return;
						const upgraded = upgradePersistedOutboxEntry(cursor.value);
						if (upgraded === null) cursor.delete();
						else cursor.update(upgraded);
						cursor.continue();
					};
					transaction.objectStore(RECEIPT_STORE).clear();
				}
			}
			if (event.oldVersion >= 1 && event.oldVersion < 3) {
				const transaction = request.transaction;
				if (transaction !== null) {
					const outbox = transaction.objectStore(OUTBOX_STORE);
					if (!outbox.indexNames.contains("acceptanceRevision"))
						outbox.createIndex("acceptanceRevision", "acceptanceRevision", {
							unique: false,
						});
				}
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(
				request.error ?? new Error("Unable to open client command outbox"),
			);
	});

type PersistedOutboxEntry = OutboxEntry &
	Readonly<{
		commandId: CommandId;
		environmentId: EnvironmentId;
		createdAt: number;
		acceptanceRevision?: number;
		deliveryState?: string;
	}>;

export const upgradePersistedOutboxEntry = (
	value: unknown,
): PersistedOutboxEntry | null => {
	if (typeof value !== "object" || value === null) return null;
	const command = Reflect.get(value, "command") as ClientCommand | undefined;
	if (typeof command !== "object" || command === null) return null;
	const commandId = Reflect.get(value, "commandId");
	const environmentId = Reflect.get(value, "environmentId");
	const createdAt = Reflect.get(value, "createdAt");
	const attempts = Reflect.get(value, "attempts");
	const lastAttemptAt = Reflect.get(value, "lastAttemptAt");
	if (
		typeof commandId !== "string" ||
		typeof environmentId !== "string" ||
		typeof createdAt !== "number" ||
		typeof attempts !== "number" ||
		(lastAttemptAt !== null && typeof lastAttemptAt !== "number")
	) {
		return null;
	}
	try {
		return {
			command,
			commandId: commandId as CommandId,
			environmentId: environmentId as EnvironmentId,
			createdAt,
			attempts,
			lastAttemptAt,
			fingerprint:
				typeof Reflect.get(value, "fingerprint") === "string"
					? (Reflect.get(value, "fingerprint") as CommandFingerprint)
					: commandFingerprint(command),
		};
	} catch {
		return null;
	}
};

const persistableEntry = (entry: OutboxEntry): PersistedOutboxEntry => ({
	...entry,
	commandId: entry.command.commandId,
	environmentId: entry.command.environmentId,
	createdAt: entry.command.createdAt,
	...(entry.acceptance === undefined
		? {}
		: { acceptanceRevision: entry.acceptance.revision }),
	...(entry.deliveryStatus === undefined
		? {}
		: { deliveryState: entry.deliveryStatus.state }),
});

const runtimeEntry = (entry: PersistedOutboxEntry): OutboxEntry => ({
	command: entry.command,
	fingerprint: entry.fingerprint,
	...(entry.encryptedEnvelope === undefined
		? {}
		: { encryptedEnvelope: entry.encryptedEnvelope }),
	...(entry.acceptance === undefined ? {} : { acceptance: entry.acceptance }),
	...(entry.deliveryStatus === undefined
		? {}
		: { deliveryStatus: entry.deliveryStatus }),
	attempts: entry.attempts,
	lastAttemptAt: entry.lastAttemptAt,
});

export class IndexedDbCommandOutbox implements CommandOutbox {
	private database: Promise<IDBDatabase> | null = null;

	private db(): Promise<IDBDatabase> {
		this.database ??= openDatabase();
		return this.database;
	}

	async putOutbox(entry: OutboxEntry): Promise<void> {
		const database = await this.db();
		const transaction = database.transaction(OUTBOX_STORE, "readwrite");
		const store = transaction.objectStore(OUTBOX_STORE);
		const existing = (await requestResult(
			store.get(entry.command.commandId),
		)) as PersistedOutboxEntry | undefined;
		if (existing !== undefined) {
			assertCommandFingerprint(
				entry.command.commandId,
				existing.fingerprint,
				entry.fingerprint,
			);
		}
		store.put(persistableEntry(entry));
		await transactionComplete(transaction);
	}

	async removeOutbox(
		commandId: CommandId,
		fingerprint: CommandFingerprint,
	): Promise<void> {
		const database = await this.db();
		const transaction = database.transaction(OUTBOX_STORE, "readwrite");
		const store = transaction.objectStore(OUTBOX_STORE);
		const existing = (await requestResult(store.get(commandId))) as
			| PersistedOutboxEntry
			| undefined;
		if (existing !== undefined) {
			assertCommandFingerprint(commandId, existing.fingerprint, fingerprint);
			store.delete(commandId);
		}
		await transactionComplete(transaction);
	}

	async findReceipt(commandId: CommandId): Promise<CommandReceipt | null> {
		const database = await this.db();
		const transaction = database.transaction(RECEIPT_STORE, "readonly");
		const receipt = (await requestResult(
			transaction.objectStore(RECEIPT_STORE).get(commandId),
		)) as CommandReceipt | undefined;
		await transactionComplete(transaction);
		return typeof receipt?.fingerprint === "string" ? receipt : null;
	}

	async putReceipt(receipt: CommandReceipt): Promise<void> {
		const database = await this.db();
		const transaction = database.transaction(RECEIPT_STORE, "readwrite");
		await this.writeReceipt(transaction, receipt);
		await transactionComplete(transaction);
	}

	async completeOutbox(receipt: CommandReceipt): Promise<void> {
		const database = await this.db();
		const transaction = database.transaction(
			[OUTBOX_STORE, RECEIPT_STORE],
			"readwrite",
		);
		const outbox = transaction.objectStore(OUTBOX_STORE);
		const existing = (await requestResult(outbox.get(receipt.commandId))) as
			| PersistedOutboxEntry
			| undefined;
		if (existing !== undefined) {
			assertCommandFingerprint(
				receipt.commandId,
				existing.fingerprint,
				receipt.fingerprint,
			);
			outbox.delete(receipt.commandId);
		}
		await this.writeReceipt(transaction, receipt);
		await transactionComplete(transaction);
	}

	private async writeReceipt(
		transaction: IDBTransaction,
		receipt: CommandReceipt,
	): Promise<void> {
		const store = transaction.objectStore(RECEIPT_STORE);
		const existing = (await requestResult(store.get(receipt.commandId))) as
			| CommandReceipt
			| undefined;
		if (existing !== undefined) {
			assertCommandFingerprint(
				receipt.commandId,
				existing.fingerprint,
				receipt.fingerprint,
			);
		}
		store.put(receipt);
		const keys = (await requestResult(
			store.index("receivedAt").getAllKeys(),
		)) as IDBValidKey[];
		for (const key of keys.slice(0, Math.max(0, keys.length - MAX_RECEIPTS))) {
			store.delete(key);
		}
	}

	async listOutbox(
		environmentId?: EnvironmentId,
	): Promise<readonly OutboxEntry[]> {
		const database = await this.db();
		const transaction = database.transaction(OUTBOX_STORE, "readonly");
		const store = transaction.objectStore(OUTBOX_STORE);
		const request =
			environmentId === undefined
				? store.getAll()
				: store.index("environmentId").getAll(environmentId);
		const entries = (await requestResult(request)) as PersistedOutboxEntry[];
		await transactionComplete(transaction);
		return entries
			.flatMap((entry) => {
				if (typeof entry.fingerprint !== "string") return [];
				return [entry];
			})
			.sort(
				(left, right) =>
					left.createdAt - right.createdAt ||
					left.commandId.localeCompare(right.commandId),
			)
			.map(runtimeEntry);
	}
}

class MemoryCommandOutbox implements CommandOutbox {
	private readonly entries = new Map<CommandId, OutboxEntry>();
	private readonly receipts = new Map<CommandId, CommandReceipt>();

	async putOutbox(entry: OutboxEntry): Promise<void> {
		const existing = this.entries.get(entry.command.commandId);
		if (existing !== undefined) {
			assertCommandFingerprint(
				entry.command.commandId,
				existing.fingerprint,
				entry.fingerprint,
			);
		}
		this.entries.set(entry.command.commandId, entry);
	}

	async removeOutbox(
		commandId: CommandId,
		fingerprint: CommandFingerprint,
	): Promise<void> {
		const existing = this.entries.get(commandId);
		if (existing === undefined) return;
		assertCommandFingerprint(commandId, existing.fingerprint, fingerprint);
		this.entries.delete(commandId);
	}

	async findReceipt(commandId: CommandId): Promise<CommandReceipt | null> {
		return this.receipts.get(commandId) ?? null;
	}

	async putReceipt(receipt: CommandReceipt): Promise<void> {
		const existing = this.receipts.get(receipt.commandId);
		if (existing !== undefined) {
			assertCommandFingerprint(
				receipt.commandId,
				existing.fingerprint,
				receipt.fingerprint,
			);
		}
		this.receipts.set(receipt.commandId, receipt);
		while (this.receipts.size > MAX_RECEIPTS) {
			const oldest = this.receipts.keys().next().value;
			if (oldest === undefined) break;
			this.receipts.delete(oldest);
		}
	}

	async completeOutbox(receipt: CommandReceipt): Promise<void> {
		const pending = this.entries.get(receipt.commandId);
		if (pending !== undefined) {
			assertCommandFingerprint(
				receipt.commandId,
				pending.fingerprint,
				receipt.fingerprint,
			);
		}
		await this.putReceipt(receipt);
		this.entries.delete(receipt.commandId);
	}

	async listOutbox(
		environmentId?: EnvironmentId,
	): Promise<readonly OutboxEntry[]> {
		return [...this.entries.values()]
			.filter(
				(entry) =>
					environmentId === undefined ||
					entry.command.environmentId === environmentId,
			)
			.sort(
				(left, right) =>
					left.command.createdAt - right.command.createdAt ||
					left.command.commandId.localeCompare(right.command.commandId),
			);
	}
}

let memoryFallback: MemoryCommandOutbox | null = null;

export const createClientCommandOutbox = (): CommandOutbox => {
	if (typeof indexedDB !== "undefined") return new IndexedDbCommandOutbox();
	if (memoryFallback === null) memoryFallback = new MemoryCommandOutbox();
	return memoryFallback;
};

export const resetMemoryCommandOutboxForTest = (): void => {
	memoryFallback = new MemoryCommandOutbox();
};
