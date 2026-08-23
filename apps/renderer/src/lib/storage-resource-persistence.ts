import type {
	PersistedResource,
	ResourcePersistence,
} from "@zuse/client-runtime/client-persistence";
import {
	type ResourceKey,
	resourceKeyId,
} from "@zuse/client-runtime/resource-ref";

type StorageLike = Pick<Storage, "getItem" | "removeItem" | "setItem">;

type PersistenceOptions<Data> = Readonly<{
	storage: () => StorageLike | null;
	prefix: string;
	version: number;
	decode: (value: unknown) => Data;
}>;

type CacheEnvelope = Readonly<{
	version: number;
	resource: Readonly<{
		data: unknown;
		cursor: unknown;
		storedAt: unknown;
	}>;
}>;

const isCursor = (
	value: unknown,
): value is PersistedResource<unknown>["cursor"] => {
	if (value === null) return true;
	if (typeof value !== "object" || value === null) return false;
	const cursor = value as {
		readonly epoch?: unknown;
		readonly version?: unknown;
	};
	return (
		typeof cursor.epoch === "string" &&
		typeof cursor.version === "number" &&
		Number.isSafeInteger(cursor.version) &&
		cursor.version >= 0
	);
};

/**
 * Versioned renderer resource cache. Validation stays resource-owned through
 * `decode`, while this adapter owns the envelope, cursor, and corruption
 * cleanup consistently for every localStorage-backed resource.
 */
export const makeLocalStorageResourcePersistence = <Data>(
	options: PersistenceOptions<Data>,
): ResourcePersistence => {
	const storageKey = (key: ResourceKey<unknown>): string =>
		`${options.prefix}.v${options.version}:${resourceKeyId(key)}`;

	return {
		loadResource: async <Value>(key: ResourceKey<Value>) => {
			let storage: StorageLike | null;
			try {
				storage = options.storage();
			} catch {
				return null;
			}
			if (storage === null) return null;
			const cacheKey = storageKey(key);
			let raw: string | null;
			try {
				raw = storage.getItem(cacheKey);
			} catch {
				return null;
			}
			if (raw === null) return null;
			try {
				const envelope = JSON.parse(raw) as CacheEnvelope;
				if (
					envelope.version !== options.version ||
					typeof envelope.resource !== "object" ||
					envelope.resource === null ||
					typeof envelope.resource.storedAt !== "number" ||
					!Number.isFinite(envelope.resource.storedAt) ||
					!isCursor(envelope.resource.cursor)
				) {
					throw new Error("Invalid resource cache envelope");
				}
				return {
					data: options.decode(envelope.resource.data) as unknown as Value,
					cursor: envelope.resource.cursor,
					storedAt: envelope.resource.storedAt,
				};
			} catch {
				try {
					storage.removeItem(cacheKey);
				} catch {}
				return null;
			}
		},
		saveResource: async <Value>(
			key: ResourceKey<Value>,
			resource: PersistedResource<Value>,
		) => {
			try {
				options
					.storage()
					?.setItem(
						storageKey(key),
						JSON.stringify({ version: options.version, resource }),
					);
			} catch {
				// Cache persistence is best-effort and cannot block live settings.
			}
		},
		removeResource: async (key) => {
			try {
				options.storage()?.removeItem(storageKey(key));
			} catch {
				// Storage can be unavailable under opaque hosted origins.
			}
		},
	};
};
